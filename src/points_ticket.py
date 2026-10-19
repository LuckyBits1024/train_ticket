"""把 12306 积分导出（本项目 JSON / CSV）适配成纪念车票字段。

积分明细本身只有：出发/到达站、车次、乘车日期、车厢、席别、乘车人。
发车时间、座位号、票价、检票口、票号、出票车站、渠道在积分接口里没有，
这里一律留空，不伪造。站点拼音从 src/data/stations-pinyin.json 查表补齐。
"""

import csv
import json
import re
from pathlib import Path

from .ticket_image import LIMITS

ROOT = Path(__file__).resolve().parents[1]
PINYIN_FILE = ROOT / "src" / "data" / "stations-pinyin.json"
SEAT_FILE = ROOT / "src" / "data" / "seats.json"

_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})")
_PRICE_RE = re.compile(r"[0-9]+(?:\.[0-9]{1,2})?")


def _load_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def load_pinyin():
    return _load_json(PINYIN_FILE, {})


def load_seat_names():
    return _load_json(SEAT_FILE, {})


def _text(value):
    return str(value).strip() if value is not None else ""


def _first(mapping, keys):
    for key in keys:
        value = mapping.get(key)
        if value is not None and value != "":
            return _text(value)
    return ""


def _compact_date(value):
    text = _text(value)
    if re.fullmatch(r"[0-9]{8}", text):
        return "{}-{}-{}".format(text[:4], text[4:6], text[6:8])
    match = re.match(r"([0-9]{4})-([0-9]{2})-([0-9]{2})", text)
    return "{}-{}-{}".format(*match.groups()) if match else text


def _time_from_raw(raw, detail):
    value = _text(detail.get("time")) or _first(
        raw, ("start_time", "train_start_time", "depart_time", "departure_time",
              "startTime", "departTime", "发车时间")
    )
    match = _TIME_RE.search(value)
    if not match:
        return ""
    hour, minute = int(match.group(1)), int(match.group(2))
    if 0 <= hour <= 23 and 0 <= minute <= 59:
        return "{:02d}:{:02d}".format(hour, minute)
    return ""


def _fits(value, field):
    return value if len(value) <= LIMITS.get(field, 30) else ""


def _station_pinyin(name, pinyins):
    name = _text(name).removesuffix("站")
    return pinyins.get(name, "")


def _ticket_from_detail(detail, pinyins, seats):
    raw = detail.get("raw") if isinstance(detail.get("raw"), dict) else {}

    from_station = (_text(detail.get("from")) or _text(detail.get("from_station"))
                    or _first(raw, ("board_station_name", "resign_board_station_name")))
    to_station = (_text(detail.get("to")) or _text(detail.get("to_station"))
                  or _first(raw, ("arrive_station_name", "resign_arrive_station_name")))
    train = (_text(detail.get("trainCode")) or _text(detail.get("train"))
             or _first(raw, ("station_train_code", "resign_station_train_code"))).removesuffix("次")
    date = _compact_date(
        _text(detail.get("travelDate")) or _text(detail.get("date"))
        or _first(raw, ("train_date", "resign_train_date"))
    )
    coach = _text(detail.get("coach")) or _first(raw, ("coach_no", "resign_coach_no"))
    passenger = (_text(detail.get("passenger")) or _text(detail.get("passenger_name"))
                 or _first(raw, ("v_assignee_id_name", "passenger_name")))

    # 本项目归一化后的 detail.seat 是「席别名称」，不是座位号；
    # 只有显式提供 seat_type 时，seat 才被当作座位号（如 02A）。
    explicit_type = _text(detail.get("seat_type"))
    seat_type = (explicit_type or _text(detail.get("seat"))
                 or _first(raw, ("seat_type_name", "resign_seat_type_name")))
    seat_number = (_text(detail.get("seat")) if explicit_type
                   else _first(raw, ("seat_no", "seat_number", "seatNo", "seatNumber")))
    if not explicit_type and re.fullmatch(r"[0-9]{1,3}[A-Fa-f]?", seat_type or ""):
        seat_number = seat_number or seat_type
        seat_type = _first(raw, ("seat_type_name", "resign_seat_type_name"))
    if not seat_type:
        code = _first(raw, ("seat_type_code", "resign_seat_type_code"))
        seat_type = seats.get(code, code) if code else ""

    price = _text(detail.get("price")) or _first(
        raw, ("ticket_price", "sale_price", "ticketPrice", "salePrice")
    )
    if not _PRICE_RE.fullmatch(price):
        price = ""

    ticket_number = _text(detail.get("ticket_number")) or _first(
        raw, ("ticket_no", "ticket_number", "ticketNo")
    )
    serial_number = _text(detail.get("serial_number")) or _first(
        raw, ("serial_no", "serial_number", "ticket_serial")
    )
    issuing_station = _text(detail.get("issuing_station")) or _first(
        raw, ("issuing_station", "sale_station_name", "sale_station")
    )
    gate = _text(detail.get("gate")) or _first(raw, ("gate", "check_gate", "gate_no"))
    channel = _text(detail.get("channel")) or _first(raw, ("channel", "sale_channel"))

    return {
        "from_station": from_station,
        "to_station": to_station,
        "from_pinyin": _text(detail.get("from_pinyin")) or _station_pinyin(from_station, pinyins),
        "to_pinyin": _text(detail.get("to_pinyin")) or _station_pinyin(to_station, pinyins),
        "train": train,
        "date": date,
        "time": _time_from_raw(raw, detail),
        "coach": coach,
        "seat": seat_number,
        "seat_type": seat_type,
        "price": price,
        "passenger_name": passenger,
        "id_number": _text(detail.get("id_number")),
        "gate": _fits(gate, "gate"),
        "ticket_number": _fits(ticket_number, "ticket_number"),
        "serial_number": _fits(serial_number, "serial_number"),
        "issuing_station": _fits(issuing_station, "issuing_station"),
        "channel": _fits(channel, "channel"),
    }


