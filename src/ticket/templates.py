"""读取并包装 Rail Memory v2 的票据模板清单（manifest.json）。

所有坐标与尺寸均以 manifest 为准；这里只做路径解析和少量便捷属性，
不在代码里另写一套画布尺寸。
"""

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Mapping, Tuple

ROOT = Path(__file__).resolve().parents[2]
ASSETS_ROOT = ROOT / "assets" / "ticket-template"
V2_ROOT = ASSETS_ROOT / "v2"
MANIFEST_PATH = V2_ROOT / "manifest.json"

# 新模板的 8 款 key（顺序与 manifest 一致，批量导出也按这个顺序）。
STYLE_KEYS: Tuple[str, ...] = (
    "blue",
    "blue-paper",
    "blue-mag",
    "blue-etch",
    "blue-etch-mag",
    "red",
    "red-paper",
    "red-mag",
)

# 旧粉票是独立素材，不在 v2 manifest 里，但 CLI 继续支持。
PINK = "pink"
ALL_STYLE_CHOICES: Tuple[str, ...] = STYLE_KEYS + (PINK,)

DEFAULT_SCALE = 2
MAX_OUTPUT_WIDTH = 4800
MIN_OUTPUT_WIDTH = 600


@dataclass(frozen=True)
class Template:
    key: str
    label: str
    family: str
    width: int
    height: int
    background: str
    fit: str
    offset_dx: float
    offset_dy: float
    adjust: Mapping[str, Any] = field(default_factory=dict)
    asset_root: Path = V2_ROOT
    raw: Mapping[str, Any] = field(default_factory=dict)

    @property
    def background_path(self) -> Path:
        return self.asset_root / self.background

    @property
    def is_blue(self) -> bool:
        return self.family == "blue"

    @property
    def default_width(self) -> int:
        """默认 2x 导出宽度（蓝 1618 / 红 1600 / 粉 2140）。"""
        return round(self.width * DEFAULT_SCALE)

    @property
    def logical_size(self) -> Tuple[int, int]:
        return self.width, self.height

    def output_size(self, width=None, scale=None) -> Tuple[int, int]:
        """按输出宽度或倍率计算画布像素尺寸。"""
        if width is None:
            factor = DEFAULT_SCALE if scale is None else float(scale)
            width = round(self.width * factor)
        width = int(width)
        if width < MIN_OUTPUT_WIDTH or width > MAX_OUTPUT_WIDTH:
            raise ValueError("图片宽度必须在 {}～{} 像素之间".format(
                MIN_OUTPUT_WIDTH, MAX_OUTPUT_WIDTH))
        height = max(1, round(self.height * width / self.width))
        return width, height


@lru_cache(maxsize=1)
def load_manifest() -> Dict[str, Any]:
    try:
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError("找不到票面模板清单：{}".format(MANIFEST_PATH)) from exc
    except ValueError as exc:
        raise ValueError("票面模板清单不是合法 JSON：{}".format(exc)) from exc
    templates = data.get("templates")
    if not isinstance(templates, list):
        raise ValueError("票面模板清单缺少 templates 数组")
    missing = [key for key in STYLE_KEYS if not any(item.get("key") == key for item in templates)]
    if missing:
        raise ValueError("票面模板清单缺少款式：{}".format(", ".join(missing)))
    return data


def _pink_template() -> Template:
    return Template(
        key=PINK,
        label="粉红票（旧版）",
        family="pink",
        width=1070,
        height=705,
        background="pink.png",
        fit="stretch",
        offset_dx=0,
        offset_dy=0,
        adjust={},
        asset_root=ASSETS_ROOT,
        raw={"key": PINK, "label": "粉红票（旧版）", "family": "pink"},
    )


@lru_cache(maxsize=1)
def load_templates() -> Tuple[Template, ...]:
    result = []
    for item in load_manifest()["templates"]:
        canvas = item.get("canvas") or {}
        background = item.get("background") or {}
        offset = item.get("offset") or {}
        result.append(Template(
            key=item["key"],
            label=item.get("label") or item["key"],
            family=item.get("family") or "blue",
            width=int(canvas.get("width") or 809),
            height=int(canvas.get("height") or 509),
            background=background.get("src") or "",
            fit=background.get("fit") or "stretch",
            offset_dx=float(offset.get("dx") or 0),
            offset_dy=float(offset.get("dy") or 0),
            adjust=dict(item.get("adjust") or {}),
            raw=item,
        ))
    result.append(_pink_template())
    return tuple(result)


@lru_cache(maxsize=1)
def _by_key() -> Dict[str, Template]:
    return {template.key: template for template in load_templates()}


def get_template(key: str) -> Template:
    if not isinstance(key, str) or not key:
        raise ValueError("款式不能为空；可用款式：{}".format(", ".join(ALL_STYLE_CHOICES)))
    template = _by_key().get(key)
    if template is None:
        raise ValueError("未知款式：{}；可用款式：{}".format(key, ", ".join(ALL_STYLE_CHOICES)))
    return template


def layout() -> Mapping[str, Any]:
    return load_manifest().get("layout") or {}


def default_width(style: str) -> int:
    return get_template(style).default_width


def resolve_width(style: str, width=None, scale=None) -> int:
    """返回某款式的输出宽度；width 优先，其次 scale，最后 2x。"""
    return get_template(style).output_size(width=width, scale=scale)[0]


def style_keys(include_pink: bool = False) -> Tuple[str, ...]:
    return ALL_STYLE_CHOICES if include_pink else STYLE_KEYS
