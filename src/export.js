/**
 * 导出：把积分流水和每条流水的乘车明细整理成 CSV / JSON。
 */
import { formatCompactDate } from './rail.js';

const CSV_COLUMNS = [
  ['日期', (r) => r.trade.time],
  ['收支', (r) => (r.trade.direction === 'expense' ? '支出' : '收入')],
  ['积分', (r) => (r.trade.direction === 'expense' ? -r.trade.points : r.trade.points)],
  ['项目', (r) => r.trade.project],
  ['积分有效期', (r) => r.trade.expiry],
  ['车票备注', (r) => r.trade.remark],
  ['乘车人', (r) => r.detail?.passenger ?? ''],
  ['乘车日期', (r) => r.detail?.travelDate ?? ''],
  ['车次', (r) => r.detail?.trainCode ?? ''],
  ['出发站', (r) => r.detail?.from ?? ''],
  ['到达站', (r) => r.detail?.to ?? ''],
  ['区间', (r) => (r.detail?.from && r.detail?.to ? `${r.detail.from} - ${r.detail.to}` : '')],
  ['席别', (r) => r.detail?.seat ?? ''],
  ['车厢号', (r) => r.detail?.coach ?? ''],
  ['订单号', (r) => r.detail?.orderNo ?? ''],
  ['明细类型', (r) => r.detail?.kind ?? ''],
  ['改签/升席积分差值', (r) => r.detail?.pointDiff ?? ''],
  ['手续费', (r) => r.detail?.pointFee ?? ''],
  ['商户名称', (r) => r.detail?.merchant ?? ''],
  ['流水类型', (r) => r.trade.type],
  ['流水ID', (r) => r.trade.id],
];

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function buildCsv(records) {
  const lines = [CSV_COLUMNS.map(([name]) => csvCell(name)).join(',')];
  for (const record of records) {
    lines.push(CSV_COLUMNS.map(([, getter]) => csvCell(getter(record))).join(','));
  }
  // BOM 让 Excel 正确识别 UTF-8
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function buildJson({ range, user, summary, records, generatedAt }) {
  const income = records
    .filter((r) => r.trade.direction === 'income')
    .reduce((sum, r) => sum + r.trade.points, 0);
  const expense = records
    .filter((r) => r.trade.direction === 'expense')
    .reduce((sum, r) => sum + r.trade.points, 0);

  return {
    app: 'train-ticket-points',
    generatedAt,
    range,
    user,
    summary,
    totals: {
      records: records.length,
      details: records.reduce((sum, r) => sum + (r.details?.length || 0), 0),
      incomePoints: income,
      expensePoints: expense,
    },
    records: records.map((r) => ({
      ...r.trade,
      details: (r.details || []).map((d) => ({ ...d })),
      detailError: r.detailError || undefined,
    })),
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 拉取区间内全部流水 + 每条流水的明细。
 * @returns {Promise<Array<{trade: object, details: object[], detailError?: string}>>}
 */
export async function collectRecords({ client, start, end, includeDetails = true, onProgress } = {}) {
  onProgress?.({ phase: 'list', done: 0, total: 0, message: '正在查询积分流水…' });
  const { rows, total } = await client.queryAllPoints({
    start,
    end,
    type: '0',
    pageSize: 10,
    onPage: ({ page, pages, fetched, total: pageTotal }) => {
      onProgress?.({
        phase: 'list',
        done: fetched,
        total: pageTotal,
        message: `正在查询积分流水（第 ${page}/${pages} 页）…`,
      });
    },
  });

  const records = rows.map((trade) => ({ trade, details: [] }));

  if (!includeDetails) {
    onProgress?.({ phase: 'done', done: records.length, total: records.length, message: '已完成' });
    return { records, total };
  }

  let finished = 0;
  await mapWithConcurrency(records, 4, async (record) => {
    try {
      const { details } = await client.getDetail(record.trade.type, record.trade.id);
      record.details = details;
    } catch (error) {
      if (error.code === 'NO_LOGIN') throw error;
      record.detailError = error.message;
    } finally {
      finished += 1;
      onProgress?.({
        phase: 'detail',
        done: finished,
        total: records.length,
        message: `正在抓取乘车明细（${finished}/${records.length}）…`,
      });
    }
  });

  onProgress?.({ phase: 'done', done: records.length, total: records.length, message: '已完成' });
  return { records, total };
}

/** 整理成「一行一条乘车明细」的扁平结构，便于 CSV */
export function flattenRecords(records) {
  const flat = [];
  for (const record of records) {
    if (!record.details?.length) {
      flat.push({ ...record, detail: null });
      continue;
    }
    for (const detail of record.details) {
      flat.push({ ...record, detail });
    }
  }
  return flat;
}

export function rangeLabel(start, end) {
  return `${formatCompactDate(start)}_${formatCompactDate(end)}`;
}
