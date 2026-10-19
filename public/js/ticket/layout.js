/**
 * 票面排版数学与文本绘制辅助。
 * 这里不依赖 DOM，Node 单测可以用假的 ctx（只需 measureText）验证切分/折行。
 */

/* TraceDot V6.2.6 的“系统默认”会把 Times/Arial 替换为系统无衬线栈；
   这也是参考图的实际字体。想要经典衬线时，在“数字/英文”字体方案里显式选择 Times。 */
export const TICKET_SANS =
  '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","HarmonyOS Sans SC","Noto Sans SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif';
export const TICKET_SERIF = TICKET_SANS;
export const TICKET_NUMBER = TICKET_SANS;

export const DEFAULT_INFO1 = '0';
export const INFO1_LABELS = ['', '退票费', '限乘当日当次车'];

export function quoteFamily(family) {
  const text = String(family || '').trim();
  if (!text || text.includes('"') || text.includes("'")) return text;
  return /\s/.test(text) ? `"${text}"` : text;
}

export function fontString(size, weight = 500, family = TICKET_SERIF) {
  const px = Math.max(1, Math.round(Number(size) || 1));
  const w = Number(weight) || 500;
  return `${w} ${px}px ${quoteFamily(family) || TICKET_SERIF}`;
}

export function setCanvasFont(ctx, size, weight, family) {
  ctx.font = fontString(size, weight, family);
  return ctx.font;
}

export function measure(ctx, text) {
  if (!text) return 0;
  return ctx.measureText(String(text)).width;
}

/** 逐字符绘制，字距只加在字符之间（对齐 TraceDot 的 fillTextWithSpacing）。 */
export function drawSpaced(ctx, text, x, y, spacing = 0) {
  const value = String(text ?? '');
  if (!value) return 0;
  if (!spacing) {
    ctx.fillText(value, x, y);
    return measure(ctx, value);
  }
  let cursor = x;
  for (const char of value) {
    ctx.fillText(char, cursor, y);
    cursor += measure(ctx, char) + spacing;
  }
  return cursor - x - spacing;
}

/**
 * 把文字按目标宽度“撑开”：字少时加大字距，字多时保持自然宽度。
 * 与 12306 票面站名的处理一致。
 */
export function drawSpread(ctx, text, x, y, targetWidth) {
  const value = String(text ?? '');
  if (!value) return 0;
  const natural = measure(ctx, value);
  if (value.length <= 1 || natural >= targetWidth) {
    ctx.fillText(value, x, y);
    return natural;
  }
  const gap = (targetWidth - natural) / (value.length - 1);
  let cursor = x;
  for (const char of value) {
    ctx.fillText(char, cursor, y);
    cursor += measure(ctx, char) + gap;
  }
  return targetWidth;
}

/** 按 runs 顺序绘制，segmentGap 加在每段之间。 */
export function drawRuns(ctx, runs, x, y, segmentGap = 0) {
  let cursor = x;
  runs.forEach((run, index) => {
    if (!run) return;
    if (run.gap) cursor += run.gap;
    if (!run.text) return;
    if (run.size) setCanvasFont(ctx, run.size, run.weight, run.family);
    if (run.color) ctx.fillStyle = run.color;
    ctx.textAlign = run.align || 'left';
    if (run.spacing) {
      drawSpaced(ctx, run.text, cursor, y, run.spacing);
      cursor += measure(ctx, run.text) + run.spacing * Math.max(0, run.text.length - 1);
    } else {
      ctx.fillText(run.text, cursor, y);
      cursor += measure(ctx, run.text);
    }
    if (index < runs.length - 1) cursor += segmentGap;
  });
  return cursor - x;
}

/**
 * 把字号缩到 maxWidth 以内；返回实际字号（不低于 base*minRatio）。
 * 调用方负责之后 setCanvasFont。
 */
export function fitFontSize(ctx, text, baseSize, maxWidth, weight, family, minRatio = 0.72) {
  const natural = Number(baseSize) || 1;
  if (!text || !maxWidth || maxWidth <= 0) return natural;
  setCanvasFont(ctx, natural, weight, family);
  const width = measure(ctx, text);
  if (width <= maxWidth) return natural;
  const fitted = Math.max(natural * minRatio, Math.floor((natural * maxWidth) / width));
  return Math.max(1, fitted);
}

/** 站名 + “站” 的几何位置（不含家族 dx）。 */
export function stationLayout(kind, name, x) {
  const value = String(name || '');
  const length = value.length;
  const isStart = kind === 'start';
  if (length < 4) {
    return { x, target: 160, suffixX: x + 165 };
  }
  if (isStart) {
    return {
      x: x - (length - 3) * 15,
      target: 170 + (length - 3) * 20,
      suffixX: x + 165 + (length - 3) * 33,
    };
  }
  return {
    x: x - (length - 3) * 20,
    target: 170 + (length - 3) * 20,
    suffixX: x + 165 + (length - 3) * 25,
  };
}

/** 姓名折行：一行放不下时，找两行都不越界且宽度最接近的切分。 */
export function wrapNameLines(ctx, text, maxWidth) {
  const value = String(text || '');
  if (!value) return [];
  if (measure(ctx, value) <= maxWidth) return [value];
  let best = null;
  for (let i = 1; i < value.length; i += 1) {
    const first = value.slice(0, i);
    const second = value.slice(i);
    const widthA = measure(ctx, first);
    const widthB = measure(ctx, second);
    if (widthA > maxWidth || widthB > maxWidth) continue;
    const score = Math.abs(widthA - widthB);
    if (!best || score < best.score) best = { lines: [first, second], score };
  }
  if (best) return best.lines;
  const middle = Math.ceil(value.length / 2);
  return [value.slice(0, middle), value.slice(middle)];
}

/** 数字/单位混排的日期段。 */
export function dateRuns(date, time) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  const [, year, month, day] = match;
  const runs = [
    { text: year, size: 38 },
    { text: '年', size: 24 },
    { text: month, size: 38 },
    { text: '月', size: 24 },
    { text: day, size: 38 },
    { text: '日', size: 24 },
  ];
  if (time) {
    // TraceDot 在“日”和发车时间之间额外留 12px。
    runs.push({ text: '', gap: 12 }, { text: time, size: 38 }, { text: '开', size: 24 });
  }
  return runs;
}

export function sanitizeTrainNo(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9]/g, '');
}

export function sanitizeFileName(value, fallback = 'ticket') {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || fallback).slice(0, 120);
}

export function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '';
  return number.toFixed(1);
}

/** textBaseline="middle" 时字形底部相对基线的偏移。 */
export function glyphBottomOffset(ctx, size, weight, family, text) {
  setCanvasFont(ctx, size, weight, family);
  const metrics = ctx.measureText(text || '');
  if (metrics && typeof metrics.actualBoundingBoxDescent === 'number' && metrics.actualBoundingBoxDescent > 0) {
    return metrics.actualBoundingBoxDescent;
  }
  return size * 0.35;
}
