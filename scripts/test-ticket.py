#!/usr/bin/env python3
"""Offline checks for input handling, CLI behavior and protected template regions."""
import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PIL import Image, ImageChops
from src.ticket_image import (
    ASSETS, DISCLAIMER, FontBook, compose_front_back, normalize_fields, render_back,
    render_ticket, save_ticket,
)
from src.ticket.templates import STYLE_KEYS
from src.points_ticket import collect_tickets


class TicketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = json.loads((ROOT / "examples/ticket.json").read_text())
        cls.fonts = FontBook()

    def test_required_optional_and_station_suffix(self):
        raw = {k: self.raw[k] for k in ("from_station", "to_station", "train", "date", "time")}
        raw["from_station"] = "北京南站"
        result = normalize_fields(raw)
        self.assertEqual(result["from_station"], "北京南")
        self.assertEqual(result["price"], "")
        self.assertEqual(result["passenger_name"], "")
        with self.assertRaisesRegex(ValueError, "缺少必填"):
            normalize_fields({})

    def test_dates_and_time_are_real(self):
        self.assertEqual(normalize_fields({**self.raw, "date": "2024-02-29"})["date"], "2024-02-29")
        for patch in ({"date": "2025-02-29"}, {"date": "2026-13-01"},
                      {"date": "2026-1-1"}, {"time": "24:00"}, {"time": "10:60"}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                normalize_fields({**self.raw, **patch})

    def test_amount_validation_and_formatting(self):
        for value, expected in ((57, "57.0"), ("57.50", "57.5"), ("57.55", "57.55"),
                                (0, "0.0"), ("999999.99", "999999.99")):
            self.assertEqual(normalize_fields({**self.raw, "price": value})["price"], expected)
        for value in ("NaN", "Infinity", "-1", "1.001", True, "1000000"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_fields({**self.raw, "price": value})

    def test_id_masking_and_existing_mask(self):
        raw = {**self.raw, "id_number": "110101199001011234"}
        self.assertEqual(normalize_fields(raw)["id_number"], "110101********1234")
        self.assertEqual(normalize_fields(raw, mask_id=False)["id_number"], raw["id_number"])
        self.assertEqual(normalize_fields(self.raw)["id_number"], self.raw["id_number"])

    def test_aliases_and_unknown_or_duplicate_fields(self):
        raw = {**self.raw}
        raw["出发站"] = raw.pop("from_station")
        self.assertEqual(normalize_fields(raw)["from_station"], "北京南")
        for bad in ([self.raw], {**self.raw, "unknown": "x"},
                    {**self.raw, "出发站": "北京"}, {**self.raw, "coach": "0"},
                    {**self.raw, "seat": "xx"}, {**self.raw, "train": "bad"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                normalize_fields(bad)

    def test_coach_seat_and_blank_optionals(self):
        data = normalize_fields({**self.raw, "coach": "3车", "seat": "12f号", "gate": None})
        self.assertEqual(data["coach"], "03")
        self.assertEqual(data["seat"], "12F")
        self.assertEqual(data["gate"], "")
        self.assertEqual(normalize_fields({**self.raw, "seat": "无座"})["seat"], "无座")

    def test_eight_templates_render_at_expected_size(self):
        data = normalize_fields(self.raw)
        for style in STYLE_KEYS:
            with self.subTest(style=style):
                image = render_ticket(data, style)
                expected_width = 1618 if style.startswith("blue") else 1600
                self.assertEqual(image.width, expected_width)
                self.assertEqual(image.height, 1018 if style.startswith("blue") else 1070)

    def test_back_and_merge(self):
        data = normalize_fields(self.raw)
        front = render_ticket(data, "blue")
        template = __import__("src.ticket.templates", fromlist=["get_template"]).get_template("blue")
        back = render_back(data, template, {"title": "测试背面"})
        self.assertEqual(back.size, front.size)
        merged = compose_front_back(front, back, template.width)
        self.assertEqual(merged.width, front.width)
        self.assertEqual(merged.height, front.height + back.height + 26 * 2)

    def test_width_and_png_roundtrip(self):
        image = render_ticket(normalize_fields(self.raw), "blue", 800, self.fonts)
        with tempfile.TemporaryDirectory() as directory:
            path = save_ticket(image, Path(directory) / "nested/ticket.png")
            with Image.open(path) as saved:
                self.assertEqual(saved.width, 800)
                self.assertEqual(saved.format, "PNG")
                self.assertEqual(saved.info["Description"], DISCLAIMER)
        with self.assertRaises(ValueError):
            render_ticket(normalize_fields(self.raw), "blue", 100, self.fonts)

    def test_minimal_ticket_leaves_optional_fields_empty(self):
        raw = {k: self.raw[k] for k in ("from_station", "to_station", "train", "date", "time")}
        data = normalize_fields(raw)
        self.assertEqual(data["price"], "")
        self.assertEqual(data["passenger_name"], "")
        self.assertEqual(data["id_number"], "")
        image = render_ticket(data, "blue", 1200, self.fonts)
        self.assertEqual(image.width, 1200)
        image.verify()

    def test_missing_time_is_allowed(self):
        raw = {k: self.raw[k] for k in ("from_station", "to_station", "train", "date")}
        data = normalize_fields(raw)
        self.assertEqual(data["time"], "")
        image = render_ticket(data, "blue", 800, self.fonts)
        self.assertEqual(image.width, 800)
        with self.assertRaises(ValueError):
            normalize_fields({**raw, "time": "25:00"})

    def test_points_json_mapping_skips_non_ride(self):
        fixture = {"records": [
            {"details": [{
                "passenger": "测试乘车人", "travelDate": "2026-09-27",
                "trainCode": "G1071", "from": "昌乐", "to": "潍坊",
                "seat": "二等座", "coach": "03", "orderNo": "E1",
                "kind": "乘车", "queryType": "t",
                "raw": {"seat_type_name": "二等座", "coach_no": "03"},
            }]},
            {"details": [{"kind": "商户消费", "merchant": "某商户"}]},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "points.json"
            path.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
            tickets, warnings = collect_tickets(path)
        self.assertEqual(len(tickets), 1)
        ticket = tickets[0]
        self.assertEqual(ticket["from_station"], "昌乐")
        self.assertEqual(ticket["seat_type"], "二等座")
        self.assertEqual(ticket["seat"], "")
        self.assertEqual(ticket["from_pinyin"], "Changle")
        self.assertEqual(ticket["time"], "")
        self.assertEqual(len(warnings), 1)

    def test_points_csv_mapping_skips_merchant(self):
        header = ["日期", "收支", "积分", "项目", "积分有效期", "车票备注",
                  "乘车人", "乘车日期", "车次", "出发站", "到达站", "区间",
                  "席别", "车厢号", "订单号", "明细类型", "改签/升席积分差值",
                  "手续费", "商户名称", "流水类型", "流水ID"]
        base = {key: "" for key in header}
        ride = {**base, "日期": "2026-10-01", "乘车人": "测试乘车人",
                "乘车日期": "2026-09-27", "车次": "G1071", "出发站": "昌乐",
                "到达站": "潍坊", "席别": "二等座", "车厢号": "03",
                "订单号": "E1", "明细类型": "乘车"}
        merchant = {**base, "日期": "2026-09-01", "收支": "支出", "乘车人": "",
                    "明细类型": "商户消费", "商户名称": "某商户"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "points.csv"
            with path.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=header)
                writer.writeheader()
                writer.writerow(ride)
                writer.writerow(merchant)
            tickets, warnings = collect_tickets(path)
        self.assertEqual(len(tickets), 1)
        self.assertEqual(tickets[0]["seat_type"], "二等座")
        self.assertEqual(tickets[0]["to_pinyin"], "Weifang")
        self.assertEqual(len(warnings), 1)

    def test_points_batch_cli_and_index_override(self):
        fixture = {"records": [{"details": [
            {"passenger": "测试乘车人", "travelDate": "2026-09-27",
             "trainCode": "G1071", "from": "昌乐", "to": "潍坊",
             "seat": "二等座", "coach": "03", "kind": "乘车", "raw": {}},
            {"passenger": "测试乘车人", "travelDate": "2026-09-25",
             "trainCode": "G2050", "from": "潍坊", "to": "昌乐",
             "seat": "二等座", "coach": "02", "kind": "乘车", "raw": {}},
        ]}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "points.json"
            path.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
            out = Path(directory) / "out"
            command = [sys.executable, str(ROOT / "scripts/generate-ticket.py"),
                       "--points", str(path), "--style", "blue", "--width", "600",
                       "--output-dir", str(out)]
            result = subprocess.run(command + ["--limit", "1"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(list(out.glob("*.png"))), 1)
            override_out = Path(directory) / "override"
            override_command = command[:-1] + [str(override_out)]
            result = subprocess.run(override_command + ["--index", "1", "--time", "10:35",
                                                        "--seat", "02A", "--price", "57"],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(list(override_out.glob("*.png"))), 1)

    def test_cli_all_styles(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "all.png"
            result = subprocess.run([sys.executable, str(ROOT / "scripts/generate-ticket.py"),
                                     "--data", str(ROOT / "examples/ticket.json"), "--style", "all",
                                     "--width", "800", "--output", str(output)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for style in STYLE_KEYS:
                self.assertTrue(output.with_name("all-" + style + ".png").is_file(), style)

    def test_cli_both_from_other_directory_and_override(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "test.png"
            result = subprocess.run([sys.executable, str(ROOT / "scripts/generate-ticket.py"),
                                     "--data", str(ROOT / "examples/ticket.json"), "--style", "both",
                                     "--date", "2024-02-29", "--width", "800", "--output", str(output)],
                                    cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.with_name("test-blue.png").is_file())
            self.assertTrue(output.with_name("test-pink.png").is_file())
            result = subprocess.run([sys.executable, str(ROOT / "scripts/generate-ticket.py"),
                                     "--data", str(ROOT / "examples/ticket.json"), "--date", "2025-02-29",
                                     "--output", str(output)], cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
