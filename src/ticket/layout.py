"""票面排版数学：站名几何、长文本缩放、姓名折行、混排 run。

坐标全部是 1x 逻辑像素，和 manifest / docs/ticket-template-spec.md 一致。
"""

import re
from decimal import Decimal, InvalidOperation
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

# Canvas 的 textBaseline="middle" 与 Pillow 的 anchor="mm" 存在约 1px 的
# 字体度量差异；参考图整体比 anchor="mm" 高约 1px，这里统一校正。
TEXT_Y_OFFSET = -1.0

MAX_STATION_CHARS = 6
STATION_MIN_RATIO = 0.5
GENERAL_MIN_RATIO = 0.72
NAME_MIN_PX = 20


def station_geometry(kind: str, name: str, x: float) -> Dict[str, float]:
    """站名 + “站”的几何位置（与 TraceDot/Web layout.js 一致）。"""
    value = str(name or "")
    length = len(value)
    is_start = kind == "start"
    if length < 4:
        return {"x": x, "target": 160.0, "suffixX": x + 165.0}
    if is_start:
        return {
            "x": x - (length - 3) * 15.0,
            "target": 170.0 + (length - 3) * 20.0,
            "suffixX": x + 165.0 + (length - 3) * 33.0,
        }
    return {
        "x": x - (length - 3) * 20.0,
        "target": 170.0 + (length - 3) * 20.0,
        "suffixX": x + 165.0 + (length - 3) * 25.0,
    }


def station_display(name: str) -> Tuple[str, float]:
    """站名最多 6 个汉字；超长截断到 5 字 + 省略号，并按 80% 字号起排。"""
    value = str(name or "")
    if len(value) > MAX_STATION_CHARS:
        return value[:MAX_STATION_CHARS - 1] + "…", 0.8
    return value, 1.0


def pinyin_x(kind: str, base_x: float, display: str,
             measure_station: Callable[[str], float]) -> float:
    """拼音中心 x。

    参考图中短站名的拼音都在 x+90；长站名按 spec 的 max 公式避免压到中间。
    """
    if kind == "start" and len(display) >= 4:
        return max(base_x + 90.0, measure_station(display) / 2.0 + 100.0)
    return base_x + 90.0


def fit_font_size(measure: Callable[[str, int], float], text: str, base_size: float,
                  max_width: float, min_ratio: float = GENERAL_MIN_RATIO) -> int:
    """按 maxWidth 缩字号，返回整数像素字号（不低于 base*minRatio）。"""
    natural_size = max(1, int(round(base_size)))
    if not text or not max_width or max_width <= 0:
        return natural_size
    width = measure(text, natural_size)
    if width <= max_width:
        return natural_size
    fitted = max(natural_size * min_ratio, int(natural_size * max_width / width))
    return max(1, int(fitted))


def wrap_name_lines(measure: Callable[[str], float], text: str,
                    max_width: float) -> List[str]:
    """姓名折行：一行放不下时，找两行都不越界且宽度最接近的切分。"""
    value = str(text or "")
    if not value:
        return []
    if measure(value) <= max_width:
        return [value]
    best: Optional[Tuple[float, List[str]]] = None
    for index in range(1, len(value)):
        first, second = value[:index], value[index:]
        width_a, width_b = measure(first), measure(second)
        if width_a > max_width or width_b > max_width:
            continue
        score = abs(width_a - width_b)
        if best is None or score < best[0]:
            best = (score, [first, second])
    if best:
        return best[1]
    middle = (len(value) + 1) // 2
    return [value[:middle], value[middle:]]


def date_runs(date: str, time: str = "") -> Optional[List[Dict[str, object]]]:
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", str(date or ""))
    if not match:
        return None
    year, month, day = match.groups()
    runs: List[Dict[str, object]] = [
        {"text": year, "size": 38},
        {"text": "年", "size": 24},
        {"text": month, "size": 38},
        {"text": "月", "size": 24},
        {"text": day, "size": 38},
        {"text": "日", "size": 24},
    ]
    if time:
        # TraceDot 在“日”和发车时间之间额外留 12px（另有段间 5px）。
        runs.append({"text": "", "size": 24, "gap": 12})
        runs.append({"text": time, "size": 38})
        runs.append({"text": "开", "size": 24})
    return runs


def carriage_runs(data: Dict[str, object]) -> List[Dict[str, object]]:
    runs: List[Dict[str, object]] = []
    coach = str(data.get("coach") or "")
    seat = str(data.get("seat") or "")
    position = str(data.get("seat_position") or "")
    if coach:
        runs.append({"text": coach, "size": 40, "role": "num"})
        runs.append({"text": "车", "size": 24, "role": "zh"})
    if seat:
        runs.append({"text": seat, "size": 40, "role": "num"})
        if seat != "无座":
            runs.append({"text": "号", "size": 24, "role": "zh"})
    if position:
        runs.append({"text": position, "size": 24, "role": "zh"})
    return runs


def format_price(value) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        price = Decimal(text)
    except InvalidOperation:
        return ""
    if not price.is_finite() or price < 0:
        return ""
    return format(price.quantize(Decimal("0.1")), ".1f")


def price_is_visible(value) -> bool:
    text = format_price(value)
    return bool(text) and Decimal(text) != 0


def sanitize_train_no(value) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", str(value or ""))


def run_gap(text: str, family: str, size: float, tracking: float = 0.0) -> Dict[str, object]:
    return {"text": text, "family": family, "size": size, "tracking": tracking}


__all__ = [
    "GENERAL_MIN_RATIO", "MAX_STATION_CHARS", "NAME_MIN_PX", "STATION_MIN_RATIO",
    "TEXT_Y_OFFSET", "carriage_runs", "date_runs", "fit_font_size", "format_price",
    "pinyin_x", "price_is_visible", "sanitize_train_no", "station_display",
    "station_geometry", "wrap_name_lines",
]
