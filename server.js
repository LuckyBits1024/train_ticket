import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CookieJar } from './src/cookies.js';
import { HttpClient, ApiError } from './src/http.js';
import { SessionStore } from './src/store.js';
import { RailClient } from './src/rail.js';
import { buildCsv, buildJson, collectRecords, flattenRecords } from './src/export.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSETS_DIR = path.join(ROOT, 'assets');
const DATA_DIR = path.join(ROOT, 'data');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

const HOST = process.env.HOST || '127.0.0.1';
const PREFERRED_PORT = Number(process.env.PORT) || 5178;
const TZ = 'Asia/Shanghai';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

const store = await new SessionStore(SESSION_FILE).load();
const jar = store.jar ?? new CookieJar();
store.jar = jar;
const httpClient = new HttpClient({ jar });
const rail = new RailClient({ http: httpClient, store });

let lastSaved = 0;
async function maybeSave(force = false) {
  if (!force && Date.now() - lastSaved < 60_000) return;
  lastSaved = Date.now();
  try {
    await store.save();
  } catch (error) {
    console.warn('[session] 保存失败:', error.message);
  }
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

function defaultRange() {
  const end = today();
  return { start: shiftDate(end, -365), end };
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function resolveRange(url) {
  const fallback = defaultRange();
  const start = url.searchParams.get('start') || fallback.start;
  const end = url.searchParams.get('end') || fallback.end;
  if (!isValidDate(start) || !isValidDate(end)) {
    throw new ApiError('日期格式应为 YYYY-MM-DD', { code: 'BAD_DATE' });
  }
  if (start > end) throw new ApiError('开始日期不能晚于结束日期', { code: 'BAD_DATE' });
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  if (days > 731) throw new ApiError('查询区间最长支持 2 年', { code: 'BAD_DATE' });
  return { start, end };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: { code, message, ...extra } });
}

