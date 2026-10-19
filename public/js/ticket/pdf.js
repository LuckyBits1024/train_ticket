/**
 * 12306 行程信息提示 / 铁路电子发票解析。
 * 纯解析函数可被 Node 单测；extractPdf 只在浏览器里调用。
 */

let pdfEnginePromise = null;

// PDF 的 ToUnicode 有时会把汉字映射成 CJK Radicals Supplement（U+2E80–U+2EFF）。
// NFKC 只能处理一部分，这里补一张常用部首表，避免站名/“车”字识别失败。
const CJK_RADICALS = {
  '⻄': '西', '⻅': '见', '⻆': '角', '⻇': '角', '⻈': '讠', '⻉': '贝', '⻊': '足',
  '⻋': '车', '⻌': '辶', '⻍': '辶', '⻎': '辶', '⻏': '阝', '⻐': '钅', '⻑': '长',
  '⻒': '镸', '⻓': '长', '⻔': '门', '⻕': '阝', '⻖': '阝', '⻗': '雨', '⻘': '青',
  '⻙': '韦', '⻚': '页', '⻛': '风', '⻜': '飞', '⻝': '食', '⻞': '食', '⻟': '食',
  '⻠': '饣', '⻡': '饣', '⻢': '马', '⻣': '骨', '⻤': '鬼', '⻥': '鱼', '⻦': '鸟',
  '⻧': '卤', '⻨': '麦', '⻩': '黄', '⻪': '黾', '⻫': '齐', '⻬': '齐', '⻭': '齿',
  '⻮': '齿', '⻯': '龙', '⻰': '龙', '⻱': '龟', '⻲': '龟', '⻳': '龟',
};

