/**
 * 票面 Canvas 渲染器：正面 / 背面 / 合并。
 * 只依赖 Canvas 2D 与 manifest，不读 DOM，方便预览与导出共用。
 */

import { loadImage, loadTemplateImage, assetUrl } from './templates.js';
import {
  TICKET_NUMBER,
  TICKET_SANS,
  TICKET_SERIF,
  dateRuns,
  drawRuns,
  drawSpaced,
  drawSpread,
  fitFontSize,
  fontString,
  glyphBottomOffset,
  measure,
  quoteFamily,
  sanitizeTrainNo,
  setCanvasFont,
  stationLayout,
  wrapNameLines,
} from './layout.js';

export const DEFAULT_QR = 'https://www.12306.cn/';
export const DEFAULT_BACK_TITLE = '报销凭证使用须知';
export const DEFAULT_BACK_TERMS = [
  '☆购票后如需报销凭证的，应在开车前或乘车日期之日起180日以内(含当日),持购票时所使用的有效身份证件原件到车站售票窗口、自动售票机领取。',
  '☆退票后如需退票费报销凭证，应在办理之日起180天以内(含当日),持购票时所使用的有效身份证件原件到车站退票窗口领取。',
  '☆报销凭证开具后请妥善保管，丢失后将无法办理补办申领手续。',
  '☆已领取报销凭证的车票办理改签、退票或退款手续时，须交回报销凭证方可办理。',
  '☆报销凭证不能作为乘车凭证使用。',
  '☆未尽事宜见《国铁集团铁路旅客运输规程》等有关规定和车站公告。跨境旅客事宜见铁路跨境旅客相关运输组织规则和车站公告。',
].join('\n');

const INFO3_TEXT = {
  0: ['报销凭证 遗失不补', '退票改签时须交回车站'],
  1: ['买票请到12306 发货请到95306', '中国铁路祝您旅途愉快'],
  2: ['欢度国庆 祝福祖国', '中国铁路祝您旅途愉快'],
  9: ['奋斗百年路 启航新征程', '热烈庆祝中国共产党成立100周年'],
};

const qrCache = new Map();
const customImageCache = new Map();

export function clearRenderCaches() {
  qrCache.clear();
  customImageCache.clear();
}

export async function ensureQr(text, sourceWidth = 0) {
  const value = String(text || DEFAULT_QR);
  const cacheKey = `${sourceWidth}:${value}`;
  if (qrCache.has(cacheKey)) return qrCache.get(cacheKey);
  if (typeof QRCode === 'undefined') throw new Error('二维码组件未加载');
  const options = {
    errorCorrectionLevel: 'L',
    margin: 0,
    quality: 0.3,
    color: { dark: '#000000FF', light: '#00000000' },
  };
  if (sourceWidth > 0) options.width = sourceWidth;
  const promise = QRCode.toDataURL(value, options).then((url) => loadImage(url));
  qrCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    qrCache.delete(cacheKey);
    throw error;
  }
}

function familyFor(kind, draft) {
  const scheme = draft.fontScheme || {};
  if (kind === 'zh') return scheme.zh || TICKET_SERIF;
  if (kind === 'en') return scheme.en || TICKET_SERIF;
  if (kind === 'num') return scheme.num || TICKET_SERIF;
  if (kind === 'number') return scheme.num || TICKET_NUMBER;
  return TICKET_SERIF;
}

function isBlue(template) {
  return template.family === 'blue';
}

function qrRect(template) {
  const qr = template.layout?.qr || {
    blue: { x: 600, y: 300, size: 128 },
    red: { x: 600, y: 360, size: 136 },
  };
  if (isBlue(template)) {
    const paper = template.key === 'blue-paper';
    return { x: qr.blue.x, y: paper ? (qr.bluePaperY ?? 307) : qr.blue.y, size: qr.blue.size };
  }
  return { x: qr.red.x, y: qr.red.y, size: qr.red.size };
}