function sendJsonCached(res, status, payload, maxAge = 86400) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${maxAge}`,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

let stationCache = null;
async function loadStationData() {
  if (stationCache) return stationCache;
  const [list, pinyin] = await Promise.all([
    readFile(path.join(ROOT, 'src', 'data', 'stations-index.json'), 'utf8').then(JSON.parse),
    readFile(path.join(ROOT, 'src', 'data', 'stations-pinyin.json'), 'utf8').then(JSON.parse),
  ]);
  stationCache = { list, pinyin };
  return stationCache;
}

function textValue(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function firstValue(source, keys) {
  for (const key of keys) {
    const value = textValue(source?.[key]);
    if (value) return value;
  }
  return '';
}

function compactDate(value) {
  const text = textValue(value);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dashed = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return dashed ? `${dashed[1]}-${dashed[2]}-${dashed[3]}` : '';
}

function draftFromDetail(record, index, pinyins) {
  const detail = record.detail || {};
  const raw = detail.raw && typeof detail.raw === 'object' ? detail.raw : {};
  const from = textValue(detail.from) || firstValue(raw, ['board_station_name', 'resign_board_station_name']);
  const to = textValue(detail.to) || firstValue(raw, ['arrive_station_name', 'resign_arrive_station_name']);
  const trainNo = textValue(detail.trainCode).replace(/次$/, '');
  const date = compactDate(detail.travelDate || firstValue(raw, ['train_date', 'resign_train_date']));
  const time = firstValue(raw, ['start_time', 'train_start_time', 'depart_time', 'departure_time']);
  const price = firstValue(raw, ['ticket_price', 'sale_price', 'ticketPrice', 'salePrice']);
  const seatNo = firstValue(raw, ['seat_no', 'seat_number', 'seatNo', 'seatNumber']);
  const passenger = textValue(detail.passenger) || firstValue(raw, ['v_assignee_id_name', 'passenger_name']);
  return {
    id: `${record.trade?.id || 'record'}-${index + 1}`,
    style: index % 8 === 5 ? 'red' : 'blue',
    ticketNo: '',
    checkinRoom: '',
    startStation: from.replace(/站$/, ''),
    startStationPY: pinyins[from.replace(/站$/, '')] || '',
    endStation: to.replace(/站$/, ''),
    endStationPY: pinyins[to.replace(/站$/, '')] || '',
    trainNo,
    seatClass: textValue(detail.seat),
    date,
    time: /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : '',
    carriageNo: textValue(detail.coach).replace(/车$/, ''),
    seatNo,
    seatPosition: '',
    price: /^\d+(?:\.\d{1,2})?$/.test(price) ? price : '',
    identity: '',
    name: passenger,
    info1: '2',
    info2: '仅供纪念使用',
    info3: '0',
    machineId: '',
    qrcodeString: 'https://www.12306.cn/',
    qrEnabled: true,
    flags: { child: false, student: false, online: false, discount: false },
    fontScale: 1,
    fontWeight: 500,
    fontScheme: { zh: '', en: '', num: '' },
    back: null,
    source: 'points',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError('请求体过大', { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('请求体不是合法 JSON', { code: 'BAD_BODY' });
  }
}

/* ------------------------------------------------------------------ */
/* 扫码登录状态机                                                       */
/* ------------------------------------------------------------------ */

let qrSession = null;

function qrPublicState(session) {
  return {
    uuid: session.uuid,
    state: session.state,
    message: session.message || '',
    user: session.state === 'confirmed' ? session.user : null,
  };
}

/* ------------------------------------------------------------------ */
/* 导出任务                                                             */
/* ------------------------------------------------------------------ */

const exportJobs = new Map();
let runningJob = null;

function jobSnapshot(job) {
  const percent =
    job.state === 'done'
      ? 100
      : job.progress
        ? Math.min(99, Math.round(job.progress.percent || 0))
        : 0;
  return {
    id: job.id,
    state: job.state,
    format: job.format,
    start: job.start,
    end: job.end,
    includeDetails: job.includeDetails,
    progress: job.progress,
    percent,
    error: job.error || null,
    filename: job.filename || null,
    size: job.size || null,
    downloadUrl: job.state === 'done' ? `/api/export/${job.id}/download` : null,
    createdAt: job.createdAt,
  };
}

function computePercent(progress) {
  if (!progress) return 0;
  if (progress.phase === 'list') {
    const ratio = progress.total ? progress.done / progress.total : 0;
    return 5 + ratio * 20;
  }
  if (progress.phase === 'detail') {
    const ratio = progress.total ? progress.done / progress.total : 0;
    return 25 + ratio * 75;
  }
  if (progress.phase === 'done') return 100;
  return 2;
}

async function runExportJob(job) {
  const started = Date.now();
  try {
    const { records } = await collectRecords({
      client: rail,
      start: job.start,
      end: job.end,
      includeDetails: job.includeDetails,
      onProgress: (progress) => {
        job.progress = { ...progress, percent: computePercent(progress) };
      },
    });

    let content;
    let ext;
    if (job.format === 'json') {
      const summary = await rail.getSummary().catch(() => null);
      content = JSON.stringify(
        buildJson({
          range: { start: job.start, end: job.end },
          user: rail.user,
          summary,
          records,
          generatedAt: new Date().toISOString(),
        }),
        null,
        2,
      );
      ext = 'json';
    } else {
      content = buildCsv(flattenRecords(records));
      ext = 'csv';
    }

    await mkdir(EXPORT_DIR, { recursive: true });
    const filename = `12306-points_${job.start}_${job.end}.${ext}`;
    const filePath = path.join(EXPORT_DIR, filename);
    await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });

    job.state = 'done';
    job.filename = filename;
    job.filePath = filePath;
    job.size = Buffer.byteLength(content);
    job.progress = {
      phase: 'done',
      done: records.length,
      total: records.length,
      message: `导出完成，共 ${records.length} 条流水`,
      percent: 100,
    };
    console.log(
      `[export] ${filename} 完成：${records.length} 条流水，${job.size} 字节，耗时 ${Date.now() - started}ms`,
    );
  } catch (error) {
    job.state = 'error';
    job.error = error.message;
    console.warn('[export] 失败:', error.message);
  } finally {
    if (runningJob === job) runningJob = null;
    for (const [id, old] of exportJobs) {
      if (exportJobs.size <= 20) break;
      if (old.state !== 'running') exportJobs.delete(id);
    }
  }
}

async function cleanupOldExports() {
  try {
    await mkdir(EXPORT_DIR, { recursive: true });
    const files = await readdir(EXPORT_DIR);
    const cutoff = Date.now() - 7 * 86400000;
    for (const name of files) {
      if (name.startsWith('.')) continue;
      const full = path.join(EXPORT_DIR, name);
      const info = await stat(full);
      if (info.mtimeMs < cutoff) await unlink(full);
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    if (!jar.get('JSESSIONID', 'https://cx.12306.cn/tlcx/')) {
      return sendJson(res, 200, { loggedIn: false, user: null, updatedAt: store.updatedAt });
    }
    try {
      const user = await rail.checkLogin({ force: true });
      if (user) await maybeSave();
      return sendJson(res, 200, {
        loggedIn: Boolean(user),
        user,
        updatedAt: store.updatedAt,
      });
    } catch (error) {
      return sendJson(res, 200, {
        loggedIn: false,
        user: null,
        offline: true,
        message: error.message,
        updatedAt: store.updatedAt,
      });
    }
  }

  if (pathname === '/api/summary' && req.method === 'GET') {
    const summary = await rail.getSummary();
    await maybeSave();
    return sendJson(res, 200, { summary, user: rail.user });
  }

  if (pathname === '/api/points' && req.method === 'GET') {
    const { start, end } = resolveRange(url);
    const type = ['0', '1', '2'].includes(searchParams.get('type') || '')
      ? searchParams.get('type')
      : '0';
    const page = Math.max(1, Number(searchParams.get('page')) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(searchParams.get('pageSize')) || 10));
    const { rows, total } = await rail.queryPoints({ type, start, end, page, pageSize });
    await maybeSave();
    return sendJson(res, 200, { rows, total, page, pageSize, type, start, end });
  }

  if (pathname === '/api/detail' && req.method === 'GET') {
    const type = searchParams.get('type') || '';
    const id = searchParams.get('id') || '';
    if (!id) throw new ApiError('缺少流水 ID', { code: 'BAD_REQUEST' });
    const { details } = await rail.getDetail(type, id);
    return sendJson(res, 200, { details });
  }

  if (pathname === '/api/ticket/stations' && req.method === 'GET') {
    const { list } = await loadStationData();
    return sendJsonCached(res, 200, { updatedAt: new Date().toISOString().slice(0, 10), stations: list }, 86400);
  }

  if (pathname === '/api/ticket/records' && req.method === 'GET') {
    const user = await rail.checkLogin();
    if (!user) throw new ApiError('登录已失效，请重新扫码登录', { code: 'NO_LOGIN' });
    const { start, end } = resolveRange(url);
    const limit = Math.min(120, Math.max(1, Number(searchParams.get('limit')) || 60));
    const { records } = await collectRecords({
      client: rail,
      start,
      end,
      includeDetails: true,
    });
    const { pinyin } = await loadStationData();
    const flat = flattenRecords(records)
      .filter((record) => record.detail && record.detail.kind !== '商户消费')
      .slice(0, limit);
    const drafts = flat.map((record, index) => draftFromDetail(record, index, pinyin));
    return sendJson(res, 200, {
      range: { start, end },
      records: drafts,
      warnings: drafts.length
        ? ['积分明细不含发车时间、座位号与票价；票面对应字段会留空，可在工坊中补全。']
        : ['所选区间没有可生成车票的乘车记录。'],
    });
  }

  if (pathname === '/api/login/qr' && req.method === 'POST') {
    const qr = await rail.createQrCode();
    qrSession = {
      uuid: qr.uuid,
      image: qr.image,
      state: 'waiting',
      message: '等待扫码',
      createdAt: Date.now(),
      user: null,
      exchange: null,
    };
    return sendJson(res, 200, {
      uuid: qr.uuid,
      image: qr.image,
      state: 'waiting',
      expiresAt: Date.now() + 5 * 60_000,
    });
  }

  if (pathname.startsWith('/api/login/qr/') && req.method === 'GET') {
    const uuid = decodeURIComponent(pathname.slice('/api/login/qr/'.length));
    if (!qrSession || qrSession.uuid !== uuid) {
      return sendJson(res, 200, { state: 'expired', message: '二维码已失效，请刷新' });
    }
    if (qrSession.state === 'confirmed' || qrSession.state === 'error') {
      return sendJson(res, 200, qrPublicState(qrSession));
    }
    if (qrSession.exchange) {
      await qrSession.exchange;
      return sendJson(res, 200, qrPublicState(qrSession));
    }
    if (Date.now() - qrSession.createdAt > 5 * 60_000) {
      qrSession.state = 'expired';
      qrSession.message = '二维码已失效，请刷新';
      return sendJson(res, 200, qrPublicState(qrSession));
    }

    const result = await rail.checkQrCode(uuid);
    const code = String(result.result_code);

    if (code === '1') {
      qrSession.state = 'scanned';
      qrSession.message = '已扫码，请在手机上确认登录';
      return sendJson(res, 200, qrPublicState(qrSession));
    }

    if (code === '2') {
      if (!result.uamtk) {
        qrSession.state = 'error';
        qrSession.message = '扫码已确认，但未拿到登录票据，请重新扫码';
        return sendJson(res, 200, qrPublicState(qrSession));
      }
      qrSession.state = 'confirming';
      qrSession.message = '正在建立登录态…';
      qrSession.exchange = (async () => {
        try {
          const user = await rail.completeQrLogin({ uamtk: result.uamtk });
          qrSession.state = 'confirmed';
          qrSession.message = '登录成功';
          qrSession.user = user;
          await maybeSave(true);
          console.log(`[login] 扫码登录成功：${user.name || '(未知名)'}`);
        } catch (error) {
          qrSession.state = 'error';
          qrSession.message = error.message || '登录失败';
          console.warn('[login] 扫码登录失败:', error.message);
        }
      })();
      await qrSession.exchange;
      return sendJson(res, 200, qrPublicState(qrSession));
    }

    if (code === '3' || code === '4') {
      qrSession.state = 'expired';
      qrSession.message = '二维码已失效，请刷新';
      return sendJson(res, 200, qrPublicState(qrSession));
    }

    if (code === '5') {
      qrSession.state = 'error';
      qrSession.message = '12306 系统异常，请刷新二维码重试';
      return sendJson(res, 200, qrPublicState(qrSession));
    }

    qrSession.state = 'waiting';
    qrSession.message = code === '0' ? '等待扫码' : result.result_message || '等待扫码';
    return sendJson(res, 200, qrPublicState(qrSession));
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    await rail.logout();
    await store.clear();
    qrSession = null;
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/export' && req.method === 'POST') {
    if (runningJob && runningJob.state === 'running') {
      throw new ApiError('已有导出任务正在进行，请稍候', { code: 'EXPORT_RUNNING' });
    }
    const user = await rail.checkLogin();
    if (!user) throw new ApiError('登录已失效，请重新扫码登录', { code: 'NO_LOGIN' });
    const body = await readJsonBody(req);
    const { start, end } = resolveRange(
      new URL(`http://local/api/export?start=${body.start || ''}&end=${body.end || ''}`),
    );
    const format = body.format === 'json' ? 'json' : 'csv';
    const includeDetails = body.includeDetails !== false;
    const job = {
      id: randomUUID(),
      state: 'running',
      format,
      start,
      end,
      includeDetails,
      progress: {
        phase: 'list',
        done: 0,
        total: 0,
        message: '准备导出…',
        percent: 1,
      },
      createdAt: new Date().toISOString(),
    };
    exportJobs.set(job.id, job);
    runningJob = job;
    runExportJob(job);
    return sendJson(res, 202, { job: jobSnapshot(job) });
  }

  if (pathname.startsWith('/api/export/') && req.method === 'GET') {
    const rest = pathname.slice('/api/export/'.length);
    const [id, action] = rest.split('/');
    const job = exportJobs.get(id);
    if (!job) return fail(res, 404, 'EXPORT_NOT_FOUND', '导出任务不存在或已过期');
    if (action === 'download') {
      if (job.state !== 'done' || !job.filePath) {
        return fail(res, 409, 'EXPORT_NOT_READY', '导出尚未完成');
      }
      const content = await readFile(job.filePath);
      res.writeHead(200, {
        'content-type':
          job.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${job.filename}"`,
        'content-length': content.length,
        'cache-control': 'no-store',
      });
      return res.end(content);
    }
    return sendJson(res, 200, { job: jobSnapshot(job) });
  }

  return fail(res, 404, 'NOT_FOUND', '接口不存在');
}

