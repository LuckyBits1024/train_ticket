"""输入校验与规范化。

``normalize_fields`` 保持旧版 18 个字段的校验规则不变，同时接受八款新模板需要
的扩展字段（附加信息、取票机号、二维码、字号缩放等）。扩展字段都有安全的默认值，
旧调用只传 18 个字段也能得到与参考图一致的票面。
"""

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation

from .fonts import FontBook  # re-export 兼容（历史代码从 ticket_image 导入）

DISCLAIMER = "纪念车票 · 不作乘车凭证"
DEFAULT_QR = "https://www.12306.cn/"
DEFAULT_INFO1 = "2"
DEFAULT_INFO2 = "仅供纪念使用"
DEFAULT_INFO3 = "0"
INFO1_LABELS = ("", "退票费", "限乘当日当次车")
INFO3_TEXT = {
    "0": ("报销凭证 遗失不补", "退票改签时须交回车站"),
    "1": ("买票请到12306 发货请到95306", "中国铁路祝您旅途愉快"),
    "2": ("欢度国庆 祝福祖国", "中国铁路祝您旅途愉快"),
    "9": ("奋斗百年路 启航新征程", "热烈庆祝中国共产党成立100周年"),
}

FIELDS = (
    "from_station", "to_station", "from_pinyin", "to_pinyin", "train", "date",
    "time", "coach", "seat", "seat_type", "price", "passenger_name", "id_number",
    "gate", "ticket_number", "serial_number", "issuing_station", "channel",
)

# 新模板的扩展字段；不放进 FIELDS，避免改变旧 API 的字段列表。
EXTRA_FIELDS = (
    "info1", "info2", "info3", "machine_id", "qrcode", "qr_enabled",
    "font_scale", "font_weight", "seat_position", "flags",
)

ALL_FIELDS = FIELDS + EXTRA_FIELDS

ALIASES = dict(zip(
    ("出发站", "到达站", "出发站拼音", "到达站拼音", "车次", "日期", "时间",
     "车厢", "座位", "席别", "票价", "姓名", "证件号", "检票口", "票号",
     "流水号", "出票车站", "购票渠道"), FIELDS))
ALIASES.update({
    # 数据模型里的 camelCase 名称，方便与 Web/JSON 对齐。
    "fromStation": "from_station",
    "toStation": "to_station",
    "fromPinyin": "from_pinyin",
    "toPinyin": "to_pinyin",
    "trainNo": "train",
    "seatClass": "seat_type",
    "carriageNo": "coach",
    "seatNo": "seat",
    "passengerName": "passenger_name",
    "identity": "id_number",
    "checkinRoom": "gate",
    "ticketNo": "ticket_number",
    "serialNo": "serial_number",
    "issuingStation": "issuing_station",
    "info1": "info1",
    "info2": "info2",
    "info3": "info3",
    "machineId": "machine_id",
    "qrcodeString": "qrcode",
    "qrEnabled": "qr_enabled",
    "fontScale": "font_scale",
    "fontWeight": "font_weight",
    "seatPosition": "seat_position",
    # 中文扩展字段。
    "附加信息1": "info1",
    "附加信息2": "info2",
    "附加信息3": "info3",
    "取票机号": "machine_id",
    "二维码": "qrcode",
    "二维码内容": "qrcode",
    "铺位": "seat_position",
    "座位位置": "seat_position",
})

REQUIRED = ("from_station", "to_station", "train", "date")
LIMITS = {"from_station": 30, "to_station": 30, "from_pinyin": 80,
          "to_pinyin": 80, "passenger_name": 40, "id_number": 40,
          "gate": 20, "ticket_number": 24, "serial_number": 32,
          "issuing_station": 30, "channel": 3, "seat_type": 12}
EXTRA_LIMITS = {
    "info1": 1, "info2": 40, "info3": 1, "machine_id": 40,
    "qrcode": 512, "seat_position": 4,
}
_FIELD_PRICE = re.compile(r"^[0-9]+(?:\.[0-9]{1,2})?$")
_TIME_RE = re.compile(r"^[0-9]{2}:[0-9]{2}$")
_DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _text(value, name, limit):
    if value is None:
        return ""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("{} 必须是文字或数字".format(name))
    text = str(value).strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise ValueError("{} 不能包含换行或控制字符".format(name))
    if len(text) > limit:
        raise ValueError("{} 超过允许长度 {}".format(name, limit))
    return text


def _bool(value, name):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on", "是"):
        return True
    if text in ("0", "false", "no", "off", "否", ""):
        return False
    raise ValueError("{} 必须是布尔值".format(name))


def _info_code(value, name, default):
    if value is None or value == "":
        return default
    text = str(value).strip()
    if text not in ("0", "1", "2", "9"):
        raise ValueError("{} 只能是 0/1/2/9".format(name))
    return text


