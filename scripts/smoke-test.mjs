/**
 * 无需联网的自检：字段归一化、扫码换票流程（mock HTTP）、CSV/JSON 导出。
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RailClient,
  formatChineseTicket,
  formatCompactDate,
  seatName,
  stationName,
} from '../src/rail.js';
import { buildCsv, buildJson, collectRecords, flattenRecords } from '../src/export.js';
import { CookieJar } from '../src/cookies.js';
import { SessionStore } from '../src/store.js';

const quietLogger = { log() {}, warn() {}, error() {} };

/* ---------------- Cookie 持久化 ---------------- */

const cookie = { name: 'JSESSIONID', value: 'abc', domain: 'cx.12306.cn', path: '/tlcx', hostOnly: true };
const jarFromArray = CookieJar.fromJSON([cookie]);
assert.equal(jarFromArray.header('https://cx.12306.cn/tlcx/login/checkLogin'), 'JSESSIONID=abc');
const jarFromObject = CookieJar.fromJSON({ cookies: [cookie] });
assert.equal(jarFromObject.header('https://cx.12306.cn/tlcx/login/checkLogin'), 'JSESSIONID=abc');
assert.equal(jarFromObject.header('https://kyfw.12306.cn/otn/leftTicket/init'), '');
console.log('✓ Cookie 持久化（数组 / 对象两种格式）');

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'train-ticket-test-'));
const sessionFile = path.join(tempDir, 'session.json');
const writer = new SessionStore(sessionFile);
writer.jar = CookieJar.fromJSON([cookie]);
writer.user = { name: '测试用户', mobile: '132****0000' };
await writer.save();
const reader = await new SessionStore(sessionFile).load();
assert.equal(reader.user.name, '测试用户');
assert.equal(reader.jar.header('https://cx.12306.cn/tlcx/login/checkLogin'), 'JSESSIONID=abc');
await rm(tempDir, { recursive: true, force: true });
console.log('✓ session.json 落盘 / 重新加载');

/* ---------------- 日期 / 车站 / 席别 ---------------- */

assert.equal(formatCompactDate('20260221'), '2026-02-21');
assert.equal(formatCompactDate('2026-02-21 00:00:00'), '2026-02-21');
assert.equal(formatCompactDate(''), '');
assert.equal(formatChineseTicket('20260221', 'C1048'), '车票：2月21日 C1048次车');
assert.equal(stationName('JLL'), '吉林');
assert.equal(seatName('O'), '二等座');
console.log('✓ 日期 / 车站 / 席别映射');

/* ---------------- 流水归一化 ---------------- */

const client = new RailClient({
  http: {},
  store: { jar: { get() {}, clearDomain() {} }, user: null },
  logger: quietLogger,
});

const income = client.normalizeTrade({
  trade_id: 'T1',
  trade_type: 'tg',
  trade_time: '2026-02-25 01:22:27.123',
  trade_flag: '1',
  cumulate_point: '80',
  consume_point: '0',
  trade_name: '乘车积分',
  stop_date: '20270225',
  train_date: '20260221',
  train_code: 'C1048',
  record_sum: '96',
});
assert.equal(income.direction, 'income');
assert.equal(income.points, 80);
assert.equal(income.time, '2026-02-25 01:22:27');
assert.equal(income.expiry, '2027-02-25');
assert.equal(income.remark, '车票：2月21日 C1048次车');

const expense = client.normalizeTrade({
  trade_id: 'T2',
  trade_type: 'dh',
  trade_time: '2026-01-31 20:28:16',
  trade_flag: 2,
  consume_point: '3100',
  trade_name: '兑换车票',
  stop_date: '',
});
assert.equal(expense.direction, 'expense');
assert.equal(expense.points, 3100);
assert.equal(expense.expiry, '');

const detail = client.normalizeDetail({
  query_type: 'tg',
  v_assignee_id_name: '测试用户',
  resign_train_date: '20260221',
  resign_station_train_code: 'C1048',
  resign_board_station_telecode: 'JLL',
  resign_arrive_station_telecode: 'CCT',
  resign_seat_type_code: 'O',
  resign_coach_no: '03',
  sequence_no: 'E281080115',
  resign_point_diff: '12',
  resign_point_fee: '3',
});
assert.equal(detail.kind, '改签');
assert.equal(detail.from, '吉林');
assert.equal(detail.to, '长春');
assert.equal(detail.seat, '二等座');
assert.equal(detail.orderNo, 'E281080115');
console.log('✓ 流水 / 明细归一化');

/* ---------------- 扫码登录换票流程（mock） ---------------- */

const calls = [];
const fakeHttp = {
  async postJson(url, data = {}) {
    calls.push({ url, data });
    if (url.endsWith('/passport/web/auth/uamtk')) {
      assert.equal(data.uamtk, 'UAMTK-1');
      assert.equal(data.appid, 'member');
      return { json: { result_code: 0, newapptk: 'APP-TK-1' } };
    }
    if (url.endsWith('/tlcx/uamauthclient')) {
      assert.equal(data.tk, 'APP-TK-1');
      return { json: { result_code: 0 } };
    }
    if (url.endsWith('/tlcx/login/checkLogin')) {
      return {
        json: {
          status: true,
          data: {
            flag: '1',
            name: '测试用户',
            mobile: '132****8327',
            member_level: '3',
            member_status: 1,
            user_status: 'Y',
          },
        },
      };
    }
    throw new Error(`unexpected url: ${url}`);
  },
};

