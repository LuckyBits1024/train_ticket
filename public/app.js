const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const CN_NUM = ['', '一', '二', '三', '四', '五'];
const PAGE_SIZE = 10;

const state = {
  loggedIn: false,
  user: null,
  summary: null,
  type: '0',
  start: '',
  end: '',
  page: 1,
  pageSize: PAGE_SIZE,
  total: 0,
  rows: [],
  loading: false,
  expandedId: null,
  detailCache: new Map(),
  loadedRange: null,
  qr: { uuid: null, timer: null, busy: false, failures: 0 },
  exportJob: null,
  exportTimer: null,
  toastTimer: null,
};

/* ------------------------------ utils ------------------------------ */

function icon(id) {
  return `<svg class="icon"><use href="#${id}"/></svg>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const numberFormatter = new Intl.NumberFormat('zh-CN');

function fmtNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? numberFormatter.format(n) : String(value ?? '—');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toast(message, type = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      el.hidden = true;
    }, 220);
  }, 3600);
}

async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
      error.code = data?.error?.code || 'HTTP_ERROR';
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('请求超时，请稍后重试');
    }
    if (error instanceof TypeError) {
      throw new Error('无法连接本地服务，请确认 node server.js 仍在运行');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ login state ------------------------------ */

function renderAccount() {
  const area = $('#accountArea');
  if (state.loggedIn && state.user) {
    area.innerHTML = `
      <span class="account-dot" title="已登录"></span>
      <span class="account-name">${esc(state.user.name || '会员')}</span>
      <button class="link-btn" data-action="logout">退出</button>
    `;
  } else {
    area.innerHTML = `<button class="btn btn-primary btn-sm" data-action="login">扫码登录</button>`;
  }
}

function resetSummary() {
  $('#summaryPanel').classList.add('is-guest');
  $('#userName').textContent = '请先登录';
  $('#userPhone').textContent = '登录后查看积分与乘车记录';
  $('#crowns').innerHTML = '';
  $('#pointsNow').textContent = '—';
  $('#levelMax').textContent = '—';
  $('#levelHint').textContent = '';
  $('#levelBar').style.width = '0%';
  $('#statAvailable').textContent = '—';
  $('#statExpiring').textContent = '—';
  $('#statSoon').textContent = '—';
  $('#statExpireLabel').textContent = '将于 — 到期';
  $('#avatar').classList.remove('has-user');
}

function renderSummary() {
  const user = state.user || {};
  const summary = state.summary || {};
  const panel = $('#summaryPanel');
  panel.classList.remove('is-guest');
  $('#avatar').classList.add('has-user');

  $('#userName').textContent = user.name || '会员';

  const level = Number(summary.memberLevel ?? user.memberLevel) || 0;
  $('#crowns').innerHTML = level
    ? Array.from({ length: Math.min(level, 5) }, () => icon('i-crown')).join('')
    : '';

  const code = summary.mobileCode ? `+${summary.mobileCode}` : '+86';
  const mobile = summary.mobile || user.mobile;
  $('#userPhone').textContent = mobile ? `(${code}) ${mobile}` : '已登录';

  const available = Number(summary.availablePoints) || 0;
  const threshold = Number(summary.nextLevelThreshold) || 0;
  const nextLevel = Number(summary.nextLevel) || 0;
  $('#statAvailable').textContent = fmtNumber(available);
  $('#statExpiring').textContent = fmtNumber(summary.expiringPoints || 0);
  $('#statSoon').textContent = fmtNumber(summary.expiringSoonPoints || 0);
  $('#statExpireLabel').textContent = summary.expiringDate
    ? `将于${summary.expiringDate}到期`
    : '将于 — 到期';

  $('#pointsNow').textContent = fmtNumber(available);
  $('#levelMax').textContent = threshold ? fmtNumber(threshold) : '—';
  const percent = threshold ? Math.min(100, (available / threshold) * 100) : level >= 5 ? 100 : 0;
  $('#levelBar').style.width = `${percent.toFixed(1)}%`;

  if (level >= 5) {
    $('#levelHint').textContent = '已是五星会员';
  } else if (nextLevel && Number(summary.memberLevelDiff) > 0) {
    $('#levelHint').textContent = `还需${fmtNumber(summary.memberLevelDiff)}积分，可升级为${CN_NUM[nextLevel] || nextLevel}星`;
  } else if (threshold) {
    $('#levelHint').textContent = `满${fmtNumber(threshold)}积分，可升级为${CN_NUM[nextLevel] || nextLevel}星`;
  } else {
    $('#levelHint').textContent = '';
  }
}

function renderGuestTable(message = '登录后查看积分明细', detail = '使用铁路12306 App 扫码，即可读取本人积分与乘车记录') {
  $('#tableBody').innerHTML = '';
  setTableVisible(false);
  const box = $('#tableState');
  box.hidden = false;
  box.innerHTML = `
    <svg class="state-icon"><use href="#i-ticket"/></svg>
    <div class="state-title">${esc(message)}</div>
    <div>${esc(detail)}</div>
    <div class="state-actions"><button class="btn btn-primary" data-action="login">扫码登录</button></div>
  `;
  $('#pager').hidden = true;
  $('#pagerTotal').textContent = '';
  $('#pagerBtns').innerHTML = '';
}

function renderGuest() {
  resetSummary();
  renderGuestTable();
  updateRangeHint();
}

function onSessionExpired() {
  state.loggedIn = false;
  state.user = null;
  state.summary = null;
  state.rows = [];
  state.total = 0;
  state.expandedId = null;
  state.detailCache.clear();
  renderAccount();
  renderGuest();
  const modalOpen = !$('#loginModal').hidden;
  if (!modalOpen) toast('登录已失效，请重新扫码登录', 'error');
}

/* ------------------------------ data loading ------------------------------ */

async function loadSession() {
  try {
    const data = await api('/api/state', { timeout: 20000 });
    state.loggedIn = Boolean(data.loggedIn);
    state.user = data.user || null;
    renderAccount();
    if (data.offline) {
      toast(data.message || '暂时无法连接 12306，请稍后重试', 'error');
    }
    return state.loggedIn;
  } catch (error) {
    toast(error.message, 'error');
    state.loggedIn = false;
    state.user = null;
    renderAccount();
    return false;
  }
}

async function loadSummary() {
  try {
    const data = await api('/api/summary');
    state.summary = data.summary || null;
    if (data.user) state.user = data.user;
    renderSummary();
  } catch (error) {
    if (error.code === 'NO_LOGIN') return onSessionExpired();
    toast(error.message || '积分概览加载失败', 'error');
  }
}

function setTableVisible(visible) {
  $('#tableScroll').hidden = !visible;
}

function skeletonTable() {
  const rows = Array.from(
    { length: 6 },
    () => `
      <tr class="skeleton-row" aria-hidden="true">
        <td><div class="skeleton w80"></div></td>
        <td><div class="skeleton w40"></div></td>
        <td><div class="skeleton w60"></div></td>
        <td><div class="skeleton w60"></div></td>
        <td><div class="skeleton w80"></div></td>
      </tr>`,
  ).join('');
  $('#tableBody').innerHTML = rows;
  setTableVisible(false);
  $('#tableState').hidden = true;
  $('#pager').hidden = true;
}

async function loadPoints() {
  if (!state.loggedIn) {
    renderGuestTable();
    return;
  }
  if (state.loading) return;
  state.loading = true;
  state.expandedId = null;
  $('#queryBtn').disabled = true;
  skeletonTable();

  try {
    const params = new URLSearchParams({
      type: state.type,
      start: state.start,
      end: state.end,
      page: String(state.page),
      pageSize: String(state.pageSize),
    });
    const data = await api(`/api/points?${params.toString()}`);
    state.rows = Array.isArray(data.rows) ? data.rows : [];
    state.total = Number(data.total) || 0;
    state.page = Number(data.page) || 1;
    state.loadedRange = { start: state.start, end: state.end };
    renderTable();
    renderPager();
  } catch (error) {
    state.loadedRange = null;
    if (error.code === 'NO_LOGIN') {
      onSessionExpired();
    } else {
      renderTableError(error.message);
      toast(error.message, 'error');
    }
  } finally {
    state.loading = false;
    $('#queryBtn').disabled = false;
    updateRangeHint();
  }
}

/* ------------------------------ table ------------------------------ */

function tradeRowHtml(row) {
  const isExpense = row.direction === 'expense';
  return `
    <tr class="trade-row" data-id="${esc(row.id)}" data-type="${esc(row.type)}"
        tabindex="0" role="button" aria-expanded="false">
      <td class="cell-date"><span class="caret">›</span>${esc(row.time)}</td>
      <td class="cell-points ${isExpense ? 'expense' : 'income'}">${isExpense ? '-' : '+'}${fmtNumber(row.points)}</td>
      <td>${esc(row.project || '—')}</td>
      <td>${esc(row.expiry || '—')}</td>
      <td class="cell-remark" title="${esc(row.remark || '')}">${esc(row.remark || '—')}</td>
    </tr>`;
}

function renderTable() {
  const body = $('#tableBody');
  const box = $('#tableState');

  if (!state.rows.length) {
    body.innerHTML = '';
    setTableVisible(false);
    box.hidden = false;
    box.innerHTML = `
      <svg class="state-icon"><use href="#i-ticket"/></svg>
      <div class="state-title">暂无积分记录</div>
      <div>当前日期区间没有查到积分流水，换个日期范围试试</div>
    `;
    return;
  }

  box.hidden = true;
  setTableVisible(true);
  body.innerHTML = state.rows.map(tradeRowHtml).join('');
}

function renderTableError(message) {
  $('#tableBody').innerHTML = '';
  setTableVisible(false);
  const box = $('#tableState');
  box.hidden = false;
  box.innerHTML = `
    <svg class="state-icon"><use href="#i-ticket"/></svg>
    <div class="state-title">加载失败</div>
    <div>${esc(message)}</div>
    <div class="state-actions"><button class="btn btn-soft" data-action="retry">重新加载</button></div>
  `;
  $('#pager').hidden = true;
}

function collapseDetail() {
  $$('.trade-row.active').forEach((row) => {
    row.classList.remove('active');
    row.setAttribute('aria-expanded', 'false');
  });
  $$('.detail-row').forEach((row) => row.remove());
  state.expandedId = null;
}

function detailItem(label, value) {
  const text = value === null || value === undefined || value === '' ? '—' : value;
  return `<span class="detail-item"><i>${esc(label)}：</i><b>${esc(text)}</b></span>`;
}

function detailHtml(details) {
  if (!Array.isArray(details) || !details.length) {
    return `<div class="detail-empty">此订单无积分详情</div>`;
  }
  return details
    .map((detail) => {
      const items = [];
      if (detail.passenger) items.push(detailItem('乘车人', detail.passenger));
      if (detail.travelDate) items.push(detailItem('乘车日期', detail.travelDate));
      if (detail.trainCode) items.push(detailItem('车次', detail.trainCode));
      if (detail.from || detail.to) {
        items.push(detailItem('区间', `${detail.from || '—'} -- ${detail.to || '—'}`));
      }
      if (detail.seat) items.push(detailItem('席别', detail.seat));
      if (detail.coach) items.push(detailItem('车厢号', detail.coach));
      if (detail.orderNo) items.push(detailItem('订单号', detail.orderNo));
      if (detail.merchant) items.push(detailItem('商户名称', detail.merchant));

      const extra = [];
      if (detail.pointDiff !== '' && detail.pointDiff !== undefined && detail.pointDiff !== null) {
        extra.push(detailItem(detail.kind === '改签' ? '改签积分差值' : '升席积分', detail.pointDiff));
      }
      if (detail.pointFee !== '' && detail.pointFee !== undefined && detail.pointFee !== null) {
        extra.push(detailItem('手续费', detail.pointFee));
      }

      const kind =
        detail.kind && detail.kind !== '乘车'
          ? `<span class="detail-kind">${esc(detail.kind)}</span>`
          : '';
      return `
        <div class="detail-line">${kind}${items.join('')}</div>
        ${extra.length ? `<div class="detail-line">${extra.join('')}</div>` : ''}
      `;
    })
    .join('');
}

async function toggleRow(rowEl) {
  const id = rowEl.dataset.id;
  const type = rowEl.dataset.type;

  if (state.expandedId === id) {
    collapseDetail();
    return;
  }

  collapseDetail();
  rowEl.classList.add('active');
  rowEl.setAttribute('aria-expanded', 'true');
  state.expandedId = id;

  const detailRow = document.createElement('tr');
  detailRow.className = 'detail-row';
  detailRow.innerHTML = `<td colspan="5"><div class="detail-inner">
    <div class="detail-loading"><span class="spinner" style="width:16px;height:16px"></span>正在加载乘车明细…</div>
  </div></td>`;
  rowEl.after(detailRow);

  const key = `${type}:${id}`;
  const cached = state.detailCache.get(key);

  const paint = (details) => {
    const inner = detailRow.querySelector('.detail-inner');
    if (!inner) return;
    inner.innerHTML = detailHtml(details);
  };

  if (cached) {
    paint(cached);
    return;
  }

  try {
    const data = await api(`/api/detail?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
    state.detailCache.set(key, data.details || []);
    if (state.expandedId === id && detailRow.isConnected) paint(data.details || []);
  } catch (error) {
    if (error.code === 'NO_LOGIN') return onSessionExpired();
    if (state.expandedId === id && detailRow.isConnected) {
      detailRow.querySelector('.detail-inner').innerHTML = `<div class="detail-empty">乘车明细加载失败：${esc(
        error.message,
      )}</div>`;
    }
  }
}