def normalize_fields(raw, mask_id=True):
    """Validate user input without inventing optional ticket information."""
    if not isinstance(raw, dict):
        raise ValueError("输入 JSON 必须是一个对象，不能是数组或单个值")
    data = {}
    for key, value in raw.items():
        name = ALIASES.get(key, key)
        if name not in ALL_FIELDS:
            raise ValueError("未知字段：{}；可用字段：{}".format(key, ", ".join(FIELDS)))
        if name in data:
            raise ValueError("字段重复：{}（中英文名称只能使用一个）".format(name))
        if name == "flags":
            if value is None:
                data[name] = {}
            elif not isinstance(value, dict):
                raise ValueError("flags 必须是一个对象")
            else:
                data[name] = {key2: _bool(value[key2], "flags." + key2)
                              for key2 in ("child", "student", "online", "discount")
                              if key2 in value}
        elif name == "qr_enabled":
            data[name] = _bool(value, name)
        elif name == "font_scale":
            try:
                scale = float(value)
            except (TypeError, ValueError):
                raise ValueError("font_scale 必须是 0.8～1.3 之间的数字") from None
            if not 0.8 <= scale <= 1.3:
                raise ValueError("font_scale 必须在 0.8～1.3 之间")
            data[name] = scale
        elif name == "font_weight":
            try:
                weight = int(value)
            except (TypeError, ValueError):
                raise ValueError("font_weight 必须是 400/500/600/700/800") from None
            if weight not in (400, 500, 600, 700, 800):
                raise ValueError("font_weight 必须是 400/500/600/700/800")
            data[name] = weight
        elif name == "info1":
            data[name] = _info_code(value, name, DEFAULT_INFO1)
        elif name == "info3":
            data[name] = _info_code(value, name, DEFAULT_INFO3)
        else:
            data[name] = _text(value, name, EXTRA_LIMITS.get(name, LIMITS.get(name, 30)))
    for key in FIELDS:
        data.setdefault(key, "")
    data.setdefault("info1", DEFAULT_INFO1)
    data.setdefault("info2", DEFAULT_INFO2)
    data.setdefault("info3", DEFAULT_INFO3)
    data.setdefault("machine_id", "")
    data.setdefault("qrcode", "")
    data.setdefault("qr_enabled", True)
    data.setdefault("font_scale", 1.0)
    data.setdefault("font_weight", 500)
    data.setdefault("seat_position", "")
    data.setdefault("flags", {})

    missing = [key for key in REQUIRED if not data[key]]
    if missing:
        raise ValueError("缺少必填字段：" + ", ".join(missing))
    for key in ("from_station", "to_station"):
        # The renderer adds exactly one smaller station suffix.
        if data[key].endswith("站"):
            data[key] = data[key][:-1]
        if not data[key]:
            raise ValueError("{} 需要实际站名".format(key))
    if not _DATE_RE.fullmatch(data["date"]):
        raise ValueError("日期格式应为 YYYY-MM-DD，例如 2026-10-19")
    try:
        datetime.strptime(data["date"], "%Y-%m-%d")
    except ValueError:
        raise ValueError("日期不存在：" + data["date"]) from None
    if data["time"]:
        if not _TIME_RE.fullmatch(data["time"]):
            raise ValueError("时间格式应为 HH:MM，例如 10:35；12306 积分明细没有发车时间时可以留空")
        try:
            datetime.strptime(data["time"], "%H:%M")
        except ValueError:
            raise ValueError("时间不存在：" + data["time"]) from None
    data["train"] = data["train"].upper()
    if not re.fullmatch(r"[A-Z]{0,2}[0-9]{1,5}", data["train"]):
        raise ValueError("车次应类似 G123、C2021、K42 或 1234")
    if data["coach"]:
        coach = data["coach"].removesuffix("车")
        if not re.fullmatch(r"[0-9]{1,2}", coach) or not 1 <= int(coach) <= 99:
            raise ValueError("车厢应为 1～99，例如 03")
        data["coach"] = coach.zfill(2)
    if data["seat"]:
        seat = data["seat"].upper().removesuffix("号")
        if seat != "无座" and not re.fullmatch(r"[0-9]{1,3}[A-F]?", seat):
            raise ValueError("座位应类似 02A、086 或 无座")
        data["seat"] = seat
    if data["price"]:
        try:
            price = Decimal(data["price"])
            if not price.is_finite() or not Decimal("0") <= price <= Decimal("999999.99"):
                raise InvalidOperation
            if price != price.quantize(Decimal("0.01")):
                raise InvalidOperation
        except InvalidOperation:
            raise ValueError("票价需为非负金额，最多两位小数") from None
        value = format(price, ".2f").rstrip("0")
        data["price"] = value + "0" if value.endswith(".") else value
    if mask_id and data["id_number"] and "*" not in data["id_number"]:
        value = data["id_number"]
        data["id_number"] = (value[:6] + "*" * (len(value) - 10) + value[-4:]
                             if len(value) > 10 else "*" * len(value))
    return data


# ---------------------------------------------------------------------------
# 背面参数


