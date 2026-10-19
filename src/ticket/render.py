"""八款 Rail Memory v2 票面的 Pillow 渲染器。

坐标与 assets/ticket-template/v2/manifest.json 对齐；输出时统一按 output_width
放大，所以文字和底图都按同一倍率缩放。默认使用系统无衬线字体，和 Web 参考图一致。
"""

from __future__ import annotations

import os
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

from .fonts import FontBook, warn_missing_qrcode
from .layout import (
    carriage_runs,
    date_runs,
    fit_font_size,
    format_price,
    price_is_visible,
    pinyin_x,
    sanitize_train_no,
    station_display,
    station_geometry,
    wrap_name_lines,
)
from .templates import Template, get_template, layout
from .validate import (
    DEFAULT_INFO2,
    DEFAULT_INFO3,
    DEFAULT_QR,
    DISCLAIMER,
    INFO1_LABELS,
    INFO3_TEXT,
    normalize_back_style,
)

try:  # 可选依赖：没有 qrcode 时票面留空，不阻塞导出
    import qrcode  # type: ignore
except Exception:  # pragma: no cover - 取决于用户环境
    qrcode = None

_BLACK = (31, 31, 31)
_RED = (255, 0, 0)
_DISCLAIMER_COLOR = (74, 74, 74)
_QR_CACHE: Dict[Tuple[str, int], Image.Image] = {}
_QR_WARNED = False


# ---------------------------------------------------------------------------
# 基础工具