const loginClient = new RailClient({
  http: fakeHttp,
  store: { jar: { get() {}, clearDomain() {} }, user: null },
  logger: quietLogger,
});
const user = await loginClient.completeQrLogin({ uamtk: 'UAMTK-1' });
assert.equal(user.name, '测试用户');
assert.equal(user.memberLevel, 3);
assert.deepEqual(
  calls.map((call) => call.url.replace('https://', '')),
  [
    'kyfw.12306.cn/passport/web/auth/uamtk',
    'cx.12306.cn/tlcx/uamauthclient',
    'cx.12306.cn/tlcx/login/checkLogin',
  ],
);
console.log('✓ 扫码 uamtk -> uamauthclient -> checkLogin 流程');

/* ---------------- 概览 / 列表解析 ---------------- */

const summaryClient = new RailClient({
  http: {
    async postJson(url) {
      if (url.endsWith('login/checkLogin')) {
        return { json: { status: true, data: { flag: '1', name: '测试用户' } } };
      }
      if (url.endsWith('memberPointQuery')) {
        return {
          json: {
            status: 1,
            data: {
              point_use_total: '21,708',
              month_cancel_point: '758',
              flag1: '20260626',
              flag4: '0',
              member_level: '*',
              member_level_diff: '84532',
            },
          },
        };
      }
      if (url.endsWith('pointSimpleQuery')) {
        return {
          json: {
            status: 1,
            data: [
              {
                record_sum: '2',
                trade_id: 'A',
                trade_type: 'tg',
                trade_time: '2026-02-25 01:22:27',
                trade_flag: '1',
                cumulate_point: '80',
                trade_name: '乘车积分',
                stop_date: '20270225',
                train_date: '20260221',
                train_code: 'C1048',
              },
              {
                record_sum: '2',
                trade_id: 'B',
                trade_type: 'dh',
                trade_time: '2026-01-31 20:28:16',
                trade_flag: '2',
                consume_point: '3100',
                trade_name: '兑换车票',
                stop_date: '',
              },
            ],
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    },
  },
  store: { jar: { get() {}, clearDomain() {} }, user: null },
  logger: quietLogger,
});

const summary = await summaryClient.getSummary();
assert.equal(summary.availablePoints, 21708);
assert.equal(summary.expiringPoints, 758);
assert.equal(summary.expiringDate, '2026-06-26');
assert.equal(summary.memberLevel, 2); // "*" 按页面逻辑视为二星
assert.equal(summary.nextLevel, 3);
assert.equal(summary.nextLevelThreshold, 50000);

const list = await summaryClient.queryPoints({
  type: '0',
  start: '2025-10-18',
  end: '2026-10-18',
  page: 1,
  pageSize: 10,
});
assert.equal(list.total, 2);
assert.equal(list.rows[0].remark, '车票：2月21日 C1048次车');
assert.equal(list.rows[1].direction, 'expense');
console.log('✓ 概览 / 列表接口解析');

/* ---------------- 导出收集（含翻页/明细进度） ---------------- */

let lastProgress = null;
const fakeExportClient = {
  async queryAllPoints({ onPage }) {
    onPage?.({ page: 1, pages: 1, fetched: 1, total: 1 });
    return { rows: [income], total: 1 };
  },
  async getDetail() {
    return { details: [detail] };
  },
};
const collected = await collectRecords({
  client: fakeExportClient,
  start: '2025-10-18',
  end: '2026-10-18',
  includeDetails: true,
  onProgress: (progress) => {
    lastProgress = progress;
  },
});
assert.equal(collected.records.length, 1);
assert.equal(collected.records[0].details[0].orderNo, 'E281080115');
assert.equal(lastProgress.phase, 'done');
console.log('✓ 导出收集与进度回调');

/* ---------------- CSV / JSON ---------------- */

const records = [
  { trade: income, details: [detail] },
  { trade: expense, details: [] },
];
const flat = flattenRecords(records);
assert.equal(flat.length, 2);
const csv = buildCsv(flat);
assert.ok(csv.startsWith('\uFEFF日期,收支,积分'));
assert.ok(csv.includes('测试用户'));
assert.ok(csv.includes('-3100'));

const json = buildJson({
  range: { start: '2025-10-18', end: '2026-10-18' },
  user,
  summary,
  records,
  generatedAt: '2026-10-18T00:00:00.000Z',
});
assert.equal(json.totals.records, 2);
assert.equal(json.totals.details, 1);
assert.equal(json.totals.incomePoints, 80);
assert.equal(json.totals.expensePoints, 3100);
assert.equal(json.records[0].details[0].orderNo, 'E281080115');
console.log('✓ CSV / JSON 导出');

console.log('\n全部自检通过。');