DEFAULT_BACK_TITLE = "报销凭证使用须知"
DEFAULT_BACK_TERMS = "\n".join((
    "☆购票后如需报销凭证的，应在开车前或乘车日期之日起180日以内(含当日),"
    "持购票时所使用的有效身份证件原件到车站售票窗口、自动售票机领取。",
    "☆退票后如需退票费报销凭证，应在办理之日起180天以内(含当日),"
    "持购票时所使用的有效身份证件原件到车站退票窗口领取。",
    "☆报销凭证开具后请妥善保管，丢失后将无法办理补办申领手续。",
    "☆已领取报销凭证的车票办理改签、退票或退款手续时，须交回报销凭证方可办理。",
    "☆报销凭证不能作为乘车凭证使用。",
    "☆未尽事宜见《国铁集团铁路旅客运输规程》等有关规定和车站公告。"
    "跨境旅客事宜见铁路跨境旅客相关运输组织规则和车站公告。",
))


def is_hex_color(value) -> bool:
    return bool(_HEX_RE.fullmatch(str(value or "")))


def _multiline(value, name, limit):
    text = str(value or "").strip()
    if len(text) > limit:
        raise ValueError("{} 超过允许长度 {}".format(name, limit))
    for char in text:
        if ord(char) < 32 and char not in "\n\r\t":
            raise ValueError("{} 不能包含控制字符".format(name))
    return text


def normalize_back_style(raw=None):
    """把 CLI/JSON 的背面参数规范成渲染器使用的字典。"""
    raw = dict(raw or {})
    mask = raw.get("mask") if isinstance(raw.get("mask"), dict) else {}
    background = raw.get("background") or ""
    solid_color = str(raw.get("solidColor") or raw.get("solid_color") or "#d9d9d9")
    if not is_hex_color(solid_color):
        raise ValueError("背面纯色必须是 #rgb 或 #rrggbb")
    title = _text(raw.get("title", DEFAULT_BACK_TITLE), "背面标题", 80) or DEFAULT_BACK_TITLE
    terms = raw.get("terms")
    terms = DEFAULT_BACK_TERMS if terms is None else _multiline(terms, "背面条款", 4000)
    title_size = _number(raw.get("titleSize", raw.get("title_size", 40)), "背面标题字号", 10, 80)
    terms_size = _number(raw.get("termsSize", raw.get("terms_size", 21)), "背面条款字号", 10, 80)
    title_weight = _weight(raw.get("titleWeight", raw.get("title_weight", 700)), "背面标题字重")
    terms_weight = _weight(raw.get("termsWeight", raw.get("terms_weight", 500)), "背面条款字重")
    title_color = str(raw.get("titleColor", raw.get("title_color", "#333333")))
    terms_color = str(raw.get("termsColor", raw.get("terms_color", "#3c3c3c")))
    for value, label in ((title_color, "背面标题颜色"), (terms_color, "背面条款颜色")):
        if not is_hex_color(value):
            raise ValueError(label + "必须是 #rgb 或 #rrggbb")
    mask_color = str(mask.get("color", raw.get("mask_color", "black")) or "black")
    if mask_color not in ("black", "white"):
        raise ValueError("背面遮罩颜色只能是 black 或 white")
    mask_alpha = _number(mask.get("alpha", raw.get("mask_alpha", 0.0)), "背面遮罩透明度", 0, 1)
    mask_enabled = mask.get("enabled")
    if mask_enabled is None:
        mask_enabled = bool(mask_alpha)
    return {
        "background": background,
        "solidColor": solid_color,
        "customImage": str(raw.get("customImage") or raw.get("custom_image") or ""),
        "mask": {
            "enabled": _bool(mask_enabled, "背面遮罩开关"),
            "color": mask_color,
            "alpha": mask_alpha,
        },
        "title": title,
        "titleSize": title_size,
        "titleWeight": title_weight,
        "titleColor": title_color,
        "terms": terms,
        "termsSize": terms_size,
        "termsWeight": terms_weight,
        "termsColor": terms_color,
        "splitExport": _bool(raw.get("splitExport", False), "背面分开导出"),
    }


def _number(value, label, low, high):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("{}必须是数字".format(label)) from None
    if not low <= number <= high:
        raise ValueError("{}必须在 {}～{} 之间".format(label, low, high))
    return int(number) if number.is_integer() else number


def _weight(value, label):
    try:
        weight = int(value)
    except (TypeError, ValueError):
        raise ValueError("{}必须是 400/500/600/700/800".format(label)) from None
    if weight not in (400, 500, 600, 700, 800):
        raise ValueError("{}必须是 400/500/600/700/800".format(label))
    return weight


__all__ = [
    "ALL_FIELDS", "ALIASES", "DEFAULT_BACK_TERMS", "DEFAULT_BACK_TITLE",
    "DEFAULT_INFO1", "DEFAULT_INFO2", "DEFAULT_INFO3", "DEFAULT_QR",
    "DISCLAIMER", "EXTRA_FIELDS", "EXTRA_LIMITS", "FIELDS", "INFO1_LABELS",
    "INFO3_TEXT", "LIMITS", "FontBook", "is_hex_color", "normalize_back_style",
    "normalize_fields",
]
