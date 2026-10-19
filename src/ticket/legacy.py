"""Legacy pink-ticket renderer, kept so CLI `--style pink` does not regress."""

import math
import os
import re
import tempfile
from datetime import datetime
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "ticket-template"
DISCLAIMER = "纪念车票 · 不作乘车凭证"
FIELDS = (
    "from_station", "to_station", "from_pinyin", "to_pinyin", "train", "date",
    "time", "coach", "seat", "seat_type", "price", "passenger_name", "id_number",
    "gate", "ticket_number", "serial_number", "issuing_station", "channel",
)
ALIASES = dict(zip(
    ("出发站", "到达站", "出发站拼音", "到达站拼音", "车次", "日期", "时间",
     "车厢", "座位", "席别", "票价", "姓名", "证件号", "检票口", "票号",
     "流水号", "出票车站", "购票渠道"), FIELDS))
REQUIRED = ("from_station", "to_station", "train", "date")
LIMITS = {"from_station": 30, "to_station": 30, "from_pinyin": 80,
          "to_pinyin": 80, "passenger_name": 40, "id_number": 40,
          "gate": 20, "ticket_number": 24, "serial_number": 32,
          "issuing_station": 30, "channel": 3, "seat_type": 12}


def normalize_fields(raw, mask_id=True):
    """Validate user input without inventing optional ticket information."""
    if not isinstance(raw, dict):
        raise ValueError("输入 JSON 必须是一个对象，不能是数组或单个值")
    data = {}
    for key, value in raw.items():
        name = ALIASES.get(key, key)
        if name not in FIELDS:
            raise ValueError("未知字段：{}；可用字段：{}".format(key, ", ".join(FIELDS)))
        if name in data:
            raise ValueError("字段重复：{}（中英文名称只能使用一个）".format(name))
        if value is None:
            value = ""
        elif isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise ValueError("{} 必须是文字或数字".format(name))
        value = str(value).strip()
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("{} 不能包含换行或控制字符".format(name))
        if len(value) > LIMITS.get(name, 30):
            raise ValueError("{} 超过允许长度 {}".format(name, LIMITS.get(name, 30)))
        data[name] = value
    for key in FIELDS:
        data.setdefault(key, "")
    missing = [key for key in REQUIRED if not data[key]]
    if missing:
        raise ValueError("缺少必填字段：" + ", ".join(missing))
    for key in ("from_station", "to_station"):
        # The renderer adds exactly one smaller station suffix.
        if data[key].endswith("站"):
            data[key] = data[key][:-1]
        if not data[key]:
            raise ValueError("{} 需要实际站名".format(key))
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", data["date"]):
        raise ValueError("日期格式应为 YYYY-MM-DD，例如 2026-10-19")
    try:
        datetime.strptime(data["date"], "%Y-%m-%d")
    except ValueError:
        raise ValueError("日期不存在：" + data["date"]) from None
    if data["time"]:
        if not re.fullmatch(r"[0-9]{2}:[0-9]{2}", data["time"]):
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


# OS font paths are resolved at runtime; proprietary font files are not bundled.
FONT_CANDIDATES = {
    "hei": [
        ("/System/Library/Fonts/STHeiti Medium.ttc", 1),
        ("C:/Windows/Fonts/simhei.ttf", 0),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2),
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
    ],
    "song": [
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 6),
        ("C:/Windows/Fonts/simsun.ttc", 0),
        ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", 2),
    ],
    "latin": [
        ("/System/Library/Fonts/Supplemental/Times New Roman.ttf", 0),
        ("C:/Windows/Fonts/times.ttf", 0),
        ("/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf", 0),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", 0),
    ],
    "number": [
        ("/System/Library/Fonts/Supplemental/Arial Narrow.ttf", 0),
        ("C:/Windows/Fonts/arialn.ttf", 0),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf", 0),
        ("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf", 0),
    ],
}