function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u2E80-\u2EFF]/g, (char) => CJK_RADICALS[char] || char);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`脚本加载失败：${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = '1';
      resolve();
    });
    script.addEventListener('error', () => reject(new Error(`脚本加载失败：${src}`)), { once: true });
    document.head.appendChild(script);
  });
}

export async function loadPdfEngine() {
  if (window.pdfjsLib) return window.pdfjsLib;
  if (!pdfEnginePromise) {
    pdfEnginePromise = loadScript('/js/vendor/pdfjs/pdf.min.js')
      .then(() => {
        const lib = window.pdfjsLib;
        if (!lib) throw new Error('pdf.js 未初始化');
        lib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs/pdf.worker.min.js';
        return lib;
      })
      .catch((error) => {
        pdfEnginePromise = null;
        throw error;
      });
  }
  return pdfEnginePromise;
}

/** 把 pdf.js 的 textContent.items 按 y 聚成行。 */
export function buildTextModel(items) {
  const rows = [];
  for (const item of items || []) {
    const text = normalizeText(item?.str);
    if (!text.trim()) continue;
    const transform = item.transform || [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const height = Math.abs(Number(transform[3]) || item.height || 10);
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2.2, height * 0.25));
    if (!row) {
      row = { y, height, items: [] };
      rows.push(row);
    }
    row.items.push({ text, x, width: Number(item.width) || 0 });
  }
  rows.sort((a, b) => b.y - a.y);
  const gridLines = [];
  const gridYs = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let line = '';
    let previousEnd = null;
    for (const item of row.items) {
      if (previousEnd !== null && item.x - previousEnd > 1.5) line += ' ';
      line += item.text;
      previousEnd = item.x + item.width;
    }
    const cleaned = normalizeText(line).replace(/\s+/g, ' ').trim();
    if (cleaned) {
      gridLines.push(cleaned);
      gridYs.push(row.y);
    }
  }
  return { text: gridLines.join('\n'), gridLines, gridYs };
}

function cleanStation(value) {
  return String(value || '').replace(/\s+/g, '').replace(/站$/, '');
}

function validDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || y < 1900 || y > 2100) return '';
  if (!Number.isInteger(m) || m < 1 || m > 12) return '';
  if (!Number.isInteger(d) || d < 1 || d > 31) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function cleanTime(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseStations(text, gridLines) {
  if (Array.isArray(gridLines)) gridLines = gridLines.map(normalizeText);
  let start = '';
  let end = '';
  if (Array.isArray(gridLines)) {
    const tagIndex = gridLines.findIndex((line) => /^\s*(站\s*)+$/.test(line));
    if (tagIndex > 0) {
      const names = (gridLines[tagIndex - 1] || '')
        .trim()
        .split(/\s+/)
        .filter((word) => /^[\u4e00-\u9fa5]{2,6}$/.test(word));
      if (names.length >= 2) {
        start = names[0];
        end = names[1];
      }
    }
    if (!start || !end) {
      const pinyinLine = gridLines.find((line) => {
        const words = line.trim().split(/\s+/).filter((word) => /^[A-Za-z]{2,}$/.test(word));
        return words.length >= 2;
      });
      if (pinyinLine) {
        const words = pinyinLine.trim().split(/\s+/).filter((word) => /^[A-Za-z]{2,}$/.test(word));
        start = start || words[0];
        end = end || words[1];
      }
    }
  }
  if (!start || !end) {
    const matches = [...text.matchAll(/([\u4e00-\u9fa5]{2,6})\s*站(?![\u4e00-\u9fa5])/g)];
    const names = [];
    for (const match of matches) {
      const name = match[1];
      if (!names.includes(name)) names.push(name);
    }
    if (!start && names[0]) start = names[0];
    if (!end && names[1]) end = names[1];
  }
  if ((!start || !end) && Array.isArray(gridLines)) {
    // 有些 PDF 不含“站 站”标签行，只有“北京南 天津西”这一行。
    const stop = gridLines.findIndex((line) => /\d{4}\s*年|[GCDTKZ]\d{3,5}/.test(line));
    const candidates = (stop > 0 ? gridLines.slice(0, stop) : gridLines).filter(
      (line) => !/检票|订单|电子|票价|温馨提示|生成|发票|购买方|票价|席别|车厢|座位/.test(line),
    );
    for (const line of candidates) {
      const words = line
        .trim()
        .split(/\s+/)
        .filter((word) => /^[\u4e00-\u9fa5]{2,6}$/.test(word));
      if (words.length >= 2) {
        if (!start) start = words[0];
        if (!end) end = words[1];
        break;
      }
    }
  }
  return { startStation: cleanStation(start), endStation: cleanStation(end) };
}

function parseCheckin(text) {
  const waiting = text.match(/检票口\s*(候车室\s*\d+)/);
  if (waiting) return waiting[1].replace(/\s+/g, '');
  let match = text.match(
    /([\u4e00-\u9fa5]{1,12}站?)\s*(\d{1,2}(?:[A-Za-z]\d{0,2}[A-Za-z]?\d{0,2}|号|室)?)\s*检票口/,
  );
  if (match) return `${match[2] || ''}`.trim();
  match = text.match(/检票口\s*([\u4e00-\u9fa5]{1,12}站?)\s*(\d{1,2}(?:[A-Za-z]\d{0,2}[A-Za-z]?\d{0,2}|号|室)?)?/);
  if (match) return `${match[2] || match[1] || ''}`.trim();
  match = text.match(/检票口\s*([A-Za-z]?\d{1,2}[A-Za-z]?\d{0,2}[A-Za-z]?\d{0,2})(?![A-Za-z0-9])(?!车)/);
  if (match) return match[1];
  match = text.match(/检票[:：]?\s*([\u4e00-\u9fa50-9A-Za-z]{1,16})/);
  if (match) return match[1];
  return '';
}

function parseFlags(text, seatClass) {
  const index = seatClass ? text.indexOf(seatClass) : -1;
  const zone = index >= 0 ? text.slice(index, index + 20) : '';
  return {
    student: zone.includes('学'),
    discount: zone.includes('退') || zone.includes('改') || zone.includes('惠'),
    online: zone.includes('网'),
    child: zone.includes('孩'),
  };
}

export function parseItinerary({ text, gridLines }) {
  if (Array.isArray(gridLines)) gridLines = gridLines.map(normalizeText);
  const t = normalizeText(text).replace(/\s+/g, ' ');
  const out = { kind: 'itinerary', flags: {}, infoline1: 0 };

  const train = t.match(/(^|\D)([GCDTKZ]\d{3,5})(?!\d)/);
  if (train) out.trainNo = train[2];

  Object.assign(out, parseStations(t, gridLines));

  const fullDate = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (fullDate) out.date = validDate(fullDate[1], fullDate[2], fullDate[3]);
  if (!out.date && Array.isArray(gridLines)) {
    const row = gridLines.findIndex((line) => /\d{4}\s*年/.test(line) && /月/.test(line));
    if (row >= 0) {
      const year = (gridLines[row].match(/\d{4}/) || [])[0];
      for (const line of [gridLines[row], gridLines[row + 1] || '']) {
        const md = line.match(/月\s*(\d{1,2})\D{0,3}(\d{1,2})\s*日?/);
        if (md) {
          const date = validDate(year, md[1], md[2]);
          if (date) {
            out.date = date;
            break;
          }
        }
      }
    }
  }
  if (!out.date) {
    const loose = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/);
    if (loose) out.date = validDate(loose[1], loose[2], loose[3]);
  }

  if (Array.isArray(gridLines)) {
    const row = gridLines.findIndex((line) => /开车时间/.test(line));
    if (row >= 0) {
      const same = gridLines[row].match(/(\d{1,2}):(\d{2})(?=\D|$)/);
      if (same) out.time = cleanTime(same[1], same[2]);
      if (!out.time) {
        for (let i = row + 1; i < Math.min(gridLines.length, row + 4); i += 1) {
          const hm = gridLines[i].match(/(\d{1,2}):(\d{2})(?=\D|$)/);
          if (hm) {
            out.time = cleanTime(hm[1], hm[2]);
            break;
          }
        }
      }
    }
  }
  if (!out.time) {
    const near = t.match(/开车时间\D{0,40}?(\d{1,2}):(\d{2})(?=\D|$)/);
    if (near) out.time = cleanTime(near[1], near[2]);
  }
  if (!out.time) {
    // “10:24开”优先于全篇最后一个 HH:MM；后者可能是 PDF 生成时间。
    const drive = t.match(/(\d{1,2}):(\d{2})\s*开/);
    if (drive) out.time = cleanTime(drive[1], drive[2]);
  }
  if (!out.time) {
    const times = [...t.matchAll(/(\d{1,2}):(\d{2})(?=\D|$)/g)];
    if (times.length) {
      const last = times[times.length - 1];
      out.time = cleanTime(last[1], last[2]);
    }
  }

  const carriage = t.match(/(\d{1,2})\s*车\s*(\d{1,2}[A-Za-z0-9]?)/);
  if (carriage) {
    out.carriageNo = carriage[1];
    out.seatNo = carriage[2];
  }
  const position = t.match(/(\d{1,2}[A-Za-z0-9]?)\s*号?\s*(上铺|中铺|下铺|卧)/);
  if (position) out.seatPosition = position[2];

  const seatClass = t.match(/(特等座|一等座|二等座|商务座|软座|硬座|软卧|硬卧|动卧|动座|无座)/);
  if (seatClass) out.seatClass = seatClass[1];

  out.checkinRoom = parseCheckin(t);

  const identity = t.match(/([\u4e00-\u9fa5]{1,6})\s*(\d{2,}\*+\d{2,}|\d{17}[\dXx](?!\d))/);
  if (identity && !/电子票号|订单号|票价|检票口|生成时间|发票号码/.test(identity[1])) {
    out.name = identity[1];
    out.identity = identity[2];
  }

  const eTicket = t.match(/电子票号[:：]?\s*(\d{15,25})/);
  if (eTicket) out.machineId = eTicket[1];
  if (!out.machineId) {
    const numbers = t.match(/\d{15,25}/g);
    if (numbers) out.machineId = [...numbers].sort((a, b) => b.length - a.length)[0];
  }
  const order = t.match(/订\s*单\s*号[:：]?\s*([A-Z0-9]{4,})/i);
  if (order) out.ticketNo = order[1];

  const qr =
    t.match(/https?:\/\/e\.12306\.cn\/orderId\/([A-Za-z0-9]+)\/?/i) ||
    t.match(/https?:\/\/e\.12306\.cn\/[A-Za-z0-9-]+/i) ||
    t.match(/https?:\/\/([A-Za-z0-9-]+\.12306\.cn)\/[A-Za-z0-9/_\-]*/i);
  if (qr) out.qrcodeContent = qr[0];

  const price = t.match(/票价[:：]?\s*(\d+(?:\.\d+)?)\s*元/);
  if (price) out.price = Number(price[1]).toFixed(1);

  out.flags = parseFlags(t, out.seatClass);
  out.infoline1 = /限乘当日当次车/.test(t) ? 2 : 0;
  return out;
}

export function parseInvoice({ text }) {
  const t = normalizeText(text).replace(/\s+/g, ' ');
  const out = { kind: 'invoice', flags: {}, infoline1: 0 };

  const train = t.match(/(^|\D)([GCDTKZ]\d{3,5})(?!\d)/);
  if (train) out.trainNo = train[2];

  const stations =
    t.match(/([\u4e00-\u9fa5]{2,8})\s*站?\s+([GCDTKZ]\d{3,5})\s+([\u4e00-\u9fa5]{2,8})\s*站?/) ||
    t.match(/([\u4e00-\u9fa5]{2,8})\s*站\s*([GCDTKZ]\d{3,5})\s*([\u4e00-\u9fa5]{2,8})\s*站/);
  if (stations) {
    out.startStation = cleanStation(stations[1]);
    out.endStation = cleanStation(stations[3]);
    out.trainNo = out.trainNo || stations[2];
  }

  const dateTime = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})\s*开/);
  if (dateTime) {
    out.date = validDate(dateTime[1], dateTime[2], dateTime[3]);
    out.time = cleanTime(dateTime[4], dateTime[5]);
  } else {
    const hm = t.match(/(\d{1,2}):(\d{2})\s*开/);
    if (hm) out.time = cleanTime(hm[1], hm[2]);
  }

  const carriage = t.match(/(\d{1,2})\s*车\s*([0-9]{1,2}[A-Za-z]?|无座|上铺|中铺|下铺)\s*号?/);
  if (carriage) {
    out.carriageNo = carriage[1];
    out.seatNo = carriage[2];
  }
  let seatClass = null;
  if (carriage) {
    seatClass = t
      .slice(carriage.index + carriage[0].length)
      .match(/(特等座|一等座|二等座|商务座|软座|硬座|软卧|硬卧|动卧|无座)/);
  }
  if (!seatClass) seatClass = t.match(/(特等座|一等座|二等座|商务座|软座|硬座|软卧|硬卧|动卧|无座)/);
  if (seatClass) out.seatClass = seatClass[1];

  const identity =
    t.match(/(^|[^\d])(\d{2,}[0-9]*\*{2,}[0-9]{2,})/) ||
    t.match(/(^|[^\d])(\d{17}[\dXx])(?!\d)/);
  if (identity) out.identity = identity[2];
  let name = t.match(/购买方名称[:：]\s*([\u4e00-\u9fa5]{1,6})/);
  if (!name && identity) {
    const after = t.slice(identity.index + identity[0].length).match(/^\s*([\u4e00-\u9fa5]{1,6})/);
    if (after) name = after;
  }
  if (name) out.name = name[1];

  const eTicket = t.match(/电子客票号[:：]?\s*(\d{10,30})/);
  if (eTicket) out.machineId = eTicket[1];
  const invoice = t.match(/发票号码[:：]?\s*(\d{10,30})/);
  if (invoice) out.ticketNo = invoice[1];

  const price = t.match(/(?:票价|退票费)[:：]?\s*[￥¥]?\s*(\d+(?:\.\d+)?)/);
  if (price) out.price = Number(price[1]).toFixed(1);

  out.flags = {
    discount: /改签|退票|差额退票/.test(t),
    student: /学生/.test(t),
    online: false,
    child: /儿童|孩/.test(t),
  };
  return out;
}

export function parsePdfText(model) {
  const text = String(model?.text || '');
  const isInvoice = /电子发票|发票号码|购买方名称/.test(text);
  const parsed = isInvoice ? parseInvoice({ text, gridLines: model?.gridLines }) : parseItinerary(model);
  return normalizeParsed(parsed);
}

export function normalizeParsed(parsed) {
  const out = { ...parsed, flags: { ...(parsed.flags || {}) } };
  for (const key of [
    'startStation',
    'endStation',
    'trainNo',
    'date',
    'time',
    'carriageNo',
    'seatNo',
    'seatPosition',
    'seatClass',
    'checkinRoom',
    'name',
    'identity',
    'ticketNo',
    'machineId',
    'price',
    'qrcodeContent',
  ]) {
    if (out[key] !== undefined && out[key] !== null) out[key] = String(out[key]).trim();
    if (out[key] === '') delete out[key];
  }
  if (out.carriageNo) out.carriageNo = out.carriageNo.padStart(2, '0');
  return out;
}

/** 浏览器：读取 PDF 文本层。 */
export async function extractPdf(file, onProgress) {
  const lib = await loadPdfEngine();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({
    data,
    cMapUrl: '/js/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/js/vendor/pdfjs/standard_fonts/',
    isEvalSupported: false,
  });
  const pdf = await task.promise;
  const allItems = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      onProgress?.(pageNumber, pdf.numPages);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ normalizeWhitespace: false });
      allItems.push(...(content.items || []));
    }
  } finally {
    await pdf.destroy().catch(() => {});
  }
  return buildTextModel(allItems);
}
