"""系统字体发现与按字重取字。

设计要点：

- 默认**不使用宋体**。票面中文优先 PingFang SC，再退到 Hiragino / STHeiti /
  微软雅黑 / Noto Sans CJK；数字和英文使用系统无衬线字体（macOS 为 SF Pro，
  即浏览器 ``-apple-system`` 实际使用的字体）。
- 只有用户显式传 ``--font-latin`` / ``--font-number`` 时，才会使用 Times/Arial
  这类字体；旧的 ``--font-song`` 仍然保留给旧粉票。
- 字体文件不随仓库分发。缺字体时在真正绘制时才报错，并提示对应的 CLI 参数。
"""

import sys
from functools import lru_cache
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from PIL import ImageFont

_CANDIDATE = Tuple[str, int, Optional[Dict[int, int]], bool]
# (path, default_index, weight->index, is_variable_font)

WEIGHT_NAMES = {
    400: "Regular",
    500: "Medium",
    600: "Semibold",
    700: "Bold",
    800: "Heavy",
}

PINGFANG_WEIGHTS = {400: 3, 500: 7, 600: 11, 700: 11, 800: 11}
HELVETICA_NEUE_WEIGHTS = {400: 0, 500: 10, 600: 1, 700: 1, 800: 1}
HELVETICA_WEIGHTS = {400: 0, 500: 0, 600: 1, 700: 1, 800: 1}

# 旧粉票沿用原来的字体栈，保证旧输出不回归；新八款走 zh / latin_sans / num_sans。
LEGACY_CANDIDATES: Dict[str, List[_CANDIDATE]] = {
    "hei": [
        ("/System/Library/Fonts/STHeiti Medium.ttc", 1, None, False),
        ("C:/Windows/Fonts/simhei.ttf", 0, None, False),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2, None, False),
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0, None, False),
    ],
    "song": [
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 6, None, False),
        ("C:/Windows/Fonts/simsun.ttc", 0, None, False),
        ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", 2, None, False),
    ],
    "latin": [
        ("/System/Library/Fonts/Supplemental/Times New Roman.ttf", 0, None, False),
        ("C:/Windows/Fonts/times.ttf", 0, None, False),
        ("/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf", 0, None, False),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", 0, None, False),
    ],
    "number": [
        ("/System/Library/Fonts/Supplemental/Arial Narrow.ttf", 0, None, False),
        ("C:/Windows/Fonts/arialn.ttf", 0, None, False),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf", 0, None, False),
        ("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf", 0, None, False),
    ],
}

_LATIN_SANS_CANDIDATES: List[_CANDIDATE] = [
    ("/System/Library/Fonts/SFNS.ttf", 0, None, True),
    ("/System/Library/Fonts/HelveticaNeue.ttc", 0, HELVETICA_NEUE_WEIGHTS, False),
    ("/System/Library/Fonts/Helvetica.ttc", 0, HELVETICA_WEIGHTS, False),
    ("C:/Windows/Fonts/segoeui.ttf", 0, None, False),
    ("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", 0, None, False),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0, None, False),
    ("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf", 0, None, False),
    ("C:/Windows/Fonts/arial.ttf", 0, None, False),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", 0, None, False),
]


@lru_cache(maxsize=8)
def _find_pingfang() -> Optional[str]:
    patterns = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/PingFang.ttc",
        "/System/Library/PrivateFrameworks/FontServices.framework/Versions/A/"
        "Resources/Reserved/PingFangUI.ttc",
    ]
    for value in patterns:
        if Path(value).is_file():
            return value
    # macOS 新版本把 PingFang 放在 AssetsV2 的字体资产目录里。
    for pattern in (
        "/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*/AssetData/PingFang.ttc",
        "/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*/AssetData/PingFangSC.ttc",
    ):
        for path in sorted(Path("/").glob(pattern.lstrip("/"))):
            if path.is_file():
                return str(path)
    return None


def _modern_cjk_candidates() -> List[_CANDIDATE]:
    result: List[_CANDIDATE] = []
    pingfang = _find_pingfang()
    if pingfang:
        result.append((pingfang, 7, PINGFANG_WEIGHTS, False))
    result.extend([
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0, None, False),
        ("/System/Library/Fonts/STHeiti Medium.ttc", 1, None, False),
        ("C:/Windows/Fonts/msyh.ttc", 0, None, False),
        ("C:/Windows/Fonts/msyhbd.ttc", 0, None, False),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2, None, False),
        ("/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf", 0, None, False),
        ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 2, None, False),
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0, None, False),
    ])
    return result


def _candidate_available(path: str, index: int) -> bool:
    if not Path(path).is_file():
        return False
    try:
        ImageFont.truetype(path, 12, index=index)
    except OSError:
        return False
    return True


