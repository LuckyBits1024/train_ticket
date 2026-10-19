/** 导出：PNG、正面+背面合并、批量 ZIP（store-only，零依赖）。 */

import { composeFrontBack, renderBack, renderFront } from './renderer.js';
import { sanitizeFileName } from './layout.js';

export function canvasToBlob(canvas, type = 'image/png', quality = undefined) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('画布导出失败'));
    }, type, quality);
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function ticketFileName(draft, template) {
  const parts = [
    draft.date || 'trip',
    draft.trainNo || 'train',
    draft.startStation || 'from',
    draft.endStation || 'to',
    draft.name || '',
    template.key,
  ].filter(Boolean);
  return `${sanitizeFileName(parts.join('-'), 'ticket')}.png`;
}

export async function renderDraft(draft, template, { scale = 2, templateFor, withBack = false, signal } = {}) {
  const front = document.createElement('canvas');
  await renderFront(front, draft, template, { scale, signal });
  if (!withBack || !draft.back) return { front, back: null, merged: null };
  const back = document.createElement('canvas');
  await renderBack(back, draft, template, draft.back, { scale, templateFor, signal });
  const merged = composeFrontBack(front, back, { logicalWidth: template.canvas.width });
  return { front, back, merged };
}

export async function exportSingle(draft, template, { scale = 2, mode = 'none', templateFor } = {}) {
  const withBack = mode !== 'none' && Boolean(draft.back);
  const { front, back, merged } = await renderDraft(draft, template, { scale, templateFor, withBack });
  const base = ticketFileName(draft, template).replace(/\.png$/i, '');
  if (mode === 'merge' && merged) {
    const blob = await addPngMetadata(await canvasToBlob(merged), {
      Description: '纪念车票 · 不作乘车凭证',
      Software: 'Rail Memory v2',
      Template: draft.style,
    });
    downloadBlob(blob, `${base}-front-back.png`);
    return 1;
  }
  if (mode === 'split' && back) {
    const frontBlob = await addPngMetadata(await canvasToBlob(front), {
      Description: '纪念车票 · 不作乘车凭证',
      Software: 'Rail Memory v2',
      Template: draft.style,
    });
    const backBlob = await addPngMetadata(await canvasToBlob(back), {
      Description: '纪念车票 · 不作乘车凭证',
      Software: 'Rail Memory v2',
      Template: draft.style,
    });
    downloadBlob(frontBlob, `${base}-front.png`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    downloadBlob(backBlob, `${base}-back.png`);
    return 2;
  }
  const blob = await addPngMetadata(await canvasToBlob(front), {
    Description: '纪念车票 · 不作乘车凭证',
    Software: 'Rail Memory v2',
    Template: draft.style,
  });
  downloadBlob(blob, `${base}.png`);
  return 1;
}

/* ---------------- ZIP (store only) ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function be32(value) {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function iTXtChunk(keyword, value) {
  const encoder = new TextEncoder();
  const key = encoder.encode(keyword);
  const text = encoder.encode(String(value));
  const data = concat([
    key,
    new Uint8Array([0, 0, 0, 0, 0]),
    text,
  ]);
  return concat([be32(data.length), encoder.encode('iTXt'), data, be32(crc32(concat([encoder.encode('iTXt'), data])))]);
}

/** 给 Canvas 生成的 PNG 写入 iTXt 元数据（Description / Software / Template）。 */
export async function addPngMetadata(blob, metadata = {}) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  if (buffer.length < 33 || buffer[0] !== 0x89 || buffer[1] !== 0x50) return blob;
  const chunks = [buffer.slice(0, 8)];
  let offset = 8;
  let inserted = false;
  while (offset + 12 <= buffer.length) {
    const length = (buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
    const end = offset + 12 + length;
    if (end > buffer.length) break;
    const chunk = buffer.slice(offset, end);
    const type = String.fromCharCode(...buffer.slice(offset + 4, offset + 8));
    chunks.push(chunk);
    offset = end;
    if (type === 'IHDR' && !inserted) {
      for (const [key, value] of Object.entries(metadata)) {
        if (value !== undefined && value !== null && String(value).trim()) chunks.push(iTXtChunk(key, value));
      }
      inserted = true;
    }
  }
  return new Blob(chunks, { type: 'image/png' });
}

function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

export function createZip(entries) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(day),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);
    localParts.push(local);

    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(day),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    centralParts.push(central);
    offset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(offset),
    u16(0),
  ]);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

function uniqueName(name, used) {
  let candidate = name;
  let index = 2;
  while (used.has(candidate)) {
    candidate = name.replace(/(\.[^.]+)?$/, (ext) => `-${index}${ext || ''}`);
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 批量导出：每张正面；如果 draft.back 存在则按 merge/split 加入背面。
 * onProgress(done, total, label)
 */
export async function exportBatch(drafts, templateFor, { scale = 2, mode = 'none', onProgress, signal } = {}) {
  const used = new Set();
  const entries = [];
  const total = drafts.length;
  let done = 0;
  for (const draft of drafts) {
    if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
    const template = templateFor(draft.style);
    const withBack = mode !== 'none' && Boolean(draft.back);
    const { front, back, merged } = await renderDraft(draft, template, { scale, templateFor, withBack });
    const base = ticketFileName(draft, template).replace(/\.png$/i, '');
    if (mode === 'merge' && merged) {
      const blob = await addPngMetadata(await canvasToBlob(merged), {
        Description: '纪念车票 · 不作乘车凭证',
        Software: 'Rail Memory v2',
        Template: draft.style,
      });
      entries.push({ name: uniqueName(`${base}-front-back.png`, used), data: new Uint8Array(await blob.arrayBuffer()) });
    } else if (mode === 'split' && back) {
      const frontBlob = await addPngMetadata(await canvasToBlob(front), {
        Description: '纪念车票 · 不作乘车凭证',
        Software: 'Rail Memory v2',
        Template: draft.style,
      });
      const backBlob = await addPngMetadata(await canvasToBlob(back), {
        Description: '纪念车票 · 不作乘车凭证',
        Software: 'Rail Memory v2',
        Template: draft.style,
      });
      entries.push({ name: uniqueName(`${base}-front.png`, used), data: new Uint8Array(await frontBlob.arrayBuffer()) });
      entries.push({ name: uniqueName(`${base}-back.png`, used), data: new Uint8Array(await backBlob.arrayBuffer()) });
    } else {
      const blob = await addPngMetadata(await canvasToBlob(front), {
        Description: '纪念车票 · 不作乘车凭证',
        Software: 'Rail Memory v2',
        Template: draft.style,
      });
      entries.push({ name: uniqueName(`${base}.png`, used), data: new Uint8Array(await blob.arrayBuffer()) });
    }
    done += 1;
    onProgress?.(done, total, draft.name || draft.trainNo || `第 ${done} 张`);
  }
  const zip = createZip(entries);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(zip, `memory-tickets-${stamp}.zip`);
  return entries.length;
}
