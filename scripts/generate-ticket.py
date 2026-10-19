#!/usr/bin/env python3
"""传入 JSON 或命令行字段，离线生成纪念车票 PNG；也支持直接读 12306 积分导出。

八款新模板：blue / blue-paper / blue-mag / blue-etch / blue-etch-mag /
red / red-paper / red-mag；旧 pink 与 both 保持兼容。
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
try:
    from src.ticket_image import (
        ALIASES,
        FIELDS,
        FontBook,
        compose_front_back,
        get_template,
        normalize_back_style,
        normalize_fields,
        render_back,
        render_ticket,
        save_ticket,
    )
    from src.ticket.templates import ALL_STYLE_CHOICES, STYLE_KEYS
    from src.ticket.validate import DEFAULT_BACK_TERMS, DEFAULT_BACK_TITLE, INFO1_LABELS
    from src.points_ticket import collect_tickets, output_name, ticket_label
except ModuleNotFoundError as exc:
    if exc.name not in ("PIL", "qrcode"):
        raise
    sys.exit("缺少 Pillow/qrcode。请先运行：python3 -m venv .venv-ticket && "
             ".venv-ticket/bin/python -m pip install -r requirements-ticket.txt；"
             "再使用 .venv-ticket/bin/python 运行本脚本。")


STYLE_CHOICES = tuple(STYLE_KEYS) + ("pink", "both", "all")


def styles_for(style):
    if style == "all":
        return list(STYLE_KEYS)
    if style == "both":
        return ["blue", "pink"]
    return [style]


def build_fonts(args):
    overrides = {}
    for role in ("hei", "song", "latin", "number"):
        value = getattr(args, "font_" + role)
        if value:
            overrides[role] = value
    if args.font_cjk:
        overrides["zh"] = args.font_cjk
    if args.font_latin:
        overrides["latin_sans"] = args.font_latin
        overrides["latin"] = args.font_latin
    if args.font_number:
        overrides["num_sans"] = args.font_number
        overrides["number"] = args.font_number
    return FontBook(overrides)


def back_style_from_args(args, style):
    if not (args.back or args.back_only):
        return None
    terms = DEFAULT_BACK_TERMS
    if args.back_terms_file:
        terms = Path(args.back_terms_file).expanduser().read_text(encoding="utf-8-sig")
    background = args.back_bg or style
    if args.back_solid:
        background = "solid"
    if args.back_image:
        background = "custom"
    return normalize_back_style({
        "background": background,
        "solidColor": args.back_solid or "#d9d9d9",
        "customImage": args.back_image or "",
        "title": args.back_title or DEFAULT_BACK_TITLE,
        "titleSize": args.back_title_size,
        "terms": terms,
        "termsSize": args.back_terms_size,
        "mask": {
            "enabled": args.back_mask_alpha > 0,
            "color": args.back_mask_color,
            "alpha": args.back_mask_alpha,
        },
        "splitExport": bool(args.back_split),
    })


def render_and_save(data, style, args, fonts, target, back_style, base_suffix=""):
    """按 style / 背面参数生成一张或一组图片，返回生成张数。"""
    template = get_template(style)
    width = args.width
    scale = None if width else args.scale
    front = render_ticket(data, style, width=width, fonts=fonts, scale=scale)
    generated = 0

    if back_style is None:
        path = save_ticket(front, target, template=style)
        print("已生成 {}（{} × {}）".format(path, front.width, front.height))
        return 1

    back = render_back(data, template, back_style, width=width, scale=scale, fonts=fonts)
    if args.back_only:
        path = save_ticket(back, target.with_name(target.stem + "-back.png"), template=style)
        print("已生成 {}（{} × {}）".format(path, back.width, back.height))
        return 1

    if back_style.get("splitExport"):
        path = save_ticket(front, target, template=style)
        print("已生成 {}（{} × {}）".format(path, front.width, front.height))
        back_path = save_ticket(back, target.with_name(target.stem + "-back.png"), template=style)
        print("已生成 {}（{} × {}）".format(back_path, back.width, back.height))
        return 2

    merged = compose_front_back(front, back, template.width)
    path = save_ticket(merged, target.with_name(target.stem + "-front-back.png"), template=style)
    print("已生成 {}（{} × {}）".format(path, merged.width, merged.height))
    return 1


def run_points(args, parser):
    """从 12306 积分导出 JSON/CSV 批量生成纪念车票。"""
    if args.data:
        parser.error("--points 与 --data 不能同时使用")
    overrides = {field: getattr(args, field) for field in FIELDS if getattr(args, field) is not None}
    if overrides and not args.index:
        parser.error("--points 批量模式不支持逐字段覆盖；如只生成一条，请同时用 --index 指定")
    if args.output:
        parser.error("--points 批量模式请使用 --output-dir 指定目录")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit 必须是正整数")
    if args.index is not None and args.index < 1:
        parser.error("--index 必须是正整数")

    try:
        tickets, warnings = collect_tickets(args.points)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        parser.exit(2, "错误：{}\n".format(exc))

    for warning in warnings:
        print("提示：{}".format(warning), file=sys.stderr)
    if not overrides:
        print("提示：积分明细不含发车时间/座位号/票价，票面会留空；"
              "如需补全单条，请用 --index 指定并加 --time/--seat/--price。", file=sys.stderr)

    selected = list(enumerate(tickets, 1))
    if args.index:
        selected = [(i, t) for i, t in selected if i == args.index]
    if args.limit:
        selected = selected[:args.limit]
    if not selected:
        parser.exit(2, "没有可生成的乘车记录：请检查积分导出文件，或去掉 --index/--limit。\n")

    fonts = build_fonts(args)
    styles = styles_for(args.style)
    outdir = Path(args.output_dir).expanduser()
    generated = skipped = 0
    for index, ticket in selected:
        if overrides:
            ticket = {**ticket, **overrides}
        try:
            data = normalize_fields(ticket, mask_id=not args.show_id)
        except ValueError as exc:
            print("跳过 {}：{}".format(ticket_label(ticket, index), exc), file=sys.stderr)
            skipped += 1
            continue
        for style in styles:
            output = outdir / output_name(data, index, style if len(styles) > 1 else None)
            try:
                back_style = back_style_from_args(args, style)
                generated += render_and_save(data, style, args, fonts, output, back_style)
            except (ValueError, OSError) as exc:
                print("跳过 {} / {}：{}".format(ticket_label(ticket, index), style, exc), file=sys.stderr)
                skipped += 1
    print("完成：生成 {} 张，跳过 {} 条。".format(generated, skipped))
    return 0 if generated else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--data", metavar="JSON", help="字段 JSON 文件；- 表示从标准输入读取")
    parser.add_argument("--points", metavar="JSON_OR_CSV",
                        help="12306 积分导出文件（.json/.csv），每条乘车记录生成一张")
    parser.add_argument("--style", choices=STYLE_CHOICES, default="blue",
                        help="票面款式；all=八款全部，both=blue+pink（旧版兼容）")
    parser.add_argument("--output", "-o",
                        help="输出 PNG；多款式会自动加 -款式 后缀（单张模式，默认 output/tickets/ticket.png）")
    parser.add_argument("--output-dir", default="output/tickets/points",
                        help="--points 批量模式的输出目录（默认 output/tickets/points）")
    parser.add_argument("--limit", type=int, help="--points 批量模式只生成前 N 张")
    parser.add_argument("--index", type=int, help="--points 批量模式只生成第 N 条（从 1 开始）")
    parser.add_argument("--width", type=int,
                        help="输出宽度，600～4800 像素；不传时按款式 2x（蓝 1618 / 红 1600）")
    parser.add_argument("--scale", type=int, choices=(1, 2, 3), default=2,
                        help="未指定 --width 时的倍率（默认 2）")
    parser.add_argument("--show-id", action="store_true", help="按输入显示证件号；默认自动脱敏")

    parser.add_argument("--back", action="store_true", help="生成背面并与正面合并")
    parser.add_argument("--back-only", action="store_true", help="只生成背面")
    parser.add_argument("--back-split", action="store_true", help="正面、背面分开导出（不合并）")
    parser.add_argument("--back-bg", help="背面底图：款式 key / solid / custom")
    parser.add_argument("--back-solid", help="背面纯色（#rgb/#rrggbb）")
    parser.add_argument("--back-image", help="背面自定义图片路径")
    parser.add_argument("--back-title", help="背面标题")
    parser.add_argument("--back-title-size", type=float, default=40, help="背面标题字号（默认 40）")
    parser.add_argument("--back-terms-file", help="背面条款文本文件（UTF-8）")
    parser.add_argument("--back-terms-size", type=float, default=21, help="背面条款字号（默认 21）")
    parser.add_argument("--back-mask-alpha", type=float, default=0.0, help="背面遮罩透明度 0–1")
    parser.add_argument("--back-mask-color", choices=("black", "white"), default="black")

    names = {"from_station": "--from", "to_station": "--to", "passenger_name": "--name"}
    for field in FIELDS:
        flag = names.get(field, "--" + field.replace("_", "-"))
        parser.add_argument(flag, dest=field, help="覆盖 JSON 中的 " + field)
    for role in ("hei", "song", "latin", "number"):
        parser.add_argument("--font-" + role, metavar="PATH", help="覆盖旧字体角色；TTC 可带 #索引")
    parser.add_argument("--font-cjk", metavar="PATH", help="覆盖票面中文字体（新模板）")

    args = parser.parse_args(argv)
    if args.back_only and not args.back:
        args.back = True
    if args.back_only and args.back_split:
        parser.error("--back-only 与 --back-split 不能同时使用")
    if args.width is not None and not 600 <= args.width <= 4800:
        parser.error("--width 必须在 600～4800 之间")

    if args.points:
        return run_points(args, parser)

    try:
        if args.data:
            if args.data == "-":
                data = json.load(sys.stdin)
            else:
                data = json.loads(Path(args.data).expanduser().read_text(encoding="utf-8-sig"))
        else:
            data = {}
        if not isinstance(data, dict):
            raise ValueError("输入 JSON 必须是一个对象")
        mapped = {}
        for key, value in data.items():
            key = ALIASES.get(key, key)
            if key in mapped:
                raise ValueError("JSON 中字段重复：" + key)
            mapped[key] = value
        mapped.update({key: getattr(args, key) for key in FIELDS if getattr(args, key) is not None})
        data = normalize_fields(mapped, mask_id=not args.show_id)
        fonts = build_fonts(args)
        target = Path(args.output or "output/tickets/ticket.png").expanduser()
        if target.suffix.lower() != ".png":
            raise ValueError("--output 应为 .png 文件路径")
        if args.data and args.data != "-" and target.resolve() == Path(args.data).expanduser().resolve():
            raise ValueError("输出路径不能覆盖输入数据")

        styles = styles_for(args.style)
        generated = 0
        for style in styles:
            output = target
            if len(styles) > 1:
                output = target.with_name(target.stem + "-" + style + ".png")
            back_style = back_style_from_args(args, style)
            generated += render_and_save(data, style, args, fonts, output, back_style)
        return 0 if generated else 1
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        parser.exit(2, "错误：{}\n".format(exc))


if __name__ == "__main__":
    sys.exit(main())
