/** 车票工坊页面：状态、表单、预览、PDF/积分导入、背面、导出。 */

import {
  loadTemplates,
  getTemplate,
  templateThumb,
  assetUrl,
} from './templates.js';
import {
  DEFAULT_QR,
  defaultDraft,
  demoDraft,
  hasErrors,
  normalizeTicket,
} from './validate.js';
import {
  attachStationAutocomplete,
  loadStations,
  pinyinFor,
} from './stations.js';
import * as store from './store.js';
import {
  DEFAULT_BACK_TERMS,
  DEFAULT_BACK_TITLE,
  renderBack,
  renderFront,
} from './renderer.js';
import { exportBatch, exportSingle } from './export.js';
import { applyParsed, createOrigins, markManual } from './fill.js';
import { extractPdf, parsePdfText } from './pdf.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const FONT_OPTIONS = {
  zh: ['', 'PingFang SC', 'HarmonyOS Sans SC', 'Noto Sans SC', 'Microsoft YaHei', 'Songti SC', 'SimSun'],
  en: ['', 'Times New Roman', 'Arial', 'Georgia', 'Garamond', 'Verdana'],
  num: ['', 'Times New Roman', 'Arial', 'Georgia', 'Courier New'],
};

const FIELD_LABELS = {
  ticketNo: '票号',
  checkinRoom: '检票口',
  startStation: '始发站',
  startStationPY: '始发站拼音',
  endStation: '到达站',
  endStationPY: '到达站拼音',
  trainNo: '车次',
  seatClass: '席别',
  date: '日期',
  time: '时间',
  carriageNo: '车厢',
  seatNo: '座位',
  seatPosition: '铺位',
  price: '票价',
  identity: '证件号',
  name: '姓名',
  machineId: '取票机号',
  qrcodeString: '二维码',
};

const state = {
  manifest: null,
  stations: [],
  trips: [],
  index: 0,
  origins: createOrigins(),
  renderSeq: 0,
  renderAbort: null,
  backRenderSeq: 0,
  backStyle: null,
  pendingPdf: null,
  pointsRecords: [],
  progressCancel: null,
  confirmResolve: null,
  exporting: false,
  saveTimer: null,
  statusTimer: null,
};

/* ---------------------------------------------------------------- 基础工具 */

function current() {
  return state.trips[state.index];
}

function templateFor(key) {
  if (!state.manifest) return null;
  return getTemplate(state.manifest, key);
}

function currentTemplate() {
  return templateFor(current()?.style || 'blue');
}

function setStatus(text, timeout = 1000) {
  const node = $('#previewStatus');
  if (!node) return;
  node.textContent = text;
  clearTimeout(state.statusTimer);
  if (timeout) {
    state.statusTimer = setTimeout(() => {
      node.textContent = '实时渲染';
    }, timeout);
  }
}

function toast(message, type = 'info') {
  const stack = $('#toastStack');
  if (!stack) return;
  const node = document.createElement('div');
  node.className = `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
  node.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#${
    type === 'error' ? 'i-warn' : type === 'success' ? 'i-check' : 'i-ticket'
  }"></use></svg><span></span>`;
  node.querySelector('span').textContent = String(message);
  stack.appendChild(node);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => node.remove(), 3200);
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function loadIconSprite() {
  try {
    const response = await fetch('/assets/design/icons.svg', { cache: 'force-cache' });
    if (!response.ok) return;
    const text = await response.text();
    const holder = document.createElement('div');
    holder.style.display = 'none';
    holder.setAttribute('aria-hidden', 'true');
    holder.innerHTML = text;
    document.body.prepend(holder);
  } catch {
    /* 图标失败不影响主要功能 */
  }
}

/* ---------------------------------------------------------------- 数据整理 */

function hydrateDraft(raw) {
  const base = defaultDraft();
  const draft = {
    ...base,
    ...(raw && typeof raw === 'object' ? raw : {}),
    flags: { ...base.flags, ...(raw?.flags || {}) },
    fontScheme: { ...base.fontScheme, ...(raw?.fontScheme || {}) },
    back: raw?.back || null,
  };
  if (!draft.origins || typeof draft.origins !== 'object' || Array.isArray(draft.origins)) {
    draft.origins = {};
  }
  return draft;
}

function sanitizeForStorage(draft) {
  const copy = JSON.parse(JSON.stringify(draft));
  if (copy.back) {
    if (copy.back.customImageId) delete copy.back.customImage;
    delete copy.back.applyAll;
  }
  return copy;
}

function serializeTrips() {
  return state.trips.map((trip) => ({ ...sanitizeForStorage(trip), origins: trip.origins || {} }));
}

function persist() {
  try {
    const trip = current();
    if (trip) {
      trip.origins = { ...state.origins };
      trip.updatedAt = new Date().toISOString();
    }
    store.saveTrips(serializeTrips());
    if (trip) store.saveDraft(sanitizeForStorage(trip));
  } catch {
    /* 本地存储失败不影响使用 */
  }
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(persist, 350);
}

