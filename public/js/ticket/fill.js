/**
 * PDF 回填状态机：
 * ① 自动回填；② 手动优先；③ 非空优先。
 * 纯函数，便于单测。
 */

export const TEXT_FIELDS = [
  'ticketNo',
  'checkinRoom',
  'startStation',
  'startStationPY',
  'endStation',
  'endStationPY',
  'trainNo',
  'seatClass',
  'date',
  'time',
  'carriageNo',
  'seatNo',
  'seatPosition',
  'price',
  'identity',
  'name',
  'machineId',
  'qrcodeString',
];

export function createOrigins() {
  return Object.create(null);
}

export function markManual(origins, field) {
  if (field) origins[field] = 'manual';
}

export function applyParsed({ draft, origins, parsed, pinyinFor = () => '', defaultQr = 'https://www.12306.cn/' }) {
  const next = { ...draft, flags: { ...(draft.flags || {}) } };
  const nextOrigins = { ...origins };
  const changed = [];
  if (!parsed || typeof parsed !== 'object') return { draft: next, origins: nextOrigins, changed };

  const incoming = { ...parsed };
  if (incoming.qrcodeContent && !incoming.qrcodeString) incoming.qrcodeString = incoming.qrcodeContent;

  for (const field of TEXT_FIELDS) {
    const value = incoming[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (nextOrigins[field] === 'manual') continue;
    next[field] = String(value).trim();
    nextOrigins[field] = 'pdf';
    changed.push(field);
  }

  // 二维码兜底：PDF 没给、用户也没手动清空时，恢复官网默认链接。
  if (!next.qrcodeString && nextOrigins.qrcodeString !== 'manual') {
    next.qrcodeString = defaultQr;
    nextOrigins.qrcodeString = 'pdf';
    changed.push('qrcodeString');
  }

  // 拼音联动：只有 PDF 改了站名才动拼音；用户手改过拼音则跳过。
  for (const [stationField, pinyinField] of [
    ['startStation', 'startStationPY'],
    ['endStation', 'endStationPY'],
  ]) {
    if (!changed.includes(stationField)) continue;
    if (nextOrigins[pinyinField] === 'manual') continue;
    const py = pinyinFor(next[stationField]) || '';
    if (next[pinyinField] !== py) {
      next[pinyinField] = py;
      nextOrigins[pinyinField] = 'pdf';
      changed.push(pinyinField);
    }
  }

  const flags = parsed.flags || {};
  for (const key of ['child', 'student', 'online', 'discount']) {
    if (typeof flags[key] !== 'boolean') continue;
    if (nextOrigins[key] === 'manual') continue;
    if (next.flags[key] !== flags[key]) {
      next.flags[key] = flags[key];
      changed.push(key);
    }
    nextOrigins[key] = 'pdf';
  }

  if (parsed.infoline1 !== undefined && nextOrigins.info1 !== 'manual') {
    const value = String(parsed.infoline1);
    if (next.info1 !== value) {
      next.info1 = value;
      changed.push('info1');
    }
    nextOrigins.info1 = 'pdf';
  }

  next.updatedAt = new Date().toISOString();
  return { draft: next, origins: nextOrigins, changed };
}

export function fieldOriginLabel(origin) {
  if (origin === 'manual') return '手动';
  if (origin === 'pdf') return 'PDF';
  return '默认';
}
