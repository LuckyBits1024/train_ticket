#!/usr/bin/env python3
"""传入 JSON 或命令行字段，离线生成纪念车票 PNG；也支持直接读 12306 积分导出。"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
try:
    from src.ticket_image import FIELDS, FontBook, normalize_fields, render_ticket, save_ticket
    from src.points_ticket import collect_tickets, output_name, ticket_label
except ModuleNotFoundError as exc:
    if exc.name != "PIL":
        raise
    sys.exit("缺少 Pillow。请先运行：python3 -m venv .venv-ticket && "
             ".venv-ticket/bin/python -m pip install -r requirements-ticket.txt；"
             "再使用 .venv-ticket/bin/python 运行本脚本。")


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

    fonts = FontBook({role: getattr(args, "font_" + role) for role in ("hei", "song", "latin", "number")})
    styles = ("blue", "pink") if args.style == "both" else (args.style,)
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
            image = render_ticket(data, style, args.width, fonts)
            path = save_ticket(image, output)
            print("已生成 {}（{} × {}）".format(path, image.width, image.height))
            generated += 1

    print("完成：生成 {} 张，跳过 {} 条。".format(generated, skipped))
    return 0 if generated else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--data", metavar="JSON", help="字段 JSON 文件；- 表示从标准输入读取")
    parser.add_argument("--points", metavar="JSON_OR_CSV",
                        help="12306 积分导出文件（.json/.csv），每条乘车记录生成一张")
    parser.add_argument("--style", choices=("blue", "pink", "both"), default="blue", help="票面款式（默认 blue）")
    parser.add_argument("--output", "-o",
                        help="输出 PNG；both 会自动加 -blue/-pink 后缀（单张模式，默认 output/tickets/ticket.png）")
    parser.add_argument("--output-dir", default="output/tickets/points",
                        help="--points 批量模式的输出目录（默认 output/tickets/points）")
    parser.add_argument("--limit", type=int, help="--points 批量模式只生成前 N 张")
    parser.add_argument("--index", type=int, help="--points 批量模式只生成第 N 条（从 1 开始）")
    parser.add_argument("--width", type=int, default=1800, help="输出宽度，600～6000 像素（默认 1800）")
    parser.add_argument("--show-id", action="store_true", help="按输入显示证件号；默认自动脱敏")
    names = {"from_station": "--from", "to_station": "--to", "passenger_name": "--name"}
    for field in FIELDS:
        flag = names.get(field, "--" + field.replace("_", "-"))
        parser.add_argument(flag, dest=field, help="覆盖 JSON 中的 " + field)
    for role in ("hei", "song", "latin", "number"):
        parser.add_argument("--font-" + role, metavar="PATH", help="覆盖字体；TTC 文件可带 #索引")
    args = parser.parse_args(argv)
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
        # Normalize aliases before applying CLI overrides, which take precedence.
        from src.ticket_image import ALIASES
        mapped = {}
        for key, value in data.items():
            key = ALIASES.get(key, key)
            if key in mapped:
                raise ValueError("JSON 中字段重复：" + key)
            mapped[key] = value
        mapped.update({key: getattr(args, key) for key in FIELDS if getattr(args, key) is not None})
        data = normalize_fields(mapped, mask_id=not args.show_id)
        fonts = FontBook({role: getattr(args, "font_" + role) for role in ("hei", "song", "latin", "number")})
        target = Path(args.output or "output/tickets/ticket.png").expanduser()
        if target.suffix.lower() != ".png":
            raise ValueError("--output 应为 .png 文件路径")
        styles = ("blue", "pink") if args.style == "both" else (args.style,)
        for style in styles:
            output = target.with_name(target.stem + "-" + style + ".png") if len(styles) == 2 else target
            if args.data and args.data != "-" and output.resolve() == Path(args.data).expanduser().resolve():
                raise ValueError("输出路径不能覆盖输入数据")
            image = render_ticket(data, style, args.width, fonts)
            path = save_ticket(image, output)
            print("已生成 {}（{} × {}）".format(path, image.width, image.height))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        parser.exit(2, "错误：{}\n".format(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