class FontBook:
    def __init__(self, overrides=None):
        self.paths = {}
        for role, candidates in FONT_CANDIDATES.items():
            override = (overrides or {}).get(role)
            if override:
                path, separator, index = str(override).rpartition("#")
                candidates = [(path, int(index))] if separator and index.isdigit() else [(str(override), 0)]
            for path, index in candidates:
                if Path(path).is_file():
                    try:
                        ImageFont.truetype(path, 16, index=index)
                    except OSError:
                        continue
                    self.paths[role] = (path, index)
                    break
            if role not in self.paths:
                raise ValueError("找不到 {} 字体，请用 --font-{} '/路径/字体.ttf' 指定；"
                                 "字体集合可写成 '/路径/字体.ttc#索引'".format(role, role))

    @lru_cache(maxsize=256)
    def get(self, role, size):
        path, index = self.paths[role]
        return ImageFont.truetype(path, size, index=index)


def run(text, family="song", size=42, tracking=0):
    return (str(text), family, size, tracking)


class TicketCanvas:
    """Place groups of font runs in bounding boxes with shared baselines."""
    def __init__(self, style, width, fonts):
        self.fonts = fonts
        self.scale = max(width, 2140) / 1070
        with Image.open(ASSETS / (style + ".png")) as source:
            self.image = source.convert("RGB").resize(
                (round(source.width * self.scale), round(source.height * self.scale)),
                Image.Resampling.LANCZOS)
        self.output_width = width

    def text(self, runs, box, align="left", color="#141413"):
        runs = [r for r in runs if r[0]]
        if not runs:
            return
        s = self.scale
        items = [(text, self.fonts.get(family, max(1, round(size * s))), tracking * s)
                 for text, family, size, tracking in runs]
        ascent = max(font.getmetrics()[0] for _, font, _ in items)
        descent = max(font.getmetrics()[1] for _, font, _ in items)
        width = sum(sum(font.getlength(c) for c in text) + max(0, len(text) - 1) * tracking
                    for text, font, tracking in items)
        padding = math.ceil(8 * s)
        layer = Image.new("RGBA", (math.ceil(width) + padding * 2,
                                   ascent + descent + padding * 2))
        draw = ImageDraw.Draw(layer)
        cursor = padding
        for text, font, tracking in items:
            for index, char in enumerate(text):
                draw.text((cursor, padding + ascent), char, font=font, fill=color, anchor="ls")
                cursor += font.getlength(char)
                if index < len(text) - 1:
                    cursor += tracking
        bounds = layer.getbbox()
        if not bounds:
            return
        layer = layer.crop(bounds)
        x, y, w, h = [v * s for v in box]
        ratio = min(w / layer.width, h / layer.height, 1)
        if ratio < 1:
            layer = layer.resize((max(1, round(layer.width * ratio)),
                                  max(1, round(layer.height * ratio))), Image.Resampling.LANCZOS)
        if align == "center":
            x += (w - layer.width) / 2
        elif align == "right":
            x += w - layer.width
        y += (h - layer.height) / 2
        self.image.paste(layer, (round(x), round(y)), layer)

    def arrow(self, y):
        s = self.scale
        draw = ImageDraw.Draw(self.image)
        points = [(450 * s, y * s), (633 * s, y * s)]
        draw.line(points, fill="#262625", width=max(1, round(1.6 * s)))
        draw.line([(622 * s, (y - 5) * s), points[1], (622 * s, (y + 1) * s)],
                  fill="#262625", width=max(1, round(1.4 * s)))

    def finish(self):
        if self.image.width != self.output_width:
            return self.image.resize((self.output_width,
                                      round(self.image.height * self.output_width / self.image.width)),
                                     Image.Resampling.LANCZOS)
        return self.image


