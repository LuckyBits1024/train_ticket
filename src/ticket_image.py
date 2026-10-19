"""纪念车票渲染入口（兼容旧 import）。

新实现拆在 ``src/ticket/``：
- ``ticket.render``：八款正面 + 背面 + 合并
- ``ticket.validate``：字段/背面参数规范化
- ``ticket.fonts``：系统字体发现
- ``ticket.legacy``：旧粉票渲染器（``--style pink``）
"""

from pathlib import Path

from .ticket.fonts import FontBook
from .ticket.render import compose_front_back, render_back, render_ticket, save_ticket
from .ticket.templates import ALL_STYLE_CHOICES, STYLE_KEYS, get_template, style_keys
from .ticket.validate import (
    ALIASES,
    DISCLAIMER,
    FIELDS,
    LIMITS,
    DEFAULT_QR,
    EXTRA_FIELDS,
    EXTRA_LIMITS,
    INFO1_LABELS,
    INFO3_TEXT,
    normalize_back_style,
    normalize_fields,
)

ASSETS = Path(__file__).resolve().parents[1] / "assets" / "ticket-template"

__all__ = [
    "ASSETS",
    "ALIASES",
    "ALL_STYLE_CHOICES",
    "DEFAULT_QR",
    "DISCLAIMER",
    "EXTRA_FIELDS",
    "EXTRA_LIMITS",
    "FIELDS",
    "FontBook",
    "INFO1_LABELS",
    "INFO3_TEXT",
    "LIMITS",
    "STYLE_KEYS",
    "compose_front_back",
    "get_template",
    "normalize_back_style",
    "normalize_fields",
    "render_back",
    "render_ticket",
    "save_ticket",
    "style_keys",
]