function initTrips() {
  const savedTrips = store.loadTrips();
  if (Array.isArray(savedTrips) && savedTrips.length) {
    state.trips = savedTrips.map(hydrateDraft);
  } else {
    const savedDraft = store.loadDraft();
    state.trips = [hydrateDraft(savedDraft || demoDraft())];
  }
  state.index = Math.min(state.index, state.trips.length - 1);
  state.origins = { ...(state.trips[state.index].origins || {}) };
}

async function resolveStoredBackImages() {
  for (const trip of state.trips) {
    const back = trip.back;
    if (!back?.customImageId || back.customImage) continue;
    try {
      const blob = await store.getImage(back.customImageId);
      if (blob) back.customImage = URL.createObjectURL(blob);
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------------------------------------------- 表单同步 */

function populateFontSelects() {
  for (const [key, selectId] of [
    ['zh', '#schemeZh'],
    ['en', '#schemeEn'],
    ['num', '#schemeNum'],
  ]) {
    const select = $(selectId);
    if (!select) continue;
    select.innerHTML = '';
    for (const value of FONT_OPTIONS[key]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value || '系统默认';
      select.appendChild(option);
    }
  }
}

function syncTypeStrip() {
  const style = current()?.style || 'blue';
  $$('.type-chip').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.style === style);
    chip.setAttribute('aria-selected', chip.dataset.style === style ? 'true' : 'false');
  });
}

function renderTypeStrip() {
  const strip = $('#typeStrip');
  if (!strip || !state.manifest) return;
  strip.innerHTML = '';
  for (const template of state.manifest.templates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'type-chip';
    button.dataset.style = template.key;
    button.title = `${template.label} / ${template.labelEn}`;
    button.setAttribute('role', 'option');
    button.innerHTML = `<img alt="" loading="lazy" /><span></span>`;
    button.querySelector('img').src = templateThumb(template);
    button.querySelector('span').textContent = template.label;
    button.addEventListener('click', () => {
      const draft = current();
      if (!draft) return;
      draft.style = template.key;
      draft.source = 'manual';
      syncTypeStrip();
      requestRender();
      scheduleSave();
    });
    strip.appendChild(button);
  }
  syncTypeStrip();
}

function syncFormFromDraft() {
  const draft = current();
  if (!draft) return;
  for (const element of $$('[data-field]')) {
    const field = element.dataset.field;
    const value = draft[field] ?? '';
    if (element.type === 'checkbox') element.checked = Boolean(value);
    else if (element.value !== String(value)) element.value = String(value);
  }
  for (const element of $$('[data-flag]')) {
    element.checked = Boolean(draft.flags?.[element.dataset.flag]);
  }
  const qrEnabled = $('#qrEnabled');
  if (qrEnabled) qrEnabled.checked = draft.qrEnabled !== false;
  const fontScale = $('#fontScale');
  const fontWeight = $('#fontWeight');
  if (fontScale) fontScale.value = String(Math.round((draft.fontScale || 1) * 100));
  if (fontWeight) fontWeight.value = String(draft.fontWeight || 500);
  $('#fontScaleVal').textContent = `${Math.round((draft.fontScale || 1) * 100)}%`;
  $('#fontWeightVal').textContent = String(draft.fontWeight || 500);
  for (const [key, selectId] of [
    ['zh', '#schemeZh'],
    ['en', '#schemeEn'],
    ['num', '#schemeNum'],
  ]) {
    const select = $(selectId);
    if (select) select.value = draft.fontScheme?.[key] || '';
  }
  $('#demoChip').hidden = draft.source !== 'demo';
  $('#tripLabel').textContent = `行程 ${state.index + 1} / ${state.trips.length}`;
  $('#prevTrip').disabled = state.index <= 0;
  $('#nextTrip').disabled = state.index >= state.trips.length - 1;
  syncTypeStrip();
}

function readFormIntoDraft() {
  const draft = current();
  if (!draft) return;
  for (const element of $$('[data-field]')) {
    draft[element.dataset.field] = element.value;
  }
  for (const element of $$('[data-flag]')) {
    draft.flags[element.dataset.flag] = element.checked;
  }
  const qrEnabled = $('#qrEnabled');
  if (qrEnabled) draft.qrEnabled = qrEnabled.checked;
  draft.fontScale = Number($('#fontScale').value) / 100;
  draft.fontWeight = Number($('#fontWeight').value);
  draft.fontScheme = {
    zh: $('#schemeZh').value,
    en: $('#schemeEn').value,
    num: $('#schemeNum').value,
  };
}

function markInvalid(errors) {
  $$('.is-invalid').forEach((node) => node.classList.remove('is-invalid'));
  const entries = Object.entries(errors || {});
  if (!entries.length) return;
  for (const [field] of entries) {
    const element = document.getElementById(field);
    if (element) element.classList.add('is-invalid');
  }
  const first = document.getElementById(entries[0][0]);
  if (first) {
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => first.focus({ preventScroll: true }), 200);
  }
  toast(entries[0][1], 'error');
}

