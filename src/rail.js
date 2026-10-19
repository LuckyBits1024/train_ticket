/**
 * 12306 常旅客积分接口客户端。
 *
 * 接口来自 cx.12306.cn/tlcx 自身的前端 bundle（merged/jfinformation_js_v20011.js）：
 *   POST login/checkLogin                  检查登录态
 *   POST login/loginOut                    退出登录
 *   POST memberInfo/memberPointQuery       积分概览
 *   POST memberInfo/pointSimpleQuery       积分明细列表（分页）
 *   POST memberInfo/PointDetailQuery       单条流水的乘车明细
 * 扫码登录走 kyfw.12306.cn/passport 的 create-qr64 / checkqr / auth/uamtk，
 * 再用 cx.12306.cn/tlcx/uamauthclient 换取积分站点的会话。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError } from './http.js';

const PAGE_URL = 'https://cx.12306.cn/tlcx/jfinformation.html';
const CX = 'https://cx.12306.cn/tlcx/';
const KYFW = 'https://kyfw.12306.cn';
const PASSPORT = `${KYFW}/passport/`;
const KYFW_REFERER = `${KYFW}/otn/leftTicket/init`;

const dataDir = path.resolve(import.meta.dirname, 'data');
const STATIONS = JSON.parse(readFileSync(path.join(dataDir, 'stations.json'), 'utf8'));
const SEATS = JSON.parse(readFileSync(path.join(dataDir, 'seats.json'), 'utf8'));

const LEVEL_THRESHOLD = { 3: 50000, 4: 150000, 5: 250000 };

function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function qrImageDataUrl(base64) {
  const mime = base64.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${base64}`;
}

export function stationName(telecode) {
  if (!telecode) return '';
  return STATIONS[telecode] || telecode;
}

export function seatName(code) {
  if (!code) return '';
  return SEATS[code] || code;
}

/** 把 20260225 / 2026-02-25 统一成 2026-02-25 */
export function formatCompactDate(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return text;
}

export function formatChineseTicket(trainDate, trainCode) {
  const date = formatCompactDate(trainDate);
  if (!date || !trainCode) return '';
  const [, month, day] = date.split('-');
  return `车票：${Number(month)}月${Number(day)}日 ${trainCode}次车`;
}

function toApiDate(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replaceAll('-', '');
  throw new ApiError('日期格式应为 YYYY-MM-DD', { code: 'BAD_DATE' });
}

function isNoLogin(payload) {
  return Boolean(payload && (payload.noLogin === 'Y' || payload.code === 'NO_LOGIN'));
}

function apiMessage(payload, fallback) {
  return payload?.errorMsg || payload?.result_message || payload?.message || fallback;
}

export class RailClient {
  constructor({ http, store, logger = console }) {
    this.http = http;
    this.store = store;
    this.logger = logger;
    this.user = store.user || null;
    this.warmed = false;
  }

  get jar() {
    return this.store.jar;
  }

  /** 建立两个域上的匿名会话（JSESSIONID / route / BIGip…） */
  async warmup({ force = false } = {}) {
    if (this.warmed && !force) return;
    await this.http.get(KYFW_REFERER, {
      headers: { referer: 'https://www.12306.cn/index/' },
    });
    const { json } = await this.http.postJson(`${CX}login/checkLogin`, {}, this.#cxOptions());
    this.warmed = true;
    if (json?.data?.flag == 1) {
      this.user = this.#userFromLogin(json.data);
    }
  }

  #cxOptions(extra = {}) {
    return {
      headers: {
        referer: PAGE_URL,
        origin: 'https://cx.12306.cn',
        ...extra.headers,
      },
      ...extra,
    };
  }