/* ------------------------------ pager ------------------------------ */

function pageItems(current, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const items = new Set([1, pages, current, current - 1, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((n) => items.add(n));
  if (current >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach((n) => items.add(n));
  const sorted = [...items].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const output = [];
  let prev = 0;
  for (const n of sorted) {
    if (prev && n - prev > 1) output.push('...');
    output.push(n);
    prev = n;
  }
  return output;
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const pager = $('#pager');
  if (!state.total) {
    pager.hidden = true;
    return;
  }
  pager.hidden = false;
  $('#pagerTotal').textContent = `共 ${fmtNumber(state.total)} 条`;
  const items = pageItems(state.page, pages);
  $('#pagerBtns').innerHTML = [
    `<button class="page-btn" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>`,
    ...items.map((item) =>
      item === '...'
        ? `<span class="page-ellipsis">…</span>`
        : `<button class="page-btn ${item === state.page ? 'active' : ''}" data-page="${item}">${item}</button>`,
    ),
    `<button class="page-btn" data-page="${state.page + 1}" ${state.page >= pages ? 'disabled' : ''}>下一页</button>`,
  ].join('');
}

/* ------------------------------ range / query ------------------------------ */

function initDates() {
  const now = new Date();
  const end = fmtDate(now);
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 365);
  const start = fmtDate(startDate);
  state.start = start;
  state.end = end;
  $('#startDate').value = start;
  $('#endDate').value = end;
  updateRangeHint();
}

function updateRangeHint() {
  const hint = $('#rangeHint');
  if (!state.start || !state.end) {
    hint.textContent = '默认查询最近一年';
    return;
  }
  const loaded =
    state.loadedRange &&
    state.loadedRange.start === state.start &&
    state.loadedRange.end === state.end;
  const suffix = loaded && state.total ? ` · 共 ${fmtNumber(state.total)} 条` : '';
  hint.textContent = `查询区间：${state.start} ~ ${state.end}${suffix}`;
}

function readRange() {
  const start = $('#startDate').value;
  const end = $('#endDate').value;
  if (!start || !end) throw new Error('请选择开始日期和结束日期');
  if (start > end) throw new Error('开始日期不能晚于结束日期');
  state.start = start;
  state.end = end;
  updateRangeHint();
}

function onQuery() {
  try {
    readRange();
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  state.page = 1;
  state.loadedRange = null;
  state.detailCache.clear();
  collapseDetail();
  loadPoints();
}

function onTabChange(type, button) {
  if (state.type === type) return;
  state.type = type;
  $$('.tab').forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  state.page = 1;
  state.loadedRange = null;
  state.detailCache.clear();
  collapseDetail();
  loadPoints();
}

function onPageChange(page) {
  if (!page || page < 1) return;
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (page > pages || page === state.page || state.loading) return;
  state.page = page;
  collapseDetail();
  loadPoints();
  $('#tableBody').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ------------------------------ login modal ------------------------------ */

function setQrStatus(kind, text) {
  const box = $('#qrStatus');
  box.className = `qr-status is-${kind}`;
  $('#qrStatusText').textContent = text;
}

function showQrOverlay({ text, retry = false, spinner = true }) {
  const overlay = $('#qrOverlay');
  overlay.hidden = false;
  $('#qrOverlayText').textContent = text;
  $('#qrSpinner').style.display = spinner ? '' : 'none';
  $('#qrRetryBtn').hidden = !retry;
}

function hideQrOverlay() {
  $('#qrOverlay').hidden = true;
}

function stopQrPolling() {
  if (state.qr.timer) {
    clearInterval(state.qr.timer);
    state.qr.timer = null;
  }
  state.qr.busy = false;
}

function openLogin() {
  $('#loginModal').hidden = false;
  document.body.style.overflow = 'hidden';
  createQr();
}

function closeLogin() {
  $('#loginModal').hidden = true;
  document.body.style.overflow = '';
  stopQrPolling();
  state.qr.uuid = null;
}

let qrGeneration = 0;

async function createQr() {
  stopQrPolling();
  const generation = (qrGeneration += 1);
  state.qr.uuid = null;
  state.qr.failures = 0;
  $('#qrImage').removeAttribute('src');
  showQrOverlay({ text: '正在生成二维码…' });
  setQrStatus('waiting', '正在获取二维码…');

  try {
    const data = await api('/api/login/qr', { method: 'POST', timeout: 25000 });
    if (generation !== qrGeneration || $('#loginModal').hidden) return;
    state.qr.uuid = data.uuid;
    const image = new Image();
    image.onload = () => {
      $('#qrImage').src = data.image;
      hideQrOverlay();
    };
    image.onerror = () => {
      showQrOverlay({ text: '二维码图片加载失败，请重新获取', retry: true, spinner: false });
    };
    image.src = data.image;
    setQrStatus('waiting', '等待扫码，请使用铁路12306 App');
    state.qr.timer = setInterval(pollQr, 1500);
  } catch (error) {
    showQrOverlay({ text: error.message, retry: true, spinner: false });
    setQrStatus('error', '二维码获取失败');
  }
}

async function pollQr() {
  const uuid = state.qr.uuid;
  if (!uuid || state.qr.busy) return;
  if ($('#loginModal').hidden) {
    stopQrPolling();
    return;
  }
  state.qr.busy = true;
  try {
    const data = await api(`/api/login/qr/${encodeURIComponent(uuid)}`, { timeout: 40000 });
    if (state.qr.uuid !== uuid) return;
    state.qr.failures = 0;

    if (data.state === 'confirmed') {
      stopQrPolling();
      setQrStatus('confirmed', '登录成功，正在加载数据…');
      hideQrOverlay();
      toast('扫码登录成功', 'success');
      setTimeout(async () => {
        closeLogin();
        const loggedIn = await loadSession();
        if (loggedIn) {
          await loadSummary();
          await loadPoints();
        }
      }, 600);
      return;
    }

    if (data.state === 'expired' || data.state === 'error') {
      stopQrPolling();
      showQrOverlay({
        text: data.message || '二维码已失效，请重新获取',
        retry: true,
        spinner: false,
      });
      setQrStatus('error', data.state === 'expired' ? '二维码已失效' : '登录失败');
      return;
    }

    if (data.state === 'scanned') {
      setQrStatus('scanned', data.message || '已扫码，请在手机上确认登录');
      return;
    }

    if (data.state === 'confirming') {
      setQrStatus('confirming', data.message || '正在建立登录态…');
      return;
    }

    setQrStatus('waiting', data.message || '等待扫码，请使用铁路12306 App');
  } catch (error) {
    state.qr.failures += 1;
    if (state.qr.failures >= 3) {
      stopQrPolling();
      showQrOverlay({ text: error.message, retry: true, spinner: false });
      setQrStatus('error', '网络异常，请重新获取二维码');
    }
  } finally {
    state.qr.busy = false;
  }
}

/* ------------------------------ export ------------------------------ */

function setExportButtons(disabled) {
  $('#exportCsvBtn').disabled = disabled;
  $('#exportJsonBtn').disabled = disabled;
}

function showExportPanel(text, percent) {
  const panel = $('#exportPanel');
  panel.className = 'export-panel';
  panel.hidden = false;
  $('#exportText').textContent = text;
  $('#exportBar').style.width = `${percent || 0}%`;
  $('#exportFile').hidden = true;
}

function updateExportPanel(job) {
  const panel = $('#exportPanel');
  panel.hidden = false;
  panel.classList.toggle('is-done', job.state === 'done');
  panel.classList.toggle('is-error', job.state === 'error');
  $('#exportBar').style.width = `${job.percent || 0}%`;
  $('#exportText').textContent =
    job.state === 'error'
      ? `导出失败：${job.error || '未知错误'}`
      : job.state === 'done'
        ? '导出完成，正在下载…'
        : job.progress?.message || '正在导出…';
  if (job.state === 'done' && job.filename) {
    $('#exportFile').hidden = false;
    $('#exportFile').innerHTML = `${icon('i-download')} ${esc(job.filename)}`;
  }
}

async function pollExport(jobId) {
  clearTimeout(state.exportTimer);
  try {
    const data = await api(`/api/export/${jobId}`);
    const job = data.job;
    state.exportJob = job;
    updateExportPanel(job);

    if (job.state === 'done') {
      setExportButtons(false);
      const link = document.createElement('a');
      link.href = job.downloadUrl;
      link.download = job.filename || '';
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast('导出完成，已开始下载', 'success');
      setTimeout(() => {
        $('#exportText').textContent = `已保存 ${job.filename}（${fmtNumber(Math.round((job.size || 0) / 1024))} KB）`;
      }, 800);
      return;
    }

    if (job.state === 'error') {
      setExportButtons(false);
      toast(job.error || '导出失败', 'error');
      return;
    }

    state.exportTimer = setTimeout(() => pollExport(jobId), 800);
  } catch (error) {
    setExportButtons(false);
    $('#exportPanel').classList.add('is-error');
    $('#exportText').textContent = `导出失败：${error.message}`;
    toast(error.message, 'error');
  }
}

async function startExport(format) {
  if (!state.loggedIn) {
    toast('请先扫码登录', 'error');
    openLogin();
    return;
  }
  try {
    readRange();
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  if (state.exportJob?.state === 'running' && state.exportJob?.id) {
    toast('已有导出任务正在进行，请稍候', 'info');
    return;
  }

  setExportButtons(true);
  showExportPanel('正在创建导出任务…', 2);
  try {
    const data = await api('/api/export', {
      method: 'POST',
      body: {
        format,
        start: state.start,
        end: state.end,
        includeDetails: $('#includeDetails').checked,
      },
      timeout: 20000,
    });
    state.exportJob = data.job;
    updateExportPanel(data.job);
    pollExport(data.job.id);
  } catch (error) {
    setExportButtons(false);
    $('#exportPanel').classList.add('is-error');
    $('#exportText').textContent = `导出失败：${error.message}`;
    toast(error.message, 'error');
  }
}

/* ------------------------------ events ------------------------------ */

function bindEvents() {
  $('#accountArea').addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'login') openLogin();
    if (action === 'logout') logout();
  });

  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) onTabChange(tab.dataset.type, tab);
  });

  $('#queryBtn').addEventListener('click', onQuery);
  $('#startDate').addEventListener('change', updateRangeHint);
  $('#endDate').addEventListener('change', updateRangeHint);

  $('#tableBody').addEventListener('click', (event) => {
    const row = event.target.closest('.trade-row');
    if (row) toggleRow(row);
  });

  $('#tableBody').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.trade-row');
    if (row) {
      event.preventDefault();
      toggleRow(row);
    }
  });

  $('#pagerBtns').addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (button) onPageChange(Number(button.dataset.page));
  });

  $('#tableState').addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'login') openLogin();
    if (action === 'retry') loadPoints();
  });

  $('#exportCsvBtn').addEventListener('click', () => startExport('csv'));
  $('#exportJsonBtn').addEventListener('click', () => startExport('json'));
  $('#exportCloseBtn').addEventListener('click', () => {
    $('#exportPanel').hidden = true;
  });

  $('#closeModalBtn').addEventListener('click', closeLogin);
  $('#loginModal').addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) closeLogin();
  });
  $('#qrRetryBtn').addEventListener('click', createQr);
  $('#qrRefreshBtn').addEventListener('click', createQr);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#loginModal').hidden) closeLogin();
  });
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* 本地退出失败也继续清理界面 */
  }
  state.loggedIn = false;
  state.user = null;
  state.summary = null;
  state.rows = [];
  state.total = 0;
  state.expandedId = null;
  state.detailCache.clear();
  renderAccount();
  renderGuest();
  toast('已退出登录，本机会话已清除', 'success');
}

/* ------------------------------ boot ------------------------------ */

async function boot() {
  bindEvents();
  initDates();
  const loggedIn = await loadSession();
  if (loggedIn) {
    await loadSummary();
    await loadPoints();
  } else {
    renderGuest();
    if (new URLSearchParams(location.search).get('login') === '1') openLogin();
  }
}

boot();