function drawArrow(ctx, x, y) {
  ctx.save();
  ctx.strokeStyle = '#1f1f1f';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x - 55, y + 30);
  ctx.lineTo(x + 65, y + 30);
  ctx.lineTo(x + 50, y + 25);
  ctx.stroke();
  ctx.restore();
}

function drawCircle(ctx, x, y, radius) {
  ctx.save();
  ctx.strokeStyle = '#1f1f1f';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function scaled(draft, px) {
  return Math.max(1, Math.round(px * (Number(draft.fontScale) || 1)));
}
function runWidth(ctx, run, weight) {
  if (!run?.text) return 0;
  setCanvasFont(ctx, run.size || 24, weight, run.family || TICKET_SERIF);
  return measure(ctx, run.text);
}

/** 把 runs 的总宽压到 available 内；返回新的 runs 与段间 gap。 */
function fitRuns(ctx, runs, available, weight, gap) {
  const total = runs.reduce((sum, run) => sum + (run.gap || 0) + runWidth(ctx, run, weight), 0)
    + Math.max(0, runs.length - 1) * gap;
  if (total <= available || total <= 0) return { runs, gap };
  const factor = available / total;
  return {
    runs: runs.map((run) => ({
      ...run,
      size: run.size ? run.size * factor : run.size,
      gap: run.gap ? run.gap * factor : run.gap,
    })),
    gap: gap * factor,
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} draft 已规范化的票面数据
 * @param {object} template manifest 中的一款
 * @param {{scale?:number, qrImage?:HTMLImageElement|null, signal?:AbortSignal}} options
 */
export async function renderFront(canvas, draft, template, options = {}) {
  const scale = Math.min(3, Math.max(1, Number(options.scale) || 1));
  const width = template.canvas.width;
  const height = template.canvas.height;
  const background = await loadTemplateImage(template);
  if (options.signal?.aborted) return;

  let qrImage = options.qrImage;
  if (qrImage === undefined) {
    const qrText = draft.qrEnabled === false ? '' : draft.qrcodeString || DEFAULT_QR;
    try {
      qrImage = qrText ? await ensureQr(qrText, scale > 1 ? 256 * scale : 0) : null;
    } catch (error) {
      console.warn('二维码生成失败，票面将不带二维码', error);
      qrImage = null;
    }
  }
  if (options.signal?.aborted) return;

  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1f1f1f';
  ctx.strokeStyle = '#1f1f1f';

  const red = !isBlue(template);
  const dx = Number(template.offset?.dx) || 0;
  const dy = Number(template.offset?.dy) || 0;
  const adj = template.adjust || {};
  const dy2 = dy + (Number(adj.allDy) || 0);
  const weight = Number(draft.fontWeight) || 500;

  const setFont = (px, kind) => {
    const size = scaled(draft, px);
    setCanvasFont(ctx, size, weight, familyFor(kind, draft));
    return size;
  };

  // ---------- 底图 ----------
  if (red) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#1f1f1f';
  }
  if (template.background.fit === 'cover') {
    const ratio = Math.max(width / background.naturalWidth, height / background.naturalHeight);
    const drawW = background.naturalWidth * ratio;
    const drawH = background.naturalHeight * ratio;
    ctx.drawImage(background, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
  } else {
    ctx.drawImage(background, 0, 0);
  }

  // ---------- 票号 ----------
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ff0000';
  let ticketFont = scaled(draft, 40);
  let ticketSpacing = 4 * (Number(draft.fontScale) || 1);
  setCanvasFont(ctx, ticketFont, weight, familyFor('number', draft));
  const ticketText = draft.ticketNo || '';
  const ticketWidth = measure(ctx, ticketText) + Math.max(0, ticketText.length - 1) * ticketSpacing;
  const ticketAvailable = 655;
  if (ticketWidth > ticketAvailable && ticketWidth > 0) {
    const factor = ticketAvailable / ticketWidth;
    ticketFont = Math.max(12, Math.floor(ticketFont * factor));
    ticketSpacing *= factor;
  }
  setCanvasFont(ctx, ticketFont, weight, familyFor('number', draft));
  drawSpaced(
    ctx,
    ticketText,
    45 + (Number(adj.ticketNoDx) || 0) + dx,
    50 + (Number(adj.ticketNoDy) || 0) + dy,
    ticketSpacing,
  );
  ctx.fillStyle = '#1f1f1f';

  // ---------- 检票口 ----------
  if (draft.checkinRoom) {
    let checkinX = 760 + dx;
    let checkinY = 40 + (Number(adj.checkinDy) || 0) + dy;
    if (adj.checkinAlign === 'ticketNoBottom') {
      const ticketNoY = 50 + (Number(adj.ticketNoDy) || 0) + dy;
      const bottomOffset =
        glyphBottomOffset(
          ctx,
          scaled(draft, 40),
          weight,
          familyFor('number', draft),
          '0000000000',
        ) -
        glyphBottomOffset(ctx, scaled(draft, 30), weight, familyFor('zh', draft), '00检票口');
      checkinY = ticketNoY + bottomOffset;
    }
    if (adj.checkinAlign === 'endStationSuffix') {
      const endName = draft.endStation || '';
      const geometry = stationLayout('end', endName, 550);
      setFont(32, 'zh');
      checkinX = geometry.suffixX + measure(ctx, '站') + dx;
    }
    ctx.textAlign = 'right';
    setFont(30, 'zh');
    ctx.fillText(draft.checkinRoom, checkinX, checkinY);
    ctx.textAlign = 'left';
  }

  // ---------- 始发 / 到达 ----------
  const drawStation = (kind) => {
    const name = kind === 'start' ? draft.startStation : draft.endStation;
    const pinyin = kind === 'start' ? draft.startStationPY : draft.endStationPY;
    if (!name) return;
    const baseX = (kind === 'start' ? 60 : 550) + dx;
    const y = 105 + dy2;
    const geometry = stationLayout(kind, name, baseX);
    const family = familyFor('zh', draft);
    const fontSize = fitFontSize(ctx, name, 50, geometry.target / (Number(draft.fontScale) || 1), weight, family, 0.5);
    setFont(fontSize, 'zh');
    ctx.textAlign = 'left';
    drawSpread(ctx, name, geometry.x, y, geometry.target);
    setFont(32, 'zh');
    ctx.fillText('站', geometry.suffixX, y);

    if (pinyin) {
      setFont(30, 'en');
      ctx.textAlign = 'center';
      const pinyinX =
        kind === 'start' ? Math.max(baseX + 90, measure(ctx, name) / 2 + 100) : baseX + 90;
      // 拼音按 30px 居中，允许略微超出站名区；不要为了“塞进站名宽度”把它缩成小字。
      setFont(30, 'en');
      ctx.fillText(pinyin, pinyinX, y + 40);
      ctx.textAlign = 'left';
    }
  };
  drawStation('start');
  drawStation('end');

  // ---------- 车次 + 箭头 ----------
  if (draft.trainNo) {
    setFont(46, 'en');
    ctx.textAlign = 'center';
    ctx.fillText(sanitizeTrainNo(draft.trainNo), 400 + dx, 105 + dy2);
    drawArrow(ctx, 400 + dx, 105 + dy2);
    ctx.textAlign = 'left';
  }

  // ---------- 日期 / 时间 ----------
  const runs = dateRuns(draft.date, draft.time);
  if (runs) {
    let dateLine = runs.map((run) => ({
      ...run,
      family: /^\d/.test(run.text) ? familyFor('num', draft) : familyFor('zh', draft),
    }));
    let dateGap = 5;
    const fittedDate = fitRuns(ctx, dateLine, 460, weight, dateGap);
    dateLine = fittedDate.runs;
    dateGap = fittedDate.gap;
    drawRuns(ctx, dateLine, 40 + dx, 190 + dy2, dateGap);
  } else {
    setFont(30, 'num');
    ctx.fillText('--', 40 + dx, 190 + dy2);
  }

  // ---------- 车厢 / 座位 / 铺位 ----------
  const carriageRuns = [];
  if (draft.carriageNo) {
    carriageRuns.push({ text: draft.carriageNo, size: 40, family: familyFor('num', draft) });
    carriageRuns.push({ text: '车', size: 24, family: familyFor('zh', draft) });
  }
  if (draft.seatNo) {
    carriageRuns.push({ text: draft.seatNo, size: 40, family: familyFor('num', draft) });
    if (draft.seatNo !== '无座') {
      carriageRuns.push({ text: '号', size: 24, family: familyFor('zh', draft) });
    }
  }
  if (draft.seatPosition) {
    carriageRuns.push({ text: draft.seatPosition, size: 24, family: familyFor('zh', draft) });
  }
  if (carriageRuns.length) {
    const fitted = fitRuns(ctx, carriageRuns, 268, weight, 3);
    drawRuns(ctx, fitted.runs, 522 + dx, 190 + dy2, fitted.gap);
  }

  // ---------- 票价 ----------
  if (draft.price) {
    setFont(36, 'num');
    ctx.textAlign = 'left';
    const priceText = `￥${draft.price}`;
    ctx.fillText(priceText, 40 + dx, 235 + dy2);
    const priceWidth = measure(ctx, priceText);
    setFont(24, 'zh');
    ctx.fillText('元', 40 + dx + priceWidth, 235 + dy2);
  }

  // ---------- 优惠标志 ----------
  const flags = [
    ['child', '孩'],
    ['student', '学'],
    ['online', '网'],
    ['discount', '惠'],
  ].filter(([key]) => draft.flags?.[key]);
  if (flags.length) {
    let x = 360 - 20 * flags.length + dx;
    const y = 235 + dy2;
    setFont(24, 'zh');
    ctx.textAlign = 'left';
    for (const [, char] of flags) {
      x += 40;
      ctx.fillText(char, x, y);
      drawCircle(ctx, x + 12, y - 2, 15);
    }
  }

  // ---------- 席别 ----------
  if (draft.seatClass) {
    setFont(30, 'zh');
    ctx.textAlign = 'center';
    ctx.fillText(draft.seatClass, 620 + dx, 235 + dy2);
    ctx.textAlign = 'left';
  }

  // ---------- 附加信息 ----------
  const info1 = ['', '退票费', '限乘当日当次车'][Number(draft.info1)] || '';
  if (info1) {
    setFont(24, 'zh');
    ctx.fillText(info1, 40 + dx, 270 + dy2);
  }
  if (draft.info2) {
    setFont(24, 'zh');
    ctx.fillText(draft.info2, 40 + dx, 305 + dy2);
  }

  // ---------- 证件号 / 姓名 ----------
  if (draft.identity) {
    const family = familyFor('num', draft);
    const identitySize = fitFontSize(
      ctx,
      draft.identity,
      35,
      352 / (Number(draft.fontScale) || 1),
      weight,
      family,
      0.5,
    );
    setCanvasFont(ctx, scaled(draft, identitySize), weight, family);
    ctx.fillText(draft.identity, 40 + dx, 345 + dy2);
  }

  const qr = qrRect(template);
  const nameX = 400 + dx;
  const nameY = 345 + dy2;
  if (draft.name) {
    const zoneRight = qr.x - 8;
    const maxWidth = Math.max(30, zoneRight - nameX);
    const family = familyFor('zh', draft);
    let nameSize = scaled(draft, 32);
    setCanvasFont(ctx, nameSize, weight, family);
    let lines = wrapNameLines(ctx, draft.name, maxWidth);
    let widest = Math.max(...lines.map((line) => measure(ctx, line)), 0);
    if (widest > maxWidth) {
      nameSize = Math.max(scaled(draft, 20), Math.floor((nameSize * maxWidth) / widest));
      setCanvasFont(ctx, nameSize, weight, family);
      lines = wrapNameLines(ctx, draft.name, maxWidth);
    }
    // 两行姓名向上折时可能压到“附加信息 2”（y=305）；这时优先缩成一行。
    if (lines.length > 1) {
      const lineHeight = Math.round(nameSize * 1.06);
      const top = nameY - lineHeight * (lines.length - 1);
      if (top < 320) {
        let oneLineSize = scaled(draft, 32);
        while (oneLineSize > 18) {
          setCanvasFont(ctx, oneLineSize, weight, family);
          if (measure(ctx, draft.name) <= maxWidth) break;
          oneLineSize -= 1;
        }
        setCanvasFont(ctx, oneLineSize, weight, family);
        nameSize = oneLineSize;
        if (measure(ctx, draft.name) <= maxWidth) {
          lines = [draft.name];
        } else {
          lines = wrapNameLines(ctx, draft.name, maxWidth);
        }
      }
    }
    const lineHeight = Math.round(nameSize * 1.06);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, zoneRight, height);
    ctx.clip();
    ctx.textAlign = 'left';
    lines.forEach((line, index) => {
      ctx.fillText(line, nameX, nameY - lineHeight * (lines.length - 1 - index));
    });
    ctx.restore();
  }

  // ---------- 二维码 ----------
  if (qrImage && draft.qrEnabled !== false) {
    ctx.save();
    ctx.drawImage(qrImage, qr.x, qr.y, qr.size, qr.size);
    ctx.restore();
  }

  // ---------- 虚线框 ----------
  ctx.save();
  ctx.strokeStyle = '#1f1f1f';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 5]);
  ctx.strokeRect(80 + dx, 365 + dy2, 460, 70);
  ctx.restore();

  // ---------- 底部两行提示 ----------
  const [line1, line2] = INFO3_TEXT[String(draft.info3)] || INFO3_TEXT['0'];
  setFont(24, 'zh');
  ctx.textAlign = 'center';
  ctx.fillText(line1, 300 + dx, 385 + dy2);
  ctx.fillText(line2, 300 + dx, 415 + dy2);
  ctx.textAlign = 'left';

  // ---------- 取票机号 ----------
  if (draft.machineId) {
    const machineY =
      (isBlue(template) ? 475 : 485) + (Number(adj.allDy) || 0) + (Number(adj.machineDy) || 0);
    const machineSize = fitFontSize(
      ctx,
      draft.machineId,
      27,
      560 / (Number(draft.fontScale) || 1),
      weight,
      familyFor('num', draft),
      0.5,
    );
    setCanvasFont(ctx, scaled(draft, machineSize), weight, familyFor('num', draft));
    ctx.fillText(draft.machineId, 40 + dx, machineY);
  }

  // 合规标识：每张导出图都必须能看出是纪念品，而不是真实乘车/报销凭证。
  ctx.save();
  ctx.textAlign = 'right';
  setFont(15, 'zh');
  ctx.fillStyle = 'rgba(31,31,31,0.72)';
  ctx.fillText('纪念车票 · 不作乘车凭证', width - 16, height - 15);
  ctx.restore();
}