  #userFromLogin(data) {
    return {
      name: data.name || '',
      mobile: data.mobile || '',
      memberLevel: data.member_level === '*' ? 2 : num(data.member_level) || null,
      memberStatus: data.member_status ?? null,
      userStatus: data.user_status ?? null,
      sex: data.sex || '',
    };
  }

  /** 生成扫码登录二维码 */
  async createQrCode() {
    await this.warmup();
    const { json } = await this.http.postJson(
      `${PASSPORT}web/create-qr64`,
      { appid: 'otn' },
      {
        headers: {
          referer: PAGE_URL,
          origin: 'https://cx.12306.cn',
        },
      },
    );
    if (!json || String(json.result_code) !== '0' || !json.image) {
      throw new ApiError(apiMessage(json, '二维码生成失败，请稍后重试'), {
        code: 'QR_CREATE_FAILED',
        payload: json,
      });
    }
    return {
      uuid: json.uuid,
      image: qrImageDataUrl(json.image),
    };
  }

  /** 轮询扫码状态：0 未扫 / 1 已扫待确认 / 2 已确认 / 3 已过期 */
  async checkQrCode(uuid) {
    const { json } = await this.http.postJson(
      `${PASSPORT}web/checkqr`,
      {
        appid: 'otn',
        uuid,
        RAIL_DEVICEID: this.jar.get('RAIL_DEVICEID', KYFW_REFERER) || '',
        RAIL_EXPIRATION: this.jar.get('RAIL_EXPIRATION', KYFW_REFERER) || '',
      },
      {
        headers: {
          referer: PAGE_URL,
          origin: 'https://cx.12306.cn',
        },
      },
    );
    if (!json) throw new ApiError('扫码状态查询失败', { code: 'QR_CHECK_FAILED' });
    return json;
  }

  /**
   * 扫码确认后换取积分站点登录态。
   * uamtk -> auth/uamtk(newapptk) -> cx/tlcx/uamauthclient(tk) -> checkLogin
   */
  async completeQrLogin({ uamtk }) {
    let token = null;
    let lastError = null;

    for (const appid of ['member', 'otn']) {
      try {
        const { json } = await this.http.postJson(
          `${PASSPORT}web/auth/uamtk`,
          { uamtk, appid },
          {
            headers: {
              referer: PAGE_URL,
              origin: 'https://cx.12306.cn',
            },
          },
        );
        if (json && String(json.result_code) === '0') {
          token = json.newapptk || json.apptk || null;
          if (token) break;
        }
        lastError = new ApiError(apiMessage(json, '换取登录令牌失败'), {
          code: 'UAMTK_FAILED',
          payload: json,
        });
      } catch (error) {
        lastError = error;
      }
    }

    if (!token) {
      throw new ApiError(lastError?.message || '换取登录令牌失败', { code: 'UAMTK_FAILED' });
    }
    this.logger.log?.('[login] 已获取登录令牌 apptk');

    let authError = null;
    try {
      const { json } = await this.http.postJson(
        `${CX}uamauthclient`,
        { tk: token },
        this.#cxOptions(),
      );
      if (json && json.result_code !== undefined && String(json.result_code) !== '0') {
        authError = new ApiError(apiMessage(json, '积分站点登录失败'), {
          code: 'UAMAUTH_FAILED',
          payload: json,
        });
      } else {
        this.logger.log?.('[login] 积分站点会话绑定成功');
      }
    } catch (error) {
      // uamauthclient 有时会 302 到 HTML 页面，但 Cookie 已经写下来了；
      // 这里不直接判失败，先看 checkLogin 的结果，避免误报。
      authError = error;
      this.logger.warn?.('[login] cx uamauthclient 异常，尝试 otn 入口:', error.message);
      try {
        await this.http.postJson(
          `${KYFW}/otn/uamauthclient`,
          { tk: token },
          { headers: { referer: KYFW_REFERER, origin: KYFW } },
        );
      } catch (fallbackError) {
        this.logger.warn?.('[login] otn uamauthclient 也失败（继续检查登录态）:', fallbackError.message);
      }
    }

    const user = await this.checkLogin({ force: true });
    if (user) return user;

    throw new ApiError(
      authError
        ? `积分站点登录失败：${authError.message}`
        : '扫码已确认，但积分站点仍未建立登录态，请刷新二维码重试',
      { code: 'LOGIN_NOT_READY' },
    );
  }

  async checkLogin({ force = false } = {}) {
    if (!force && this.user && this.lastCheckAt && Date.now() - this.lastCheckAt < 15000) {
      return this.user;
    }
    const { json } = await this.http.postJson(`${CX}login/checkLogin`, {}, this.#cxOptions());
    this.lastCheckAt = Date.now();
    const flag = json?.data?.flag;
    if (json?.data && (flag === true || String(flag) === '1')) {
      this.user = this.#userFromLogin(json.data);
      this.store.user = this.user;
      return this.user;
    }
    this.user = null;
    this.store.user = null;
    return null;
  }

  async #requireLogin() {
    const user = await this.checkLogin();
    if (!user) {
      throw new ApiError('登录已失效，请重新扫码登录', { code: 'NO_LOGIN' });
    }
    return user;
  }

  /** 积分概览 */
  async getSummary() {
    await this.#requireLogin();
    const { json } = await this.http.postJson(
      `${CX}memberInfo/memberPointQuery`,
      { queryType: '0' },
      this.#cxOptions(),
    );
    if (!json || json.status != 1) {
      if (isNoLogin(json)) throw new ApiError('登录已失效，请重新扫码登录', { code: 'NO_LOGIN' });
      throw new ApiError(apiMessage(json, '积分概览获取失败'), {
        code: 'SUMMARY_FAILED',
        payload: json,
      });
    }
    const d = json.data || {};
    const level = d.member_level === '*' ? 2 : num(d.member_level) || null;
    const nextLevel = level ? Math.min(level + 1, 5) : null;
    return {
      availablePoints: num(d.point_use_total),
      expiringPoints: num(d.month_cancel_point),
      expiringDate: formatCompactDate(d.flag1),
      expiringSoonPoints: num(d.flag4),
      memberLevel: level,
      memberLevelDiff: num(d.member_level_diff),
      nextLevel,
      nextLevelThreshold: nextLevel ? LEVEL_THRESHOLD[nextLevel] || null : null,
      mobile: d.mobile_no || '',
      mobileCode: d.mobile_code || '',
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * 积分明细列表
   * @param {'0'|'1'|'2'} type 0=全部 1=收入 2=支出
   */
  async queryPoints({ type = '0', start, end, page = 1, pageSize = 10 }) {
    await this.#requireLogin();
    const { json } = await this.http.postJson(
      `${CX}memberInfo/pointSimpleQuery`,
      {
        queryType: String(type),
        queryStartDate: toApiDate(start),
        queryEndDate: toApiDate(end),
        pageIndex: Math.max(1, Number(page) || 1),
        pageSize: Math.min(50, Math.max(1, Number(pageSize) || 10)),
      },
      this.#cxOptions(),
    );

    if (!json || json.status != 1) {
      if (isNoLogin(json)) throw new ApiError('登录已失效，请重新扫码登录', { code: 'NO_LOGIN' });
      throw new ApiError(apiMessage(json, '积分明细查询失败'), {
        code: 'POINTS_FAILED',
        payload: json,
      });
    }

    const rawRows = Array.isArray(json.data) ? json.data : [];
    const rows = rawRows.map((row) => this.normalizeTrade(row));
    const total = num(rawRows[0]?.record_sum) || rows.length;
    return { rows, rawRows, total };
  }

  /** 单条流水的乘车明细（对应页面里点击展开的行） */
  async getDetail(type, tradeId) {
    await this.#requireLogin();
    const { json } = await this.http.postJson(
      `${CX}memberInfo/PointDetailQuery`,
      { queryType: String(type ?? ''), trade_id: String(tradeId ?? '') },
      this.#cxOptions(),
    );
    if (!json || json.status != 1) {
      if (isNoLogin(json)) throw new ApiError('登录已失效，请重新扫码登录', { code: 'NO_LOGIN' });
      const message = apiMessage(json, '积分明细详情获取失败');
      if (message.includes('无积分详情')) return { details: [], rawRows: [] };
      throw new ApiError(message, { code: 'DETAIL_FAILED', payload: json });
    }
    const rawRows = Array.isArray(json.data) ? json.data : [];
    return { details: rawRows.map((row) => this.normalizeDetail(row)), rawRows };
  }

  /** 拉取某个日期区间内的全部流水（自动翻页） */
  async queryAllPoints({ start, end, type = '0', pageSize = 10, maxPages = 300, onPage } = {}) {
    const first = await this.queryPoints({ type, start, end, page: 1, pageSize });
    const rows = [...first.rows];
    const total = first.total;
    const pages = Math.min(maxPages, Math.ceil(total / pageSize) || 1);
    onPage?.({ page: 1, pages, fetched: rows.length, total });
    for (let page = 2; page <= pages; page += 1) {
      if (rows.length >= total) break;
      const next = await this.queryPoints({ type, start, end, page, pageSize });
      if (!next.rows.length) break;
      rows.push(...next.rows);
      onPage?.({ page, pages, fetched: rows.length, total });
    }
    return { rows, total };
  }

  async logout() {
    try {
      await this.http.postJson(`${CX}login/loginOut`, {}, this.#cxOptions());
    } catch (error) {
      this.logger.warn?.('[logout] 服务端退出失败（忽略）:', error.message);
    }
    this.jar.clearDomain('cx.12306.cn');
    this.jar.clearDomain('kyfw.12306.cn');
    this.jar.clearDomain('login.12306.cn');
    this.user = null;
    this.store.user = null;
    this.lastCheckAt = 0;
  }

  normalizeTrade(row = {}) {
    const direction = String(row.trade_flag) === '2' ? 'expense' : 'income';
    const points = direction === 'expense' ? num(row.consume_point) : num(row.cumulate_point);
    return {
      id: String(row.trade_id ?? ''),
      type: String(row.trade_type ?? ''),
      time: String(row.trade_time ?? '').slice(0, 19),
      direction,
      points,
      project: row.trade_name || '',
      expiry: formatCompactDate(row.stop_date),
      trainDate: formatCompactDate(row.train_date),
      trainCode: row.train_code || '',
      remark: formatChineseTicket(row.train_date, row.train_code) || row.remark || '',
      recordSum: num(row.record_sum),
    };
  }

  normalizeDetail(row = {}) {
    const queryType = String(row.query_type || '');
    const isResign = queryType === 'tg' || queryType === 'ts';
    const isMerchant = queryType === 'fc' || queryType === 'fr';

    let detail;
    if (isResign) {
      detail = {
        passenger: row.v_assignee_id_name || '',
        travelDate: formatCompactDate(row.resign_train_date),
        trainCode: row.resign_station_train_code || '',
        from: stationName(row.resign_board_station_telecode),
        to: stationName(row.resign_arrive_station_telecode),
        seat: seatName(row.resign_seat_type_code),
        coach: row.resign_coach_no || '',
        orderNo: row.sequence_no || '',
        merchant: '',
        pointDiff: row.resign_point_diff ?? '',
        pointFee: row.resign_point_fee ?? '',
      };
    } else if (isMerchant) {
      detail = {
        passenger: '',
        travelDate: formatCompactDate(row.train_date),
        trainCode: row.station_train_code || '',
        from: stationName(row.board_station_telecode),
        to: stationName(row.arrive_station_telecode),
        seat: '',
        coach: '',
        orderNo: row.sequence_no || '',
        merchant: row.flag1 || '',
        pointDiff: '',
        pointFee: '',
      };
    } else {
      detail = {
        passenger: row.v_assignee_id_name || '',
        travelDate: formatCompactDate(row.train_date),
        trainCode: row.station_train_code || '',
        from: stationName(row.board_station_telecode),
        to: stationName(row.arrive_station_telecode),
        seat: seatName(row.seat_type_code),
        coach: row.coach_no || '',
        orderNo: row.sequence_no || '',
        merchant: '',
        pointDiff: '',
        pointFee: '',
      };
    }

    detail.queryType = queryType;
    detail.kind = isResign
      ? queryType === 'tg'
        ? '改签'
        : '升席'
      : isMerchant
        ? '商户消费'
        : '乘车';
    detail.raw = row;
    return detail;
  }
}
