/** 表单规范化与导出前校验：不依赖 DOM，可在 Node 里单测。 */

export const DEFAULT_QR = 'https://www.12306.cn/';
export const STYLE_KEYS = [
  'blue',
  'blue-paper',
  'blue-mag',
  'blue-etch',
  'blue-etch-mag',
  'red',
  'red-paper',
  'red-mag',
];

const FIELD_LIMITS = {
  ticketNo: 24,
  checkinRoom: 20,
  startStation: 12,
  startStationPY: 40,
  endStation: 12,
  endStationPY: 40,
  trainNo: 8,
  seatClass: 12,
  carriageNo: 2,
  seatNo: 6,
  seatPosition: 4,
  price: 12,
  identity: 32,
  name: 24,
  info2: 40,
  machineId: 40,
  qrcodeString: 512,
};

export function maskIdentity(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.includes('*')) return text.slice(0, FIELD_LIMITS.identity);
  if (text.length > 10) {
    return (text.slice(0, 6) + '*'.repeat(text.length - 10) + text.slice(-4)).slice(0, FIELD_LIMITS.identity);
  }
  return '*'.repeat(text.length);
}

export function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const [year, month, day] = text.split('-').map(Number);
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return '';
  return text;
}

export function normalizeTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

export function normalizeTrain(value) {
  const text = String(value ?? '').toUpperCase().replace(/次$/, '').replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{0,2}\d{1,5}$/.test(text) ? text : '';
}

export function normalizeStation(value) {
  return String(value ?? '').trim().replace(/站$/, '').slice(0, 6);
}

export function normalizeCoach(value) {
  const text = String(value ?? '').trim().replace(/车$/, '');
  if (!text) return { value: '', error: '' };
  if (!/^\d{1,2}$/.test(text)) return { value: '', error: '车厢应为 1–99 的数字' };
  const number = Number(text);
  if (number < 1 || number > 99) return { value: '', error: '车厢应为 1–99 的数字' };
  return { value: String(number).padStart(2, '0'), error: '' };
}

export function normalizeSeat(value) {
  const text = String(value ?? '').trim().toUpperCase().replace(/号$/, '');
  if (!text) return { value: '', error: '' };
  if (text === '无座') return { value: '无座', error: '' };
  if (!/^\d{1,3}[A-F]?$/.test(text)) return { value: '', error: '座位应类似 11F、086 或 无座' };
  return { value: text, error: '' };
}

export function normalizePrice(value) {
  const text = String(value ?? '').trim().replace(/[￥¥元]/g, '');
  if (!text) return { value: '', error: '' };
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return { value: '', error: '票价应为非负金额，最多两位小数' };
  const number = Number(text);
  if (!Number.isFinite(number) || number > 999999.99) return { value: '', error: '票价超出范围' };
  return { value: number.toFixed(1), error: '' };
}

function pick(value, limit) {
  const text = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return text.slice(0, limit);
}

/**
 * 返回 { value, errors }。value 是可直接交给渲染器的规范化副本。
 * errors 是 { field: message }，供 UI 标红；为空数组表示可导出。
 */
