import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTextModel,
  parseInvoice,
  parseItinerary,
  parsePdfText,
} from '../../public/js/ticket/pdf.js';

const itineraryGrid = [
  '北京南        天津西',
  '站            站',
  'G2884',
  '2026年09月16日 10:24开',
  '02车11F号 二等座',
  '检票口 12B',
  '订单号 E123456789',
  '电子票号 123456789012345678901',
  '票价 381.0元',
  '李某某 110101********1234',
  '生成时间 2026-10-01 12:00:00',
  'https://e.12306.cn/orderId/abc123',
];
const itinerary = {
  text: itineraryGrid.join('\n'),
  gridLines: itineraryGrid,
  gridYs: itineraryGrid.map((_, index) => 700 - index * 20),
};

test('itinerary parses core fields', () => {
  const parsed = parseItinerary(itinerary);
  assert.equal(parsed.kind, 'itinerary');
  assert.equal(parsed.trainNo, 'G2884');
  assert.equal(parsed.startStation, '北京南');
  assert.equal(parsed.endStation, '天津西');
  assert.equal(parsed.date, '2026-09-16');
  assert.equal(parsed.time, '10:24');
  assert.equal(parsed.carriageNo, '02');
  assert.equal(parsed.seatNo, '11F');
  assert.equal(parsed.seatClass, '二等座');
  assert.equal(parsed.checkinRoom, '12B');
  assert.equal(parsed.name, '李某某');
  assert.equal(parsed.identity, '110101********1234');
  assert.equal(parsed.ticketNo, 'E123456789');
  assert.equal(parsed.machineId, '123456789012345678901');
  assert.equal(parsed.price, '381.0');
  assert.equal(parsed.qrcodeContent, 'https://e.12306.cn/orderId/abc123');
  assert.equal(parsed.date !== '2026-10-01', true);
});

test('new checkin gate formats are recognized', () => {
  for (const [text, expected] of [
    ['检票口 21A', '21A'],
    ['检票口 24A25A', '24A25A'],
    ['检票口 候车室5', '候车室5'],
    ['呈贡昆明南站 1B检票口', '1B'],
  ]) {
    const model = {
      text,
      gridLines: [text],
      gridYs: [1],
    };
    assert.equal(parseItinerary(model).checkinRoom, expected, text);
  }
});

const invoiceText = [
  '电子发票（铁路电子客票）',
  '发票号码: 12345678901234567890 开票日期: 2026年10月01日',
  '北京南 站 G2884 天津西 站',
  'Beijingnan Tianjinxi',
  '2026年09月16日 10:24开 02车11F号 二等座',
  '票价: ￥381.00',
  '110101********1234 李某某',
  '电子客票号: 123456789012345678901',
  '购买方名称: 李某某',
].join('\n');

test('invoice parses and avoids invoice date', () => {
  const parsed = parseInvoice({ text: invoiceText });
  assert.equal(parsed.kind, 'invoice');
  assert.equal(parsed.startStation, '北京南');
  assert.equal(parsed.endStation, '天津西');
  assert.equal(parsed.date, '2026-09-16');
  assert.equal(parsed.time, '10:24');
  assert.equal(parsed.ticketNo, '12345678901234567890');
  assert.equal(parsed.machineId, '123456789012345678901');
  assert.equal(parsed.name, '李某某');
  assert.equal(parsed.price, '381.0');
});

test('parsePdfText detects invoice', () => {
  const parsed = parsePdfText({ text: invoiceText });
  assert.equal(parsed.kind, 'invoice');
  assert.equal(parsed.date, '2026-09-16');
});

test('buildTextModel groups rows by y and keeps order', () => {
  const items = [
    { str: '北京南', transform: [1, 0, 0, 1, 20, 700], width: 30 },
    { str: '天津西', transform: [1, 0, 0, 1, 300, 700], width: 30 },
    { str: 'G2884', transform: [1, 0, 0, 1, 150, 670], width: 40 },
  ];
  const model = buildTextModel(items);
  assert.equal(model.gridLines[0].includes('北京南'), true);
  assert.equal(model.gridLines[0].includes('天津西'), true);
  assert.equal(model.gridLines[1], 'G2884');
});

test('station fallback without tag line', () => {
  const gridLines = ['北京南 天津西', 'G2884', '2026年09月16日 10:24开'];
  const parsed = parseItinerary({ text: gridLines.join('\n'), gridLines });
  assert.equal(parsed.startStation, '北京南');
  assert.equal(parsed.endStation, '天津西');
});

test('invoice station fallback without spaces around train', () => {
  const text = '电子发票 发票号码: 12345678901234567890 北京南站G2884天津西站 2026年09月16日 10:24开';
  const parsed = parseInvoice({ text });
  assert.equal(parsed.startStation, '北京南');
  assert.equal(parsed.endStation, '天津西');
  assert.equal(parsed.trainNo, 'G2884');
});

test('CJK radicals from PDF ToUnicode are normalized', () => {
  const gridLines = ['北京南 天津⻄', '站 站', 'G2884', '2026年09月16日 10:24开', '02⻋11F号 二等座'];
  const parsed = parseItinerary({ text: gridLines.join('\n'), gridLines });
  assert.equal(parsed.endStation, '天津西');
  assert.equal(parsed.carriageNo, '02');
  assert.equal(parsed.seatNo, '11F');
  assert.equal(parsed.seatClass, '二等座');
});