class FontBook:
    """字体路径解析器。

    ``get(role, size)`` 接受现代角色 ``zh`` / ``latin_sans`` / ``num_sans``，
    也接受旧角色 ``hei`` / ``song`` / ``latin`` / ``number``。旧粉票使用旧角色，
    默认仍是原来的宋体/Times/Arial Narrow；新旧角色都可通过 overrides 覆盖。
    """

    ROLES = ("zh", "latin_sans", "num_sans", "hei", "song", "latin", "number")

    def __init__(self, overrides=None):
        self.overrides = dict(overrides or {})
        # 兼容旧代码对 fonts.paths 的读取：只放已解析成功的角色。
        self.paths: Dict[str, Tuple[str, int]] = {}
        self._resolved: Dict[str, _CANDIDATE] = {}
        self._errors: Dict[str, str] = {}
        self._fonts: Dict[Tuple[str, int, int], ImageFont.FreeTypeFont] = {}
        for role in self.ROLES:
            try:
                self._resolve(role)
            except ValueError as exc:
                self._errors[role] = str(exc)

    # ---------- 路径解析 ----------

    def _override_candidate(self, role: str) -> Optional[_CANDIDATE]:
        value = self.overrides.get(role)
        if not value:
            return None
        path, separator, index = str(value).rpartition("#")
        if separator and index.isdigit():
            return (path, int(index), None, False)
        return (str(value), 0, None, _is_variable_font(str(value)))

    def _candidates(self, role: str) -> Iterable[_CANDIDATE]:
        if role in ("zh", "cjk"):
            return _modern_cjk_candidates()
        if role in ("latin_sans", "num_sans"):
            return _LATIN_SANS_CANDIDATES
        return LEGACY_CANDIDATES.get(role, [])

    def _resolve(self, role: str) -> _CANDIDATE:
        if role in self._resolved:
            return self._resolved[role]
        override = self._override_candidate(role)
        candidates = [override] if override else list(self._candidates(role))
        for path, index, weights, variable in candidates:
            if not _candidate_available(path, index):
                continue
            candidate = (path, index, weights, variable)
            self._resolved[role] = candidate
            self.paths[role] = (path, index)
            return candidate
        if role in ("latin_sans", "num_sans"):
            # 没有独立西文字体时退回中文字体（CJK 字体通常自带拉丁字形）。
            try:
                fallback = self._resolve("zh")
            except ValueError:
                fallback = None
            if fallback:
                self._resolved[role] = fallback
                self.paths[role] = (fallback[0], fallback[1])
                return fallback
        suggestion = {
            "zh": "--font-cjk",
            "cjk": "--font-cjk",
            "latin_sans": "--font-latin",
            "num_sans": "--font-number",
            "hei": "--font-hei",
            "song": "--font-song",
            "latin": "--font-latin",
            "number": "--font-number",
        }.get(role, "--font-cjk")
        message = (
            "找不到 {} 字体，请用 {} '/路径/字体.ttf' 指定；"
            "TTC 字体集合可写成 '/路径/字体.ttc#索引'".format(role, suggestion)
        )
        self._errors[role] = message
        raise ValueError(message)

    # ---------- 取字 ----------

    @staticmethod
    def _normalise_weight(weight) -> int:
        try:
            value = int(weight)
        except (TypeError, ValueError):
            return 500
        if value <= 450:
            return 400
        if value <= 550:
            return 500
        if value <= 650:
            return 600
        if value <= 750:
            return 700
        return 800

    def _load(self, role: str, size: int, weight: int) -> ImageFont.FreeTypeFont:
        path, default_index, weights, variable = self._resolve(role)
        index = default_index
        if weights:
            index = weights.get(weight, default_index)
        try:
            font = ImageFont.truetype(path, max(1, int(size)), index=index)
        except OSError as exc:
            raise ValueError(
                "字体无法加载：{}#{}（{}）；请用 --font-cjk/--font-latin 指定其他字体".format(
                    path, index, exc)
            ) from exc
        if variable:
            name = WEIGHT_NAMES.get(weight)
            if name:
                try:
                    font.set_variation_by_name(name)
                except (AttributeError, OSError, ValueError):
                    pass
        return font

    def get(self, role: str, size: int, weight=500) -> ImageFont.FreeTypeFont:
        role = "zh" if role == "cjk" else role
        weight = self._normalise_weight(weight)
        key = (role, max(1, int(round(size))), weight)
        font = self._fonts.get(key)
        if font is None:
            font = self._load(role, key[1], weight)
            self._fonts[key] = font
        return font

    def measure(self, text: str, role: str, size: int, weight=500) -> float:
        if not text:
            return 0.0
        return float(self.get(role, size, weight).getlength(str(text)))

    def supports(self, role: str, char: str, size: int = 20, weight=500) -> bool:
        """粗略判断字体是否有该字符（Pillow 对缺字会画 .notdef，无法精确区分）。"""
        try:
            font = self.get(role, size, weight)
            if char == "\uffe5":
                # SF Pro 没有 U+FFE5，会回退成 36px 的方框；U+00A5 才是正常窄字形。
                return font.getlength(char) < float(size) * 0.9
            return font.getlength(char) > 0
        except ValueError:
            return False


def _is_variable_font(path: str) -> bool:
    name = Path(path).name.lower()
    return name in ("sfns.ttf", "sfns-italic.ttf", "sfnsrrounded.ttf")


def available_font_roles(fonts: FontBook) -> List[str]:
    return sorted(fonts.paths)


def warn_missing_qrcode() -> None:
    print("提示：未安装可选依赖 qrcode，二维码将留空；"
          "运行 python -m pip install qrcode 可启用。", file=sys.stderr)


__all__ = [
    "FontBook",
    "LEGACY_CANDIDATES",
    "available_font_roles",
    "warn_missing_qrcode",
]