def render_ticket(data, style="blue", width=1800, fonts=None):
    """Return a Pillow image. `data` must be returned by normalize_fields."""
    if style not in ("blue", "pink"):
        raise ValueError("款式必须为 blue 或 pink")
    if not isinstance(width, int) or not 600 <= width <= 6000:
        raise ValueError("图片宽度必须在 600～6000 像素之间")
    canvas = TicketCanvas(style, width, fonts or FontBook())
    text = canvas.text
    offset = 5 if style == "pink" else 0
    def upper(box):
        x, y, w, h = box
        return (x, y + offset, w, h)
    text([run(data["ticket_number"], "number", 57, 2)], upper((78, 33, 400, 60)), color="#e95573")
    if data["gate"]:
        text([run("检票口", size=45), run(data["gate"], "number", 53)],
             upper((742, 35, 258, 58)), "right")
    for prefix, x in (("from", 78), ("to", 705)):
        text([run(data[prefix + "_station"], "hei", 78, 5), run("站", "hei", 46)],
             upper((x, 107, 322, 87)), "center")
        text([run(data[prefix + "_pinyin"], "latin", 39, 2.1)],
             upper((x, 191, 322, 43)), "center")
    text([run(data["train"], "latin", 64)], upper((432, 125, 205, 69)), "center")
    canvas.arrow(205 + offset)
    year, month, day = data["date"].split("-")
    date_runs = [run(year, "number", 58), run("年 ", size=33), run(month, "number", 58),
                 run("月 ", size=33), run(day, "number", 58), run("日  ", size=33)]
    if data["time"]:
        date_runs += [run(data["time"], "number", 58), run("开", size=33)]
    text(date_runs, upper((75, 250, 565, 59)))
    seat_runs = []
    if data["coach"]:
        seat_runs += [run(data["coach"], "number", 56), run("车 ", size=33)]
    if data["seat"]:
        seat_runs += ([run("无座", size=44)] if data["seat"] == "无座" else
                      [run(data["seat"], "number", 56), run("号", size=33)])
    text(seat_runs, upper((712, 251, 294, 58)))
    if data["price"]:
        text([run("¥", "latin", 42), run(data["price"], "number", 62), run("元", size=34)],
             upper((78, 309, 330, 59)))
    text([run(data["channel"], size=45)], upper((502, 313, 64, 53)), "center")
    text([run(data["seat_type"], size=46)], upper((713, 309, 292, 56)), "center")
    text([run("限乘当日当次车", size=45)], upper((77, 369, 500, 56)))
    passenger_y, message_y, footer_y = (479, 556, 667) if style == "blue" else (443, 516, 624)
    passenger_runs = []
    if data["id_number"]:
        passenger_runs += [run(data["id_number"], "number", 48), run("  ", size=40)]
    passenger_runs += [run(data["passenger_name"], size=47)]
    text(passenger_runs, (78, passenger_y, 685, 61))
    text([run("买票请到", size=32), run("12306", "number", 37),
          run("  发货请到", size=32), run("95306", "number", 37)],
         (169, message_y, 565, 36), "center")
    text([run("中国铁路祝您旅途愉快", size=33)],
         (169, message_y + 41, 565, 36), "center")
    text([run(data["serial_number"], "number", 40)], (77, footer_y, 348, 45))
    issuing = data["issuing_station"]
    if issuing and not issuing.endswith("售"):
        issuing += "售" if issuing.endswith("站") else "站售"
    text([run(issuing, size=37)], (447, footer_y, 260, 45), "center")
    text([run(DISCLAIMER, size=24)], (727, footer_y + 7, 286, 35), "center")
    return canvas.finish()


def save_ticket(image, destination):
    """Replace output only after a complete PNG is written."""
    destination = Path(destination).expanduser().resolve()
    if destination.suffix.lower() != ".png":
        raise ValueError("输出文件必须使用 .png 扩展名")
    if ASSETS == destination or ASSETS in destination.parents:
        raise ValueError("输出路径不能覆盖模板素材")
    destination.parent.mkdir(parents=True, exist_ok=True)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Description", DISCLAIMER)
    metadata.add_text("Template", "Rail Memory v2")
    name = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".png", delete=False) as handle:
            name = handle.name
        image.save(name, "PNG", pnginfo=metadata)
        os.replace(name, destination)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)
    return destination