def _is_ride(detail):
    kind = _text(detail.get("kind"))
    if kind == "商户消费" or detail.get("merchant"):
        return False
    return bool(
        (_text(detail.get("trainCode")) or _first(detail.get("raw") or {}, ("station_train_code",)))
        and (_text(detail.get("travelDate")) or _first(detail.get("raw") or {}, ("train_date",)))
    )


def _from_json(data, pinyins, seats):
    if isinstance(data, dict):
        records = data.get("records") if isinstance(data.get("records"), list) else [data]
    elif isinstance(data, list):
        records = data
    else:
        raise ValueError("JSON 必须是对象或数组")

    tickets, warnings = [], []
    for index, record in enumerate(records, 1):
        if not isinstance(record, dict):
            warnings.append("第 {} 条不是对象，已跳过".format(index))
            continue
        details = record.get("details")
        if isinstance(details, list) and details:
            for detail in details:
                if not isinstance(detail, dict):
                    warnings.append("第 {} 条明细不是对象，已跳过".format(index))
                    continue
                if not _is_ride(detail):
                    warnings.append("第 {} 条不是乘车记录（{}），已跳过".format(
                        index, detail.get("kind") or "商户消费"))
                    continue
                tickets.append(_ticket_from_detail(detail, pinyins, seats))
        elif isinstance(record, dict) and any(
            key in record for key in ("from_station", "from", "trainCode", "train")
        ):
            tickets.append(_ticket_from_detail(record, pinyins, seats))
        else:
            reason = _text(record.get("detailError"))
            warnings.append("第 {} 条没有乘车明细{}，已跳过".format(
                index, "（{}）".format(reason) if reason else ""))
    return tickets, warnings


def _from_csv(path, pinyins, seats):
    tickets, warnings = [], []
    with Path(path).open(encoding="utf-8-sig", newline="") as handle:
        for index, row in enumerate(csv.DictReader(handle), 1):
            if not _text(row.get("乘车人")) and not _text(row.get("车次")):
                warnings.append("第 {} 行没有乘车人/车次，已跳过".format(index))
                continue
            detail = {
                "passenger": row.get("乘车人"),
                "travelDate": row.get("乘车日期"),
                "trainCode": row.get("车次"),
                "from": row.get("出发站"),
                "to": row.get("到达站"),
                "seat": row.get("席别"),
                "coach": row.get("车厢号"),
                "kind": row.get("明细类型"),
                "orderNo": row.get("订单号"),
            }
            if _text(row.get("明细类型")) == "商户消费":
                warnings.append("第 {} 行是商户消费，已跳过".format(index))
                continue
            ticket = _ticket_from_detail(detail, pinyins, seats)
            if not (ticket["from_station"] and ticket["to_station"]
                    and ticket["train"] and ticket["date"]):
                warnings.append("第 {} 行缺少出发站/到达站/车次/日期，已跳过".format(index))
                continue
            tickets.append(ticket)
    return tickets, warnings


def collect_tickets(path):
    """读取积分 JSON/CSV，返回 (tickets, warnings)。tickets 已映射为车票字段。"""
    path = Path(path).expanduser()
    if not path.is_file():
        raise ValueError("找不到积分导出文件：{}".format(path))
    suffix = path.suffix.lower()
    pinyins, seats = load_pinyin(), load_seat_names()
    if suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        return _from_json(data, pinyins, seats)
    if suffix == ".csv":
        return _from_csv(path, pinyins, seats)
    raise ValueError("--points 只支持 .json 或 .csv（12306 积分导出文件）")


def ticket_label(ticket, index=None):
    prefix = "{:03d} ".format(index) if index else ""
    return "{}{} {} {}→{}".format(
        prefix, ticket.get("date", ""), ticket.get("train", ""),
        ticket.get("from_station", ""), ticket.get("to_station", ""),
    )


def output_name(ticket, index, style=None):
    def slug(value):
        value = re.sub(r'[\\/:*?"<>|\s]+', "-", _text(value)).strip("-")
        return value[:40] or "ticket"

    base = "{}_{}_{}-{}_{:03d}".format(
        ticket.get("date", "date"), slug(ticket.get("train")),
        slug(ticket.get("from_station")), slug(ticket.get("to_station")), index,
    )
    return base + ("-" + style if style else "") + ".png"