export function normalizeTicket(draft, { maskId = true } = {}) {
  const errors = {};
  const value = {
    ...draft,
    style: STYLE_KEYS.includes(draft?.style) ? draft.style : 'blue',
    startStation: normalizeStation(draft?.startStation),
    endStation: normalizeStation(draft?.endStation),
    startStationPY: pick(draft?.startStationPY, FIELD_LIMITS.startStationPY),
    endStationPY: pick(draft?.endStationPY, FIELD_LIMITS.endStationPY),
    trainNo: normalizeTrain(draft?.trainNo),
    date: normalizeDate(draft?.date),
    time: normalizeTime(draft?.time),
    seatClass: pick(draft?.seatClass, FIELD_LIMITS.seatClass),
    identity: maskId ? maskIdentity(draft?.identity) : pick(draft?.identity, FIELD_LIMITS.identity),
    name: pick(draft?.name, FIELD_LIMITS.name),
    ticketNo: pick(draft?.ticketNo, FIELD_LIMITS.ticketNo),
    checkinRoom: pick(draft?.checkinRoom, FIELD_LIMITS.checkinRoom),
    machineId: pick(draft?.machineId, FIELD_LIMITS.machineId),
    info2: pick(draft?.info2 ?? '仅供纪念使用', FIELD_LIMITS.info2),
    qrcodeString: pick(draft?.qrcodeString, FIELD_LIMITS.qrcodeString) || DEFAULT_QR,
  };

  if (!value.startStation) errors.startStation = '请填写始发站';
  if (!value.endStation) errors.endStation = '请填写到达站';
  if (!value.trainNo) errors.trainNo = '车次应类似 G2884、C2021、K42';
  if (!value.date) errors.date = '请选择有效日期';
  if (draft?.time && !value.time) errors.time = '时间格式应为 HH:MM';

  const coach = normalizeCoach(draft?.carriageNo);
  const seat = normalizeSeat(draft?.seatNo);
  const price = normalizePrice(draft?.price);
  if (coach.error) errors.carriageNo = coach.error;
  if (seat.error) errors.seatNo = seat.error;
  if (price.error) errors.price = price.error;
  value.carriageNo = coach.value;
  value.seatNo = seat.value;
  value.price = price.value;

  const flags = draft?.flags || {};
  value.flags = {
    child: Boolean(flags.child),
    student: Boolean(flags.student),
    online: Boolean(flags.online),
    discount: Boolean(flags.discount),
  };
  value.fontScale = Math.min(1.3, Math.max(0.8, Number(draft?.fontScale) || 1));
  value.fontWeight = [400, 500, 600, 700, 800].includes(Number(draft?.fontWeight))
    ? Number(draft.fontWeight)
    : 500;
  value.fontScheme = {
    zh: pick(draft?.fontScheme?.zh, 40),
    en: pick(draft?.fontScheme?.en, 40),
    num: pick(draft?.fontScheme?.num, 40),
  };
  value.info1 = ['0', '1', '2', '9'].includes(String(draft?.info1)) ? String(draft.info1) : '0';
  value.info3 = ['0', '1', '2', '9'].includes(String(draft?.info3)) ? String(draft.info3) : '0';
  value.qrEnabled = draft?.qrEnabled !== false;
  value.back = draft?.back || null;

  return { value, errors };
}

export function hasErrors(errors) {
  return Object.keys(errors).length > 0;
}

export function defaultDraft() {
  return {
    id: `trip-${Date.now().toString(36)}`,
    style: 'blue',
    ticketNo: '',
    checkinRoom: '',
    startStation: '',
    startStationPY: '',
    endStation: '',
    endStationPY: '',
    trainNo: '',
    seatClass: '二等座',
    date: '',
    time: '',
    carriageNo: '',
    seatNo: '',
    seatPosition: '',
    price: '',
    identity: '',
    name: '',
    info1: '0',
    info2: '仅供纪念使用',
    info3: '0',
    machineId: '',
    qrcodeString: DEFAULT_QR,
    qrEnabled: true,
    flags: { child: false, student: false, online: false, discount: false },
    fontScale: 1,
    fontWeight: 500,
    fontScheme: { zh: '', en: '', num: '' },
    back: null,
    source: 'manual',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function demoDraft() {
  const draft = defaultDraft();
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  Object.assign(draft, {
    ticketNo: 'E123456789',
    checkinRoom: '12B',
    startStation: '北京南',
    startStationPY: 'Beijingnan',
    endStation: '天津西',
    endStationPY: 'Tianjinxi',
    trainNo: 'G2884',
    seatClass: '二等座',
    date,
    time: '10:24',
    carriageNo: '02',
    seatNo: '11F',
    price: '381.0',
    identity: '110101********1234',
    name: '李某某',
    info1: '2',
    info2: '仅供纪念使用',
    info3: '0',
    machineId: '北京南站 001',
    source: 'demo',
  });
  return draft;
}