async function serveAssets(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname.slice('/assets/'.length));
  } catch {
    return fail(res, 400, 'BAD_REQUEST', '非法路径');
  }
  if (!pathname || pathname.startsWith('.') || pathname.includes('\0')) {
    return fail(res, 403, 'FORBIDDEN', '禁止访问');
  }
  const filePath = path.resolve(ASSETS_DIR, pathname);
  if (!filePath.startsWith(`${ASSETS_DIR}${path.sep}`)) {
    return fail(res, 403, 'FORBIDDEN', '禁止访问');
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
      'content-length': content.length,
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return fail(res, 404, 'NOT_FOUND', '资源不存在');
    throw error;
  }
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    return fail(res, 403, 'FORBIDDEN', '禁止访问');
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
      'content-length': content.length,
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return fail(res, 404, 'NOT_FOUND', '页面不存在');
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 服务器                                                               */
/* ------------------------------------------------------------------ */

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / 本地脚本
  try {
    const target = new URL(origin);
    return target.hostname === '127.0.0.1' || target.hostname === 'localhost';
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PREFERRED_PORT}`}`);
  } catch {
    return fail(res, 400, 'BAD_REQUEST', '非法 URL');
  }

  res.on('finish', () => {
    if (url.pathname.startsWith('/api/')) {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(req)) {
        return fail(res, 403, 'FORBIDDEN', '仅允许本机页面调用');
      }
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
    }
    if (url.pathname.startsWith('/assets/')) {
      return await serveAssets(req, res, url);
    }
    return await serveStatic(req, res, url);
  } catch (error) {
    if (error instanceof ApiError) {
      const status =
        error.code === 'NO_LOGIN'
          ? 401
          : ['BAD_DATE', 'BAD_REQUEST', 'BAD_BODY', 'BODY_TOO_LARGE'].includes(error.code)
            ? 400
            : error.code === 'EXPORT_RUNNING'
              ? 409
              : 502;
      return fail(res, status, error.code, error.message);
    }
    console.error('[server] 未处理异常:', error);
    if (!res.headersSent) {
      return fail(res, 500, 'INTERNAL_ERROR', '服务器内部错误，请查看终端日志');
    }
    return res.end();
  }
});

async function listen(port, attempt = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE' && attempt < 12) {
        resolve(listen(port + 1, attempt + 1));
      } else {
        reject(error);
      }
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

await cleanupOldExports();
await mkdir(DATA_DIR, { recursive: true });

const port = await listen(PREFERRED_PORT);
console.log('');
console.log('  12306 会员积分 · 本地查询/导出工具');
console.log(`  → http://${HOST}:${port}`);
console.log(`  会话文件：${SESSION_FILE}`);
console.log('  扫码登录后 Cookie 仅保存在本机，不会上传到任何第三方。');
console.log('');

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] 收到 ${signal}，保存会话并退出…`);
  await maybeSave(true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