/* ---------------------------------------------------------------- 渲染 */

function previewScale() {
  if (window.matchMedia('(max-width: 767px)').matches) return 1;
  return window.devicePixelRatio > 1.5 ? 2 : 1;
}

async function requestRender() {
  const draft = current();
  const template = currentTemplate();
  if (!draft || !template) return;
  const seq = ++state.renderSeq;
  state.renderAbort?.abort();
  const controller = new AbortController();
  state.renderAbort = controller;
  const { value } = normalizeTicket(draft);
  setStatus('渲染中…', 0);
  try {
    await renderFront($('#ticketCanvas'), value, template, {
      scale: previewScale(),
      signal: controller.signal,
    });
    if (seq === state.renderSeq) setStatus('实时渲染');
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) return;
    console.error(error);
    setStatus('渲染失败');
    toast(error.message || '票面渲染失败', 'error');
  }
}

async function renderBackPreview() {
  const draft = current();
  const template = currentTemplate();
  if (!draft || !template || !state.backStyle) return;
  const seq = ++state.backRenderSeq;
  try {
    await renderBack($('#backCanvas'), draft, template, state.backStyle, {
      scale: previewScale(),
      templateFor,
    });
    if (seq !== state.backRenderSeq) return;
  } catch (error) {
    console.error(error);
    toast(error.message || '背面预览失败', 'error');
  }
}

const debouncedBackPreview = debounce(renderBackPreview, 80);

/* ---------------------------------------------------------------- 乘客 */