def _hex_color(value, fallback="#333333") -> Tuple[int, int, int]:
    text = str(value or fallback).strip().lstrip("#")
    if len(text) == 3:
        text = "".join(char * 2 for char in text)
    if len(text) != 6:
        text = fallback.lstrip("#")
    try:
        return tuple(int(text[index:index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return (51, 51, 51)


def _font_scale(data: Dict) -> float:
    try:
        value = float(data.get("font_scale", 1.0))
    except (TypeError, ValueError):
        value = 1.0
    return min(1.3, max(0.8, value))


def _font_weight(data: Dict) -> int:
    try:
        value = int(data.get("font_weight", 500))
    except (TypeError, ValueError):
        value = 500
    return value if value in (400, 500, 600, 700, 800) else 500


def _role_for_text(text: str) -> str:
    if any("\u4e00" <= char <= "\u9fff" for char in text):
        return "zh"
    return "num_sans"


def _measure(fonts: FontBook, text: str, role: str, size: int, weight: int) -> float:
    if not text:
        return 0.0
    return float(fonts.measure(str(text), role, max(1, int(size)), weight))


def _draw_text(draw: ImageDraw.ImageDraw, fonts: FontBook, text: str, x: float, y: float,
               role: str, size: int, weight: int, fill=_BLACK, anchor="lm") -> None:
    value = str(text or "")
    if not value:
        return
    font = fonts.get(role, max(1, int(size)), weight)
    draw.text((float(x), float(y)), value, font=font, fill=fill, anchor=anchor)


def _draw_spaced(draw: ImageDraw.ImageDraw, fonts: FontBook, text: str, x: float, y: float,
                 role: str, size: int, weight: int, spacing: float, fill=_BLACK) -> float:
    value = str(text or "")
    if not value:
        return 0.0
    if spacing <= 0:
        _draw_text(draw, fonts, value, x, y, role, size, weight, fill)
        return _measure(fonts, value, role, size, weight)
    cursor = float(x)
    font = fonts.get(role, max(1, int(size)), weight)
    for char in value:
        draw.text((cursor, float(y)), char, font=font, fill=fill, anchor="lm")
        cursor += float(font.getlength(char)) + spacing
    return cursor - float(x) - spacing


def _draw_spread(draw: ImageDraw.ImageDraw, fonts: FontBook, text: str, x: float, y: float,
                 role: str, size: int, weight: int, target: float, fill=_BLACK) -> None:
    value = str(text or "")
    if not value:
        return
    natural = _measure(fonts, value, role, size, weight)
    if len(value) <= 1 or natural >= target:
        _draw_text(draw, fonts, value, x, y, role, size, weight, fill)
        return
    gap = (target - natural) / (len(value) - 1)
    cursor = float(x)
    font = fonts.get(role, max(1, int(size)), weight)
    for char in value:
        draw.text((cursor, float(y)), char, font=font, fill=fill, anchor="lm")
        cursor += float(font.getlength(char)) + gap


def _draw_runs(draw: ImageDraw.ImageDraw, fonts: FontBook, runs: Sequence[Dict], x: float,
               y: float, scale: float, weight: int, font_scale: float, fill=_BLACK,
               segment_gap: float = 0.0) -> float:
    cursor = float(x)
    for run in runs:
        gap = float(run.get("gap") or 0) * scale
        if gap:
            cursor += gap
        text = str(run.get("text") or "")
        if not text:
            continue
        role = str(run.get("role") or _role_for_text(text))
        role = {"num": "num_sans", "latin": "latin_sans"}.get(role, role)
        size = max(1, int(round(float(run.get("size") or 24) * scale * font_scale)))
        _draw_text(draw, fonts, text, cursor, y, role, size, weight, fill)
        cursor += _measure(fonts, text, role, size, weight) + segment_gap
    return cursor - float(x)


def _dashed_rect(draw: ImageDraw.ImageDraw, box: Tuple[float, float, float, float],
                 dash: float, gap: float, width: int, fill=_BLACK) -> None:
    left, top, right, bottom = box
    def line(x1, y1, x2, y2):
        draw.line([(x1, y1), (x2, y2)], fill=fill, width=max(1, int(width)))
    # 上/下
    x = left
    while x < right:
        line(x, top, min(x + dash, right), top)
        x += dash + gap
    x = left
    while x < right:
        line(x, bottom, min(x + dash, right), bottom)
        x += dash + gap
    # 左/右
    y = top
    while y < bottom:
        line(left, y, left, min(y + dash, bottom))
        y += dash + gap
    y = top
    while y < bottom:
        line(right, y, right, min(y + dash, bottom))
        y += dash + gap


def _open_image(path: Path) -> Image.Image:
    with Image.open(path) as source:
        image = source.convert("RGBA")
        # PNG 底图的透明边缘要合成到白纸，不能直接 convert("RGB")（会变黑边/黑点）。
        canvas = Image.new("RGB", image.size, (255, 255, 255))
        canvas.paste(image, (0, 0), image.getchannel("A"))
        return canvas


def _cover(image: Image.Image, width: int, height: int) -> Image.Image:
    ratio = max(width / image.width, height / image.height)
    draw_w = max(1, round(image.width * ratio))
    draw_h = max(1, round(image.height * ratio))
    resized = image.resize((draw_w, draw_h), Image.Resampling.LANCZOS)
    left = (draw_w - width) // 2
    top = (draw_h - height) // 2
    return resized.crop((left, top, left + width, top + height))


def _stretch(image: Image.Image, width: int, height: int) -> Image.Image:
    return image.resize((width, height), Image.Resampling.LANCZOS)


# ---------------------------------------------------------------------------
# 二维码


def _qr_image(text: str, size: int) -> Optional[Image.Image]:
    global _QR_WARNED
    if not text:
        return None
    key = (text, int(size))
    if key in _QR_CACHE:
        return _QR_CACHE[key]
    if qrcode is None:
        if not _QR_WARNED:
            warn_missing_qrcode()
            _QR_WARNED = True
        return None
    try:
        code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=10, border=0)
        code.add_data(text)
        code.make(fit=True)
        image = code.make_image(fill_color="black", back_color="white").convert("L")
        image = image.resize((max(1, size), max(1, size)), Image.Resampling.NEAREST)
        mask = image.point(lambda value: 255 if value < 128 else 0)
        result = Image.new("RGBA", (max(1, size), max(1, size)), (0, 0, 0, 255))
        result.putalpha(mask)
        _QR_CACHE[key] = result
        return result
    except Exception:
        return None


# ---------------------------------------------------------------------------
# 正面


def render_front(data: Dict, template: Template, width: Optional[int] = None,
                 scale: Optional[int] = None, fonts: Optional[FontBook] = None) -> Image.Image:
    fonts = fonts or FontBook()
    out_w, out_h = template.output_size(width=width, scale=scale)
    s = out_w / template.width
    logical_w, logical_h = template.logical_size
    font_scale = _font_scale(data)
    weight = _font_weight(data)
    adjust = template.adjust or {}
    dx = template.offset_dx
    dy = template.offset_dy
    dy2 = dy + float(adjust.get("allDy") or 0)

    def X(value: float) -> float:
        return float(value) * s

    def Y(value: float) -> float:
        return float(value) * s

    def fs(value: float) -> int:
        return max(1, int(round(float(value) * s * font_scale)))

    base = Image.new("RGB", (out_w, out_h), (255, 255, 255) if not template.is_blue else (255, 255, 255))
    background = _open_image(template.background_path)
    if template.fit == "cover":
        base = _cover(background, out_w, out_h)
    else:
        # 和 Web 一致：1:1 贴图，不拉伸；红票底部留 4px 白边。
        pasted = _stretch(background, round(background.width * s), round(background.height * s))
        base.paste(pasted, (0, 0))
    draw = ImageDraw.Draw(base)

    font_scale = _font_scale(data)
    weight = _font_weight(data)
    adj = template.adjust or {}
    dx = template.offset_dx * s
    dy = template.offset_dy * s
    dy2 = dy + float(adj.get("allDy") or 0) * s

    # 票号（顶部红字）
    ticket_no = str(data.get("ticket_number") or "")
    ticket_font = fs(40)
    ticket_spacing = 4 * s * font_scale
    ticket_width = _measure(fonts, ticket_no, "num_sans", ticket_font, weight) + max(0, len(ticket_no) - 1) * ticket_spacing
    ticket_available = (700 - 45) * s
    if ticket_width > ticket_available and ticket_no:
        factor = ticket_available / ticket_width
        ticket_font = max(1, int(ticket_font * factor))
        ticket_spacing *= factor
    _draw_spaced(
        draw, fonts, ticket_no,
        X(45) + float(adj.get("ticketNoDx") or 0) * s + dx,
        Y(50) + float(adj.get("ticketNoDy") or 0) * s + dy,
        "num_sans", ticket_font, weight, ticket_spacing, _RED,
    )

    # 检票口
    checkin = str(data.get("gate") or "")
    if checkin:
        checkin_x = X(760) + dx
        checkin_y = Y(40) + float(adj.get("checkinDy") or 0) * s + dy
        if adj.get("checkinAlign") == "ticketNoBottom":
            checkin_y = Y(50) + float(adj.get("ticketNoDy") or 0) * s + dy + 2 * s
        if adj.get("checkinAlign") == "endStationSuffix":
            end_name = str(data.get("to_station") or "")
            geometry = station_geometry("end", end_name, 550)
            _draw_text(draw, fonts, "站", X(geometry["suffixX"]) + dx, Y(105) + dy2, "zh", fs(32), weight)
            checkin_x = X(geometry["suffixX"]) + dx + _measure(fonts, "站", "zh", fs(32), weight)
        _draw_text(draw, fonts, checkin, checkin_x, checkin_y, "zh", fs(30), weight, anchor="rm")

    # 始发 / 到达
    def draw_station(kind: str) -> None:
        name = str(data.get("from_station" if kind == "start" else "to_station") or "")
        pinyin = str(data.get("from_pinyin" if kind == "start" else "to_pinyin") or "")
        if not name:
            return
        display, ratio = station_display(name)
        base_x = 60 if kind == "start" else 550
        geometry = station_geometry(kind, display, base_x)
        base_size = 50 * ratio
        measure_logic = lambda text, size_out: _measure(fonts, text, "zh", int(round(size_out * s)), weight) / s
        size_logic = fit_font_size(measure_logic, display, base_size, geometry["target"] / font_scale, 0.5)
        _draw_spread(
            draw, fonts, display, X(geometry["x"]) + dx, Y(105) + dy2,
            "zh", fs(size_logic), weight, X(geometry["target"]),
        )
        _draw_text(draw, fonts, "站", X(geometry["suffixX"]) + dx, Y(105) + dy2, "zh", fs(32), weight)
        if pinyin:
            # 拼音按 30px 居中；不要为了塞进站名宽度缩成小字。
            py_x = pinyin_x(
                kind, base_x, display,
                lambda text: _measure(fonts, text, "zh", fs(30), weight) / s,
            )
            _draw_text(draw, fonts, pinyin, X(py_x) + dx, Y(145) + dy2, "latin_sans", fs(30), weight, anchor="mm")

    draw_station("start")
    draw_station("end")

    # 车次 + 箭头
    train = sanitize_train_no(data.get("train"))
    if train:
        _draw_text(draw, fonts, train, X(400) + dx, Y(105) + dy2, "latin_sans", fs(46), weight, anchor="mm")
        line_width = max(1, round(2 * s))
        draw.line(
            [(X(345) + dx, Y(135) + dy2), (X(465) + dx, Y(135) + dy2)],
            fill=_BLACK, width=line_width,
        )
        draw.line(
            [(X(450) + dx, Y(130) + dy2), (X(465) + dx, Y(135) + dy2),
             (X(450) + dx, Y(140) + dy2)],
            fill=_BLACK, width=line_width,
        )

    # 日期 / 时间
    runs = date_runs(data.get("date"), data.get("time"))
    if runs:
        normalized = []
        for run in runs:
            item = dict(run)
            item["role"] = "num" if str(item.get("text") or "").isdigit() or ":" in str(item.get("text") or "") else "zh"
            normalized.append(item)
        date_gap = 5 * s
        total = 0.0
        for item in normalized:
            if item.get("gap"):
                total += float(item["gap"]) * s
            text = str(item.get("text") or "")
            if text:
                item_font = max(1, int(round(float(item.get("size") or 24) * s * font_scale)))
                measure_role = {"num": "num_sans", "latin": "latin_sans"}.get(item["role"], item["role"])
                total += _measure(fonts, text, measure_role, item_font, weight) + date_gap
        available = (500 - 40) * s
        if total > available and total > 0:
            factor = available / total
            for item in normalized:
                if item.get("size"):
                    item["size"] = float(item["size"]) * factor
                if item.get("gap"):
                    item["gap"] = float(item["gap"]) * factor
            date_gap *= factor
        _draw_runs(draw, fonts, normalized, X(40) + dx, Y(190) + dy2, s, weight, font_scale, _BLACK, date_gap)
    else:
        _draw_text(draw, fonts, "--", X(40) + dx, Y(190) + dy2, "num_sans", fs(30), weight)

    # 车厢 / 座位 / 铺位
    c_runs = carriage_runs(data)
    if c_runs:
        carriage_gap = 3 * s
        total = sum(
            _measure(fonts, str(item.get("text") or ""), {"num": "num_sans", "latin": "latin_sans"}.get(str(item.get("role")), str(item.get("role")) or "zh"),
                     max(1, int(round(float(item.get("size") or 24) * s * font_scale))), weight)
            for item in c_runs
        ) + max(0, len(c_runs) - 1) * carriage_gap
        available = (790 - 522) * s
        if total > available and total > 0:
            factor = available / total
            for item in c_runs:
                if item.get("size"):
                    item["size"] = float(item["size"]) * factor
            carriage_gap *= factor
        _draw_runs(draw, fonts, c_runs, X(522) + dx, Y(190) + dy2, s, weight, font_scale, _BLACK, carriage_gap)

    # 票价
    if price_is_visible(data.get("price")):
        price = format_price(data.get("price"))
        # SF Pro 没有 U+FFE5（￥），会画成方框/黑条；用中文字体画 ￥，数字再用 num_sans。
        _draw_text(draw, fonts, "￥", X(40) + dx, Y(235) + dy2, "zh", fs(36), weight)
        price_x = X(40) + dx + _measure(fonts, "￥", "zh", fs(36), weight)
        _draw_text(draw, fonts, price, price_x, Y(235) + dy2, "num_sans", fs(36), weight)
        _draw_text(
            draw, fonts, "元",
            price_x + _measure(fonts, price, "num_sans", fs(36), weight),
            Y(235) + dy2, "zh", fs(24), weight,
        )

    # 优惠标志
    flags_data = dict(data.get("flags") or {})
    if str(data.get("channel") or "") == "网":
        flags_data["online"] = True  # 旧数据只有 channel="网"
    flags = [("child", "孩"), ("student", "学"), ("online", "网"), ("discount", "惠")]
    active = [char for key, char in flags if bool(flags_data.get(key))]
    if active:
        x = 360 - 20 * len(active) + dx
        y = Y(235) + dy2
        for char in active:
            x += 40 * s
            _draw_text(draw, fonts, char, x, y, "zh", fs(24), weight)
            radius = 15 * s
            draw.ellipse(
                [x + 12 * s - radius, y - 2 * s - radius, x + 12 * s + radius, y - 2 * s + radius],
                outline=_BLACK, width=max(1, round(2 * s)),
            )

    # 席别
    seat_type = str(data.get("seat_type") or "")
    if seat_type:
        _draw_text(draw, fonts, seat_type, X(620) + dx, Y(235) + dy2, "zh", fs(30), weight, anchor="mm")

    # 附加信息
    info1_code = int(data.get("info1") or 0) if str(data.get("info1") or "0").isdigit() else 0
    info1 = INFO1_LABELS[info1_code] if 0 <= info1_code < len(INFO1_LABELS) else ""
    if info1:
        _draw_text(draw, fonts, info1, X(40) + dx, Y(270) + dy2, "zh", fs(24), weight)
    if data.get("info2"):
        _draw_text(draw, fonts, str(data.get("info2")), X(40) + dx, Y(305) + dy2, "zh", fs(24), weight)

    # 证件号（不要压到姓名）
    if data.get("id_number"):
        identity = str(data.get("id_number"))
        identity_font = fs(35)
        available = (400 - 40 - 8) * s
        width = _measure(fonts, identity, "num_sans", identity_font, weight)
        if width > available:
            identity_font = max(1, int(identity_font * available / width))
        _draw_text(draw, fonts, identity, X(40) + dx, Y(345) + dy2, "num_sans", identity_font, weight)

    # 姓名（二维码禁区）
    qr_layout = layout().get("qr") or {
        "blue": {"x": 600, "y": 300, "size": 128},
        "red": {"x": 600, "y": 360, "size": 136},
    }
    if template.is_blue:
        qr_x = float(qr_layout["blue"]["x"])
        qr_y = float(qr_layout.get("bluePaperY") if template.key == "blue-paper" else qr_layout["blue"]["y"])
        qr_size = float(qr_layout["blue"]["size"])
    else:
        qr_x = float(qr_layout["red"]["x"])
        qr_y = float(qr_layout["red"]["y"])
        qr_size = float(qr_layout["red"]["size"])

    name = str(data.get("passenger_name") or "")
    name_x = X(400) + dx
    name_y = Y(345) + dy2
    if name:
        zone_right = X(qr_x - 8)
        max_width = max(10.0, zone_right - name_x)
        name_px = fs(32)
        lines = wrap_name_lines(lambda text: _measure(fonts, text, "zh", name_px, weight), name, max_width)
        widest = max((_measure(fonts, line, "zh", name_px, weight) for line in lines), default=0)
        if widest > max_width:
            name_px = max(fs(20), int(name_px * max_width / widest))
            lines = wrap_name_lines(lambda text: _measure(fonts, text, "zh", name_px, weight), name, max_width)
        if len(lines) > 1:
            line_h = max(1, round(name_px * 1.06))
            top = name_y - line_h * (len(lines) - 1)
            if top < Y(320):
                one = name_px
                while one > fs(18):
                    if _measure(fonts, name, "zh", one, weight) <= max_width:
                        break
                    one -= max(1, int(s))
                name_px = one
                lines = wrap_name_lines(lambda text: _measure(fonts, text, "zh", name_px, weight), name, max_width)
        line_h = max(1, round(name_px * 1.06))
        for index, line in enumerate(lines):
            _draw_text(
                draw, fonts, line, name_x,
                name_y - line_h * (len(lines) - 1 - index),
                "zh", name_px, weight,
            )

    # 二维码
    qr_text = str(data.get("qrcode") or DEFAULT_QR) if data.get("qr_enabled", True) else ""
    qr_size_px = max(1, round(qr_size * s))
    qr_img = _qr_image(qr_text, qr_size_px)
    if qr_img is not None:
        base.paste(qr_img, (round(X(qr_x)), round(Y(qr_y))), qr_img)

    # 虚线框
    _dashed_rect(
        draw,
        (X(80) + dx, Y(365) + dy2, X(540) + dx, Y(435) + dy2),
        10 * s, 5 * s, max(1, round(2 * s)),
    )

    # 底部提示两行
    line1, line2 = INFO3_TEXT.get(str(data.get("info3") or DEFAULT_INFO3), INFO3_TEXT["0"])
    _draw_text(draw, fonts, line1, X(300) + dx, Y(385) + dy2, "zh", fs(24), weight, anchor="mm")
    _draw_text(draw, fonts, line2, X(300) + dx, Y(415) + dy2, "zh", fs(24), weight, anchor="mm")

    # 取票机号 / 底部黑字
    machine = str(data.get("machine_id") or data.get("serial_number") or "")
    if machine:
        machine_y = (475 if template.is_blue else 485) + float(adj.get("allDy") or 0) + float(adj.get("machineDy") or 0)
        machine_font = fs(27)
        machine_available = (width - 40 - 180) * s
        machine_width = _measure(fonts, machine, "zh", machine_font, weight)
        if machine_width > machine_available and machine_width > 0:
            machine_font = max(1, int(machine_font * machine_available / machine_width))
        _draw_text(draw, fonts, machine, X(40) + dx, Y(machine_y), "zh", machine_font, weight)

    # 合规标识
    _draw_text(
        draw, fonts, DISCLAIMER, out_w - round(16 * s), out_h - round(15 * s),
        "zh", max(1, round(15 * s * font_scale)), weight, _DISCLAIMER_COLOR, anchor="rm",
    )
    return base


# ---------------------------------------------------------------------------
# 背面


def render_back(data: Dict, template: Template, style=None, width: Optional[int] = None,
                scale: Optional[int] = None, fonts: Optional[FontBook] = None,
                template_for=None) -> Image.Image:
    fonts = fonts or FontBook()
    style = normalize_back_style(style or {})
    out_w, out_h = template.output_size(width=width, scale=scale)
    s = out_w / template.width
    sc = out_w / 809.0
    weight = _font_weight(data)
    font_scale = _font_scale(data)

    base = Image.new("RGB", (out_w, out_h), (255, 254, 251))
    draw = ImageDraw.Draw(base)
    background = style.get("background") or template.key

    if background == "solid":
        base.paste(Image.new("RGB", (out_w, out_h), _hex_color(style.get("solidColor"), "#d9d9d9")), (0, 0))
        draw = ImageDraw.Draw(base)
    elif background == "custom":
        custom = style.get("customImage") or ""
        if custom and Path(str(custom)).is_file():
            image = _open_image(Path(str(custom)))
            base = _cover(image, out_w, out_h) if (image.width != out_w or image.height != out_h) else image
            draw = ImageDraw.Draw(base)
    else:
        try:
            target = (template_for or get_template)(background)
            image = _open_image(target.background_path)
            if target.width == template.width and target.height == template.height:
                base = _stretch(image, out_w, out_h)
            else:
                base = _cover(image, out_w, out_h)
            draw = ImageDraw.Draw(base)
        except Exception:
            pass

    # 遮罩
    mask = style.get("mask") or {}
    if mask.get("enabled"):
        alpha = max(0.0, min(1.0, float(mask.get("alpha") or 0)))
        color = (255, 254, 251) if mask.get("color") == "white" else (0, 0, 0)
        overlay = Image.new("RGBA", (out_w, out_h), color + (round(alpha * 255),))
        base = Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(base)

    # 标题
    title_size = max(10, float(style.get("titleSize") or 40)) * sc * font_scale
    title_weight = int(style.get("titleWeight") or 700)
    title_y = round(out_h * 0.072) + title_size / 2
    _draw_text(
        draw, fonts, style.get("title") or "报销凭证使用须知",
        out_w / 2, title_y, "zh", max(1, int(round(title_size))), title_weight,
        _hex_color(style.get("titleColor"), "#333333"), anchor="mm",
    )

    # 条款：按用户字号排版，超出高度时逐步缩小
    left = round(out_w * 0.052)
    max_w = out_w - left * 2
    preferred = max(10.0, float(style.get("termsSize") or 21) * sc * font_scale)
    terms = str(style.get("terms") or "")
    terms_weight = int(style.get("termsWeight") or 500)
    color = _hex_color(style.get("termsColor"), "#3c3c3c")
    fs_px = preferred
    lines: List[Tuple[str, float]] = []
    line_h = max(1, round(fs_px * 1.62))
    start_y = title_y + title_size * 0.5 + round(out_h * 0.032) + line_h / 2
    for _ in range(10):
        indent = fs_px * 2
        line_h = max(1, round(fs_px * 1.62))
        start_y = title_y + title_size * 0.5 + round(out_h * 0.032) + line_h / 2
        lines = []
        for paragraph in terms.split("\n"):
            if not paragraph.strip():
                lines.append(("", 0.0))
                continue
            line = ""
            first = True
            for char in paragraph:
                test = line + char
                avail = max_w - (indent if first else 0)
                if _measure(fonts, test, "zh", int(round(fs_px)), terms_weight) > avail and line:
                    lines.append((line, indent if first else 0.0))
                    first = False
                    line = char
                else:
                    line = test
            if line:
                lines.append((line, indent if first else 0.0))
        if start_y + len(lines) * line_h <= out_h - 12 or fs_px <= 12:
            break
        fs_px = max(12, fs_px * 0.92)
    y = start_y
    for line, indent in lines:
        if line:
            _draw_text(draw, fonts, line, left + indent, y, "zh", int(round(fs_px)), terms_weight, color)
        y += line_h
    return base


def compose_front_back(front: Image.Image, back: Image.Image, logical_width: int, gap: int = 26) -> Image.Image:
    width = max(front.width, back.width)
    scale = front.width / logical_width if logical_width else 1
    gap_px = max(1, round(gap * scale))
    out = Image.new("RGB", (width, front.height + gap_px + back.height), (255, 254, 251))
    out.paste(front, ((width - front.width) // 2, 0))
    out.paste(back, ((width - back.width) // 2, front.height + gap_px))
    return out


# ---------------------------------------------------------------------------
# 对外入口


def render_ticket(data: Dict, style: str = "blue", width: Optional[int] = None,
                  fonts: Optional[FontBook] = None, scale: Optional[int] = None) -> Image.Image:
    """渲染一张正面；style='pink' 走旧版兼容渲染器。"""
    if style == "pink":
        from .legacy import render_ticket as legacy_render
        return legacy_render(data, "pink", width or 1800, fonts)
    template = get_template(style)
    return render_front(data, template, width=width, scale=scale, fonts=fonts)


def save_ticket(image: Image.Image, destination, template: str = "") -> Path:
    """原子写入 PNG，并附带“纪念车票”元数据。"""
    destination = Path(destination).expanduser().resolve()
    if destination.suffix.lower() != ".png":
        raise ValueError("输出文件必须使用 .png 扩展名")
    assets = Path(__file__).resolve().parents[2] / "assets"
    if destination == assets or assets in destination.parents:
        raise ValueError("输出路径不能覆盖模板素材")
    destination.parent.mkdir(parents=True, exist_ok=True)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Description", DISCLAIMER)
    metadata.add_text("Software", "Rail Memory v2")
    if template:
        metadata.add_text("Template", str(template))
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


__all__ = [
    "compose_front_back", "render_back", "render_front", "render_ticket", "save_ticket",
]
