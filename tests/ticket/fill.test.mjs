import test from 'node:test';
import assert from 'node:assert/strict';
import { applyParsed, createOrigins, markManual } from '../../public/js/ticket/fill.js';
import { demoDraft } from '../../public/js/ticket/validate.js';

const pinyinFor = (name) => ({ 北京南: 'Beijingnan', 天津西: 'Tianjinxi', 上海虹桥: 'Shanghaihongqiao' }[name] || '');

test('auto fill sets values and origin pdf', () => {
  const draft = demoDraft();
  const origins = createOrigins();
  const result = applyParsed({
    draft,
    origins,
    parsed: { checkinRoom: '8A', price: '55.5', startStation: '上海虹桥' },
    pinyinFor,
  });
  assert.equal(result.draft.checkinRoom, '8A');
  assert.equal(result.draft.price, '55.5');
  assert.equal(result.draft.startStationPY, 'Shanghaihongqiao');
  assert.equal(result.origins.checkinRoom, 'pdf');
});

test('manual wins over later pdf import', () => {
  const draft = demoDraft();
  const origins = createOrigins();
  markManual(origins, 'price');
  const result = applyParsed({ draft, origins, parsed: { price: '999' }, pinyinFor });
  assert.equal(result.draft.price, '381.0');
});

test('empty pdf value does not overwrite', () => {
  const draft = demoDraft();
  const origins = createOrigins();
  const result = applyParsed({ draft, origins, parsed: { name: '', price: undefined }, pinyinFor });
  assert.equal(result.draft.name, '李某某');
  assert.equal(result.draft.price, '381.0');
});

test('qr falls back only when empty and not manual', () => {
  const draft = { ...demoDraft(), qrcodeString: '' };
  const origins = createOrigins();
  const result = applyParsed({ draft, origins, parsed: {}, pinyinFor, defaultQr: 'https://www.12306.cn/' });
  assert.equal(result.draft.qrcodeString, 'https://www.12306.cn/');

  const draft2 = { ...demoDraft(), qrcodeString: '' };
  const origins2 = createOrigins();
  markManual(origins2, 'qrcodeString');
  const result2 = applyParsed({ draft: draft2, origins: origins2, parsed: {}, pinyinFor });
  assert.equal(result2.draft.qrcodeString, '');
});

test('qrcodeContent maps to qrcodeString', () => {
  const draft = demoDraft();
  const result = applyParsed({
    draft,
    origins: createOrigins(),
    parsed: { qrcodeContent: 'https://e.12306.cn/orderId/abc' },
    pinyinFor,
  });
  assert.equal(result.draft.qrcodeString, 'https://e.12306.cn/orderId/abc');
});