function renderPassengerList() {
  const select = $('#passengerList');
  if (!select) return;
  const list = store.loadPassengers();
  select.innerHTML = '';
  if (!list.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '暂无常用乘客';
    select.appendChild(option);
    select.disabled = true;
    $('#passengerFill').disabled = true;
    $('#passengerDel').disabled = true;
    return;
  }
  select.disabled = false;
  $('#passengerFill').disabled = false;
  $('#passengerDel').disabled = false;
  list.forEach((passenger, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${passenger.name || '（未命名）'}${passenger.identity ? ` · ${passenger.identity}` : ''}`;
    select.appendChild(option);
  });
}

function setFieldValue(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ---------------------------------------------------------------- 导出 */

function showProgress(title, text, percent = 0) {
  $('#progressTitle').textContent = title;
  $('#progressText').textContent = text;
  $('#progressBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('#progressModal').hidden = false;
}

function updateProgress(percent, text) {
  $('#progressBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (text) $('#progressText').textContent = text;
}

function hideProgress() {
  $('#progressModal').hidden = true;
}

async function doExport(mode = 'none') {
  if (state.exporting) return;
  const draft = current();
  const template = currentTemplate();
  if (!draft || !template) return;
  if (mode !== 'none' && !draft.back) {
    toast('请先制作背面', 'error');
    return;
  }
  const { value, errors } = normalizeTicket(draft);
  if (hasErrors(errors)) {
    markInvalid(errors);
    return;
  }
  state.exporting = true;
  state.progressCancel = null;
  showProgress('正在导出', '准备画布…', 8);
  try {
    updateProgress(28, '绘制票面…');
    await exportSingle(value, template, { scale: 2, mode, templateFor });
    updateProgress(100, '导出完成');
    toast('已导出图片', 'success');
    setTimeout(hideProgress, 450);
    store.pushHistory(value.trainNo);
  } catch (error) {
    console.error(error);
    hideProgress();
    toast(error.message || '导出失败', 'error');
  } finally {
    state.exporting = false;
  }
}

function confirmAction({ title = '确认', text = '', okText = '确定' } = {}) {
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmYes').textContent = okText;
    $('#confirmModal').hidden = false;
  });
}

function closeConfirm(result) {
  $('#confirmModal').hidden = true;
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  resolve?.(result);
}

async function doBatchExport() {
  if (state.exporting) return;
  if (!state.trips.length) return;
  const prepared = [];
  for (let index = 0; index < state.trips.length; index += 1) {
    const { value, errors } = normalizeTicket(state.trips[index]);
    if (hasErrors(errors)) {
      state.index = index;
      syncFormFromDraft();
      requestRender();
      toast(`第 ${index + 1} 个行程缺少必填项，已切换过去`, 'error');
      markInvalid(errors);
      return;
    }
    prepared.push(value);
  }
  const mode = prepared.some((draft) => draft.back) ? 'merge' : 'none';
  const controller = new AbortController();
  state.exporting = true;
  state.progressCancel = () => controller.abort();
  showProgress('批量导出', `准备导出 ${prepared.length} 个行程…`, 2);
  try {
    const count = await exportBatch(prepared, templateFor, {
      scale: 2,
      mode,
      signal: controller.signal,
      onProgress: (done, total, label) => {
        updateProgress(Math.round((done / Math.max(1, total)) * 100), `已完成 ${done}/${total} · ${label}`);
      },
    });
    updateProgress(100, `已打包 ${count} 张图片`);
    toast(`已导出 ${count} 张图片`, 'success');
    setTimeout(hideProgress, 700);
  } catch (error) {
    hideProgress();
    if (error?.name === 'AbortError') toast('已取消导出');
    else {
      console.error(error);
      toast(error.message || '批量导出失败', 'error');
    }
  } finally {
    state.exporting = false;
    state.progressCancel = null;
  }
}

/* ---------------------------------------------------------------- 背面编辑器 */

function defaultBackStyle(template) {
  return {
    background: template?.key || 'blue',
    solidColor: '#d9d9d9',
    customImage: '',
    customImageId: '',
    mask: { enabled: false, color: 'black', alpha: 0.5 },
    title: DEFAULT_BACK_TITLE,
    titleSize: 40,
    titleWeight: 700,
    titleColor: '#333333',
    terms: DEFAULT_BACK_TERMS,
    termsSize: 21,
    termsWeight: 500,
    termsColor: '#3c3c3c',
    splitExport: false,
    applyAll: false,
  };
}

function populateBackBg() {
  const select = $('#backBg');
  if (!select || !state.manifest) return;
  select.innerHTML = '';
  for (const template of state.manifest.templates) {
    const option = document.createElement('option');
    option.value = template.key;
    option.textContent = template.label;
    select.appendChild(option);
  }
  const solid = document.createElement('option');
  solid.value = 'solid';
  solid.textContent = '纯色';
  select.appendChild(solid);
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = '自定义图片';
  select.appendChild(custom);
}

function fillBackControls() {
  const style = state.backStyle;
  if (!style) return;
  $('#backBg').value = style.background;
  $('#backSolidColor').value = style.solidColor || '#d9d9d9';
  $('#backMaskOn').checked = Boolean(style.mask?.enabled);
  $('#backMaskColor').value = style.mask?.color || 'black';
  $('#backMaskAlpha').value = String(Math.round((style.mask?.alpha ?? 0.5) * 100));
  $('#backTitleInput').value = style.title || DEFAULT_BACK_TITLE;
  $('#backTitleSize').value = String(style.titleSize || 40);
  $('#backTitleWeight').value = String(style.titleWeight || 700);
  $('#backTitleColor').value = style.titleColor || '#333333';
  $('#backTerms').value = style.terms || DEFAULT_BACK_TERMS;
  $('#backTermsSize').value = String(style.termsSize || 21);
  $('#backTermsWeight').value = String(style.termsWeight || 500);
  $('#backTermsColor').value = style.termsColor || '#3c3c3c';
  $('#backExportMode').value = style.splitExport ? 'split' : 'merge';
  $('#backApplyAll').checked = Boolean(style.applyAll);
}

function readBackControls() {
  const style = state.backStyle || defaultBackStyle(currentTemplate());
  style.background = $('#backBg').value;
  style.solidColor = $('#backSolidColor').value;
  style.mask = {
    enabled: $('#backMaskOn').checked,
    color: $('#backMaskColor').value,
    alpha: Number($('#backMaskAlpha').value) / 100,
  };
  style.title = $('#backTitleInput').value;
  style.titleSize = Math.max(10, Math.min(80, Number($('#backTitleSize').value) || 40));
  style.titleWeight = Number($('#backTitleWeight').value) || 700;
  style.titleColor = $('#backTitleColor').value;
  style.terms = $('#backTerms').value;
  style.termsSize = Math.max(10, Math.min(60, Number($('#backTermsSize').value) || 21));
  style.termsWeight = Number($('#backTermsWeight').value) || 500;
  style.termsColor = $('#backTermsColor').value;
  style.splitExport = $('#backExportMode').value === 'split';
  style.applyAll = $('#backApplyAll').checked;
  state.backStyle = style;
  return style;
}

async function openBackEditor() {
  const draft = current();
  const template = currentTemplate();
  if (!draft || !template) return;
  state.backStyle = draft.back
    ? JSON.parse(JSON.stringify(draft.back))
    : defaultBackStyle(template);
  populateBackBg();
  fillBackControls();
  $('#backModal').hidden = false;
  await renderBackPreview();
}

function closeBackEditor() {
  $('#backModal').hidden = true;
}

/* ---------------------------------------------------------------- 免责声明 */

function initDisclaimer() {
  if (store.hasAcceptedDisclaimer(1)) {
    $('#disclaimerModal').hidden = true;
    return;
  }
  const modal = $('#disclaimerModal');
  modal.hidden = false;
  const yes = $('#disclaimerYes');
  const no = $('#disclaimerNo');
  let remaining = 3;
  const update = () => {
    const label = remaining > 0 ? `（${remaining}s 后可点击）` : '';
    yes.textContent = `是${label}`;
    no.textContent = `否${label}`;
    yes.disabled = remaining > 0;
    no.disabled = remaining > 0;
  };
  update();
  const timer = setInterval(() => {
    remaining -= 1;
    update();
    if (remaining <= 0) clearInterval(timer);
  }, 1000);
  yes.addEventListener('click', () => {
    store.acceptDisclaimer(1);
    modal.hidden = true;
  }, { once: true });
  no.addEventListener('click', () => {
    window.location.href = '/';
  }, { once: true });
}

/* ---------------------------------------------------------------- PDF */

function showPdfModal(parsed) {
  state.pendingPdf = parsed;
  const kind = parsed.kind === 'invoice' ? '铁路电子发票' : '12306 行程信息提示';
  const entries = Object.entries(parsed).filter(
    ([key, value]) =>
      !['kind', 'flags', 'infoline1', 'qrcodeContent', 'ticketNo', 'machineId'].includes(key) &&
      value !== undefined &&
      value !== null &&
      String(value).trim() !== '',
  );
  const extra = [];
  if (parsed.ticketNo) extra.push(['票号（顶部）', parsed.ticketNo]);
  if (parsed.machineId) extra.push(['取票机号（底部）', parsed.machineId]);
  if (parsed.qrcodeContent) extra.push(['二维码', parsed.qrcodeContent]);
  $('#pdfSummary').textContent = `识别为${kind}；共识别 ${entries.length + extra.length} 个字段。`;
  const box = $('#pdfFields');
  box.innerHTML = '';
  for (const [key, value] of [...entries, ...extra]) {
    const row = document.createElement('div');
    row.className = 'pdf-field';
    const label = document.createElement('span');
    label.textContent = FIELD_LABELS[key] || key;
    const content = document.createElement('b');
    content.textContent = String(value);
    row.append(label, content);
    box.appendChild(row);
  }
  $('#pdfModal').hidden = false;
}

function applyParsedToCurrent(parsed, { newTrip = false } = {}) {
  if (newTrip) {
    persist();
    const draft = defaultDraft();
    draft.style = current()?.style || 'blue';
    state.trips.push(draft);
    state.index = state.trips.length - 1;
    state.origins = createOrigins();
  }
  const draft = current();
  const result = applyParsed({
    draft,
    origins: state.origins,
    parsed,
    pinyinFor: (name) => pinyinFor(state.stations, name),
    defaultQr: DEFAULT_QR,
  });
  Object.assign(draft, result.draft);
  state.origins = result.origins;
  draft.origins = { ...state.origins };
  syncFormFromDraft();
  requestRender();
  scheduleSave();
  $('#pdfModal').hidden = true;
  state.pendingPdf = null;
  toast(result.changed.length ? `已回填 ${result.changed.length} 个字段` : '没有可回填的新字段', 'success');
}

async function handlePdfFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)));
  if (!files.length) {
    toast('请选择 PDF 文件', 'error');
    return;
  }
  const tooLarge = files.find((file) => file.size > 20 * 1024 * 1024);
  if (tooLarge) {
    toast(`${tooLarge.name} 超过 20MB，请压缩或拆分后再导入`, 'error');
    return;
  }
  showProgress('解析 PDF', `准备读取 ${files.length} 个文件…`, 0);
  state.progressCancel = hideProgress;
  try {
    const parsedList = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      updateProgress(Math.round((index / files.length) * 100), `读取 ${file.name}…`);
      const model = await extractPdf(file, (page, total) => {
        updateProgress(
          Math.round(((index + page / Math.max(1, total)) / files.length) * 100),
          `${file.name} · 第 ${page}/${total} 页`,
        );
      });
      const parsed = parsePdfText(model);
      if (!parsed.trainNo && !parsed.startStation && !parsed.date) {
        throw new Error(`${file.name} 未识别到车票字段，可能是扫描件或版面不受支持`);
      }
      parsedList.push(parsed);
    }
    hideProgress();
    if (parsedList.length === 1) {
      showPdfModal(parsedList[0]);
      return;
    }
    persist();
    parsedList.forEach((parsed) => {
      const draft = defaultDraft();
      draft.style = current()?.style || 'blue';
      const origins = createOrigins();
      const result = applyParsed({
        draft,
        origins,
        parsed,
        pinyinFor: (name) => pinyinFor(state.stations, name),
        defaultQr: DEFAULT_QR,
      });
      Object.assign(draft, result.draft, { origins: { ...result.origins } });
      state.trips.push(draft);
    });
    state.index = state.trips.length - parsedList.length;
    state.origins = { ...(current().origins || {}) };
    syncFormFromDraft();
    requestRender();
    scheduleSave();
    toast(`已导入 ${parsedList.length} 个行程`, 'success');
  } catch (error) {
    hideProgress();
    console.error(error);
    toast(error.message || 'PDF 解析失败', 'error');
  } finally {
    state.progressCancel = null;
  }
}

/* ---------------------------------------------------------------- 积分 */

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function openPoints() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 365);
  if (!$('#pointsStart').value) $('#pointsStart').value = formatDateInput(start);
  if (!$('#pointsEnd').value) $('#pointsEnd').value = formatDateInput(end);
  $('#pointsModal').hidden = false;
  $('#pointsList').innerHTML = '';
  $('#pointsApply').disabled = true;
  $('#pointsStatus').textContent = '登录 12306 后读取当前区间的乘车记录；不含发车时间/座位号/票价。';
}

async function loadPointsRecords() {
  const start = $('#pointsStart').value;
  const end = $('#pointsEnd').value;
  if (!start || !end) {
    toast('请选择开始和结束日期', 'error');
    return;
  }
  $('#pointsStatus').textContent = '正在读取积分记录，区间较大时需要一点时间…';
  $('#pointsApply').disabled = true;
  $('#pointsList').innerHTML = '';
  try {
    const response = await fetch(
      `/api/ticket/records?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=60`,
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) throw new Error('登录已失效，请先到积分查询页扫码登录');
      throw new Error(payload?.error?.message || '读取积分记录失败');
    }
    state.pointsRecords = Array.isArray(payload.records) ? payload.records : [];
    if (!state.pointsRecords.length) {
      $('#pointsStatus').textContent = payload.warnings?.[0] || '当前区间没有可生成车票的乘车记录。';
      return;
    }
    $('#pointsStatus').textContent = `找到 ${state.pointsRecords.length} 条乘车记录，勾选后导入。`;
    const list = $('#pointsList');
    state.pointsRecords.forEach((record, index) => {
      const label = document.createElement('label');
      label.className = 'point-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.index = String(index);
      const main = document.createElement('span');
      main.className = 'point-main';
      const title = document.createElement('strong');
      title.textContent = `${record.date || '日期未知'} ${record.trainNo || ''} ${record.startStation || '?'} → ${record.endStation || '?'}`;
      const detail = document.createElement('small');
      detail.textContent = [record.passengerName, record.seatClass, record.carriageNo ? `${record.carriageNo}车` : ''].filter(Boolean).join(' · ');
      main.append(title, detail);
      label.append(checkbox, main);
      list.appendChild(label);
    });
    $('#pointsApply').disabled = false;
  } catch (error) {
    console.error(error);
    $('#pointsStatus').textContent = error.message;
    toast(error.message, 'error');
  }
}

function applyPointsRecords() {
  const selected = [...$('#pointsList').querySelectorAll('input[type="checkbox"]:checked')]
    .map((checkbox) => state.pointsRecords[Number(checkbox.dataset.index)])
    .filter(Boolean);
  if (!selected.length) {
    toast('请至少勾选一条记录', 'error');
    return;
  }
  persist();
  const drafts = selected.map((record) => {
    const draft = defaultDraft();
    draft.style = record.style || 'blue';
    const origins = createOrigins();
    const parsed = {
      startStation: record.startStation,
      startStationPY: record.startStationPY,
      endStation: record.endStation,
      endStationPY: record.endStationPY,
      trainNo: record.trainNo,
      seatClass: record.seatClass,
      date: record.date,
      time: record.time,
      carriageNo: record.carriageNo,
      seatNo: record.seatNo,
      seatPosition: record.seatPosition,
      price: record.price,
      identity: record.identity,
      name: record.passengerName || record.name,
      machineId: record.machineId,
      ticketNo: record.ticketNo,
      infoline1: Number(record.info1) || 0,
    };
    const result = applyParsed({
      draft,
      origins,
      parsed,
      pinyinFor: (name) => pinyinFor(state.stations, name),
      defaultQr: DEFAULT_QR,
    });
    Object.assign(draft, result.draft, { origins: { ...result.origins }, source: 'points' });
    return draft;
  });
  state.trips.push(...drafts);
  state.index = state.trips.length - drafts.length;
  state.origins = { ...(current().origins || {}) };
  syncFormFromDraft();
  requestRender();
  scheduleSave();
  $('#pointsModal').hidden = true;
  toast(`已导入 ${drafts.length} 个行程`, 'success');
}

/* ---------------------------------------------------------------- 事件绑定 */

function bindFieldEvents() {
  for (const element of $$('[data-field]')) {
    const field = element.dataset.field;
    const handler = () => {
      const draft = current();
      if (!draft) return;
      draft[field] = element.value;
      draft.source = 'manual';
      markManual(state.origins, field);
      element.classList.remove('is-invalid');
      $('#demoChip').hidden = true;
      requestRender();
      scheduleSave();
    };
    element.addEventListener('input', handler);
    element.addEventListener('change', handler);
  }
  for (const element of $$('[data-flag]')) {
    element.addEventListener('change', () => {
      const draft = current();
      const key = element.dataset.flag;
      draft.flags[key] = element.checked;
      draft.source = 'manual';
      markManual(state.origins, key);
      $('#demoChip').hidden = true;
      requestRender();
      scheduleSave();
    });
  }
  $('#qrEnabled').addEventListener('change', () => {
    current().qrEnabled = $('#qrEnabled').checked;
    current().source = 'manual';
    requestRender();
    scheduleSave();
  });
  $('#fontScale').addEventListener('input', () => {
    current().fontScale = Number($('#fontScale').value) / 100;
    $('#fontScaleVal').textContent = `${$('#fontScale').value}%`;
    requestRender();
    scheduleSave();
  });
  $('#fontWeight').addEventListener('input', () => {
    current().fontWeight = Number($('#fontWeight').value);
    $('#fontWeightVal').textContent = $('#fontWeight').value;
    requestRender();
    scheduleSave();
  });
  for (const select of $$('#schemeZh, #schemeEn, #schemeNum')) {
    select.addEventListener('change', () => {
      current().fontScheme = {
        zh: $('#schemeZh').value,
        en: $('#schemeEn').value,
        num: $('#schemeNum').value,
      };
      current().source = 'manual';
      requestRender();
      scheduleSave();
    });
  }
}

function bindTripEvents() {
  $('#prevTrip').addEventListener('click', () => switchTrip(state.index - 1));
  $('#nextTrip').addEventListener('click', () => switchTrip(state.index + 1));
  $('#addTrip').addEventListener('click', () => {
    persist();
    const draft = defaultDraft();
    draft.style = current()?.style || 'blue';
    state.trips.push(draft);
    state.index = state.trips.length - 1;
    state.origins = createOrigins();
    syncFormFromDraft();
    requestRender();
    scheduleSave();
    toast('已新建一个行程', 'success');
  });
  $('#resetBtn').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: '清空当前行程',
      text: '清空后当前行程的字段会恢复为空，已保存的常用乘客不受影响。',
      okText: '清空',
    });
    if (!ok) return;
    const style = current()?.style || 'blue';
    state.trips[state.index] = { ...defaultDraft(), style };
    state.origins = createOrigins();
    syncFormFromDraft();
    requestRender();
    scheduleSave();
    toast('已清空当前行程');
  });
}

function switchTrip(index) {
  if (index < 0 || index >= state.trips.length || index === state.index) return;
  persist();
  state.index = index;
  state.origins = { ...(state.trips[index].origins || {}) };
  syncFormFromDraft();
  requestRender();
}

function bindExportEvents() {
  $('#exportBtn').addEventListener('click', () => {
    $('#exportAskModal').hidden = false;
  });
  $('#askNo').addEventListener('click', () => {
    $('#exportAskModal').hidden = true;
    doExport('none');
  });
  $('#askBack').addEventListener('click', () => {
    $('#exportAskModal').hidden = true;
    openBackEditor();
  });
  $('#batchBtn').addEventListener('click', doBatchExport);
  $('#backBtn').addEventListener('click', openBackEditor);
  $('#backClose').addEventListener('click', closeBackEditor);
  $('#backCancel').addEventListener('click', closeBackEditor);
  $('#backModal').addEventListener('click', (event) => {
    if (event.target === $('#backModal')) closeBackEditor();
  });
  for (const selector of [
    '#backBg',
    '#backSolidColor',
    '#backMaskOn',
    '#backMaskColor',
    '#backMaskAlpha',
    '#backTitleInput',
    '#backTitleSize',
    '#backTitleWeight',
    '#backTitleColor',
    '#backTerms',
    '#backTermsSize',
    '#backTermsWeight',
    '#backTermsColor',
  ]) {
    $(selector).addEventListener('input', () => {
      readBackControls();
      debouncedBackPreview();
    });
    $(selector).addEventListener('change', () => {
      readBackControls();
      renderBackPreview();
    });
  }
  $('#backImageFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      toast('图片不要超过 6MB', 'error');
      event.target.value = '';
      return;
    }
    try {
      const id = `back-${Date.now().toString(36)}`;
      await store.putImage(id, file);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
        reader.readAsDataURL(file);
      });
      state.backStyle.background = 'custom';
      state.backStyle.customImageId = id;
      state.backStyle.customImage = dataUrl;
      $('#backBg').value = 'custom';
      readBackControls();
      renderBackPreview();
      toast('已添加自定义背面图', 'success');
    } catch (error) {
      console.error(error);
      toast(error.message || '图片处理失败', 'error');
    } finally {
      event.target.value = '';
    }
  });
  $('#backExport').addEventListener('click', async () => {
    const style = readBackControls();
    current().back = JSON.parse(JSON.stringify(style));
    if (style.applyAll) {
      state.trips.forEach((trip) => {
        trip.back = JSON.parse(JSON.stringify(style));
      });
    }
    persist();
    closeBackEditor();
    await doExport(style.splitExport ? 'split' : 'merge');
  });
}

function bindPassengerEvents() {
  $('#passengerSave').addEventListener('click', () => {
    const name = $('#name').value.trim();
    const identity = $('#identity').value.trim();
    if (!name && !identity) {
      toast('请先填写姓名或证件号', 'error');
      return;
    }
    const list = store.loadPassengers();
    list.push({ name, identity, updatedAt: new Date().toISOString() });
    store.savePassengers(list);
    renderPassengerList();
    toast('已保存为常用乘客', 'success');
  });
  $('#passengerFill').addEventListener('click', () => {
    const list = store.loadPassengers();
    const index = Number($('#passengerList').value);
    const passenger = list[index];
    if (!passenger) return;
    if (passenger.name) setFieldValue('name', passenger.name);
    if (passenger.identity) setFieldValue('identity', passenger.identity);
    toast('已填入乘客信息');
  });
  $('#passengerDel').addEventListener('click', () => {
    const list = store.loadPassengers();
    const index = Number($('#passengerList').value);
    if (!Number.isInteger(index) || !list[index]) return;
    list.splice(index, 1);
    store.savePassengers(list);
    renderPassengerList();
    toast('已删除');
  });
}

function bindPdfEvents() {
  const input = $('#pdfFile');
  const openPicker = () => input.click();
  $('#pdfPick').addEventListener('click', openPicker);
  $('#pdfDrop').addEventListener('click', openPicker);
  input.addEventListener('change', () => {
    handlePdfFiles(input.files);
    input.value = '';
  });
  const drop = $('#pdfDrop');
  for (const eventName of ['dragenter', 'dragover']) {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.add('is-drag');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.remove('is-drag');
    });
  }
  drop.addEventListener('drop', (event) => {
    handlePdfFiles(event.dataTransfer?.files);
  });
  $('#pdfDemo').addEventListener('click', () => {
    const draft = current();
    if (!draft) return;
    const demo = demoDraft();
    Object.assign(draft, { ...demo, id: draft.id, origins: undefined, source: 'demo' });
    state.origins = createOrigins();
    syncFormFromDraft();
    requestRender();
    scheduleSave();
    toast('已填入示例数据');
  });
  $('#pdfClose').addEventListener('click', () => {
    $('#pdfModal').hidden = true;
    state.pendingPdf = null;
  });
  $('#pdfCancel').addEventListener('click', () => {
    $('#pdfModal').hidden = true;
    state.pendingPdf = null;
  });
  $('#pdfApply').addEventListener('click', () => {
    if (state.pendingPdf) applyParsedToCurrent(state.pendingPdf);
  });
  $('#pdfNewTrip').addEventListener('click', () => {
    if (state.pendingPdf) applyParsedToCurrent(state.pendingPdf, { newTrip: true });
  });
}

function bindPointsEvents() {
  $('#pointsBtn').addEventListener('click', openPoints);
  $('#pointsImport').addEventListener('click', openPoints);
  $('#pointsClose').addEventListener('click', () => {
    $('#pointsModal').hidden = true;
  });
  $('#pointsCancel').addEventListener('click', () => {
    $('#pointsModal').hidden = true;
  });
  $('#pointsLoad').addEventListener('click', loadPointsRecords);
  $('#pointsApply').addEventListener('click', applyPointsRecords);
}

function bindConfirm() {
  $('#confirmNo').addEventListener('click', () => closeConfirm(false));
  $('#confirmYes').addEventListener('click', () => closeConfirm(true));
  $('#confirmModal').addEventListener('click', (event) => {
    if (event.target === $('#confirmModal')) closeConfirm(false);
  });
}

function bindMobileNav() {
  $$('.mobile-nav button').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.action === 'export') {
        $('#exportAskModal').hidden = false;
        return;
      }
      const target = document.getElementById(button.dataset.target);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

async function bindStationAutocomplete() {
  try {
    state.stations = await loadStations();
    attachStationAutocomplete({
      input: $('#startStation'),
      pinyinInput: $('#startStationPY'),
      getList: () => state.stations,
    });
    attachStationAutocomplete({
      input: $('#endStation'),
      pinyinInput: $('#endStationPY'),
      getList: () => state.stations,
    });
  } catch (error) {
    console.warn(error);
    toast('车站库加载失败，仍可手动输入站名', 'error');
  }
}

function bindProgress() {
  $('#progressCancel').addEventListener('click', () => {
    if (state.progressCancel) state.progressCancel();
    else hideProgress();
  });
}

function bindHistory() {
  const list = $('#trainHistory');
  const history = store.loadHistory();
  list.innerHTML = '';
  history.forEach((trainNo) => {
    const option = document.createElement('option');
    option.value = trainNo;
    list.appendChild(option);
  });
}

function bindPagePersistence() {
  window.addEventListener('beforeunload', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });
}

/* ---------------------------------------------------------------- 启动 */

async function init() {
  await loadIconSprite();
  populateFontSelects();
  initTrips();
  initDisclaimer();
  bindFieldEvents();
  bindTripEvents();
  bindExportEvents();
  bindPassengerEvents();
  bindPdfEvents();
  bindPointsEvents();
  bindConfirm();
  bindMobileNav();
  bindProgress();
  bindPagePersistence();
  renderPassengerList();
  bindHistory();
  syncFormFromDraft();

  try {
    state.manifest = await loadTemplates();
    renderTypeStrip();
    populateBackBg();
    await resolveStoredBackImages();
    await requestRender();
  } catch (error) {
    console.error(error);
    setStatus('模板加载失败', 0);
    toast(error.message || '模板加载失败', 'error');
  }

  bindStationAutocomplete();
}

init().catch((error) => {
  console.error(error);
  toast(error.message || '页面初始化失败', 'error');
});