async function loadBackBackground(template, backStyle, templateFor) {
  const background = backStyle?.background || template.key;
  if (background === 'solid') return { type: 'solid', color: backStyle?.solidColor || '#d9d9d9' };
  if (background === 'custom') {
    const src = backStyle?.customImage;
    if (!src) return { type: 'solid', color: '#cfd4dc' };
    if (!customImageCache.has(src)) customImageCache.set(src, loadImage(src));
    return { type: 'image', image: await customImageCache.get(src), cover: true };
  }
  const target = templateFor?.(background) || template;
  const familyChanged =
    target.canvas.width !== template.canvas.width || target.canvas.height !== template.canvas.height;
  return { type: 'image', image: await loadTemplateImage(target), cover: familyChanged };
}

/** 背面：标题 + 条款 + 底图 / 纯色 / 自定义图 / 遮罩。 */
export async function renderBack(canvas, draft, template, backStyle, options = {}) {
  const style = backStyle || {
    background: template.key,
    title: DEFAULT_BACK_TITLE,
    terms: DEFAULT_BACK_TERMS,
    titleSize: 40,
    titleWeight: 700,
    titleColor: '#333333',
    termsSize: 21,
    termsWeight: 500,
    termsColor: '#3c3c3c',
    mask: { enabled: false, color: 'black', alpha: 0.5 },
  };
  const scale = Math.min(3, Math.max(1, Number(options.scale) || 1));
  const width = template.canvas.width;
  const height = template.canvas.height;
  const bg = await loadBackBackground(template, style, options.templateFor);
  if (options.signal?.aborted) return;

  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#fffefb';
  ctx.fillRect(0, 0, width, height);

  if (bg.type === 'image') {
    if (bg.cover) {
      const ratio = Math.max(width / bg.image.naturalWidth, height / bg.image.naturalHeight);
      const drawW = bg.image.naturalWidth * ratio;
      const drawH = bg.image.naturalHeight * ratio;
      ctx.drawImage(bg.image, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
    } else {
      ctx.drawImage(bg.image, 0, 0);
    }
  } else {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, width, height);
  }

  if (style.mask?.enabled) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, Number(style.mask.alpha) || 0));
    ctx.fillStyle = style.mask.color === 'white' ? '#fffefb' : '#000000';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  const sc = width / 809;
  const titleSize = Math.max(10, Number(style.titleSize) || 40) * sc;
  const titleWeight = Number(style.titleWeight) || 700;
  const titleY = Math.round(height * 0.072) + titleSize * 0.5;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = style.titleColor || '#333333';
  setCanvasFont(ctx, titleSize, titleWeight, TICKET_SANS);
  ctx.fillText(style.title || DEFAULT_BACK_TITLE, width / 2, titleY);

  const left = Math.round(width * 0.052);
  const maxW = width - left * 2;
  const preferred = Math.max(10, (Number(style.termsSize) || 21) * sc);
  const maxHeight = height - 12;
  let fs = preferred;
  let lines = [];
  let lineHeight = 0;
  let startY = 0;

  // 默认条款较长：按用户字号排版，若超出背面高度则逐步缩小到能放下，
  // 避免最后几行被裁掉；用户仍可通过字号输入框主动调整。
  for (let attempt = 0; attempt < 10; attempt += 1) {
    setCanvasFont(ctx, fs, Number(style.termsWeight) || 500, TICKET_SANS);
    const indent = fs * 2;
    lineHeight = Math.round(fs * 1.62);
    startY = titleY + titleSize * 0.5 + Math.round(height * 0.032) + lineHeight / 2;
    lines = [];
    for (const paragraph of String(style.terms || DEFAULT_BACK_TERMS).split('\n')) {
      if (!paragraph.trim()) {
        lines.push({ text: '', indent: 0 });
        continue;
      }
      let line = '';
      let first = true;
      for (const char of paragraph) {
        const test = line + char;
        const avail = maxW - (first ? indent : 0);
        if (measure(ctx, test) > avail && line) {
          lines.push({ text: line, indent: first ? indent : 0 });
          first = false;
          line = char;
        } else {
          line = test;
        }
      }
      if (line) lines.push({ text: line, indent: first ? indent : 0 });
    }
    if (startY + lines.length * lineHeight <= maxHeight || fs <= 12) break;
    fs = Math.max(12, Math.floor(fs * 0.92));
  }

  setCanvasFont(ctx, fs, Number(style.termsWeight) || 500, TICKET_SANS);
  ctx.textAlign = 'left';
  ctx.fillStyle = style.termsColor || '#3c3c3c';
  let y = startY;
  for (const line of lines) {
    ctx.fillText(line.text, left + line.indent, y);
    y += lineHeight;
  }
}

/** 正面 + 背面合并；gap 使用逻辑 26px 并按当前 scale 放大。 */
export function composeFrontBack(front, back, { gap = 26, logicalWidth = null, background = '#fffefb' } = {}) {
  const width = Math.max(front.width, back.width);
  const scale = logicalWidth ? front.width / logicalWidth : 1;
  const gapPx = Math.round(gap * scale);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = front.height + gapPx + back.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(front, Math.round((width - front.width) / 2), 0);
  ctx.drawImage(back, Math.round((width - back.width) / 2), front.height + gapPx);
  return out;
}

export { qrRect, assetUrl, quoteFamily, fontString };
