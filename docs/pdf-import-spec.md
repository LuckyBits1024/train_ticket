# 12306 PDF 导入规范

> 目标：把 12306「行程信息提示」与「电子发票（铁路电子客票）」PDF 的文本层，稳定映射为票面字段；不联网、不上传、不执行 PDF 内脚本。

## 1. 支持范围

| 类型 | 特征 | 优先级 |
| --- | --- | --- |
| 行程信息提示 | 有「温馨提示」「检票口」「电子票号」「订单号」，站名上方有“站 站”标签行 | P0 |
| 电子发票（铁路电子客票） | 有「发票号码」「开票日期」「购买方名称」「电子客票号」 | P0 |
| 扫描件/图片 PDF | 无文本层 | P2（OCR，默认不启用） |
| 加密/损坏 PDF | 需要密码/解析失败 | 明确报错，不静默 |

约束：

- 单文件 ≤20 MB；页数 ≤5；只解析文本层，不渲染页面；
- 不执行 PDF JavaScript，不请求外部资源；
- 所有解析在浏览器本地完成；文件不进入 `data/`、不上传服务端；
- 解析器必须能在 `file://` 下工作（无独立 Worker 时可回退主线程）。

## 2. 解析管线

```text
File
 → ArrayBuffer
 → pdfjsLib.getDocument({ data, cMapUrl, cMapPacked: true, isEvalSupported: false })
 → page.getTextContent()
 → items: { str, transform, width, height }
 → 按 y 聚类成行（容差 2–3px）
 → 行内按 x 排序，拼接（保留空格）
 → { text, gridLines, gridYs }
 → detectKind() → parseItinerary() / parseInvoice()
 → normalize() → 预览 → apply()
```

### 2.1 行聚类

- `y = transform[5]`；按 y 降序（PDF 坐标原点在左下）；
- 同一行容差 `max(2, fontSize*0.25)`；
- 行文本用 `str` 拼接；`hasEOL` 时断行；
- 同时保留一份“折叠文本” `text.replace(/\s+/g, " ")`，用于跨行正则。

### 2.2 类型判断

```text
if text contains "电子发票" or "发票号码" or "购买方名称" -> invoice
else if text contains "行程信息提示" or "检票口" or "电子票号" -> itinerary
else -> itinerary（走通用解析，允许部分字段为空）
```

## 3. 字段模型

```ts
interface ParsedTicket {
  kind: 'itinerary' | 'invoice';
  startStation?: string;
  endStation?: string;
  trainNo?: string;
  date?: string;          // YYYY-MM-DD
  time?: string;          // HH:mm
  carriageNo?: string;    // 2 位
  seatNo?: string;        // 11F / 无座
  seatPosition?: string;  // 上铺/中铺/下铺
  seatClass?: string;
  checkinRoom?: string;
  name?: string;
  identity?: string;
  ticketNo?: string;      // 顶部红字：订单号（短）
  machineId?: string;     // 底部黑字：电子票号（长）
  price?: string;
  qrcodeContent?: string;
  infoline1?: 0 | 1 | 2;
  flags: Partial<Record<'child' | 'student' | 'online' | 'discount', boolean>>;
}
```

> 命名容易混：`ticketNo` 是**顶部红字/订单号**，`machineId` 是**底部黑字/电子票号**。UI 标签必须写清楚，代码里不要再用 `ticketNumber` 同时指两者。

## 4. 行程单解析规则

### 4.1 车次

```regex
(^|\D)([GCDTKZ]\d{3,5})(?!\d)
```

允许 3–5 位数字；不要用后行断言（Safari 16.4 之前不支持）。

### 4.2 站名

优先级：

1. **行级识别**：找到纯“站 站”标签行，取上一行的 2–6 字中文词，按出现顺序作为始发/到达；
2. **拼音行兜底**：在“温馨提示”之前，找含 ≥2 段纯字母的行，取前两段；
3. **`X站` / `站X` 兜底**：按出现位置去重，排除“检票口/温馨提示”之后的内容；
4. 只剩一个站时，用车次位置判断它在车次前还是后。

站名处理：去掉末尾“站”；2–6 个汉字；不接受英文/数字站名（国际联运另开规则）。

### 4.3 日期

优先级：

1. `YYYY年MM月DD日`；
2. 拆分式：`YYYY年 月 日` 标签 + 数字（可能同行或下一行）；
3. `YYYY年MM月DD`（缺“日”）。

校验月 1–12、日 1–31。**绝不用“生成时间/开票日期”当乘车日期**。

### 4.4 时间

优先级：

1. “开车时间”同一行 `HH:MM`；
2. 标签下方 1–3 行；
3. 折叠文本 `开车时间...HH:MM`；
4. 全篇最后一个合法 `HH:MM`（排除带秒的生成时间）。

### 4.5 车厢/座位/铺位

```regex
(\d{1,2})\s*车\s*(\d{1,2}[A-Za-z0-9]?)          // 03车10F
(\d{1,2}[A-Za-z0-9]?)\s*号?\s*(上铺|中铺|下铺|卧)
```

### 4.6 席别

```regex
(特等座|一等座|二等座|商务座|软座|硬座|软卧|硬卧|动卧|动座|无座)
```

### 4.7 检票口

输出统一为 `<站名> <号码>检票口` 或 `检票: <值>`。覆盖：

- `呈贡昆明南站 1B检票口`（值在标签前）
- `检票口 呈贡昆明南站 1B`（值在标签后）
- `检票口 21A` / `检票口 24A25A`（新版纯数字+字母，无中文前缀）
- `二楼3检票口` / `候车室5`
- 负向：不要把 `检票口 02车…` 的车厢号当检票口。

### 4.8 姓名/证件

```regex
([\u4e00-\u9fa5]{1,6})\s*(\d{2,}\*+\d{2,}|\d{17}[\dXx])
```

姓名在证件号前；证件号保留原样（脱敏由渲染层再做一次）。

### 4.9 票号

- 电子票号：`电子票号[:：]?\s*(\d{15,25})`；兜底取全篇最长连续数字（15–25 位）；
- 订单号：`订\s*单\s*号[:：]?\s*([A-Z0-9]{4,})`；
- 映射：订单号 → `ticketNo`（顶部红字）；电子票号 → `machineId`（底部黑字）。

### 4.10 二维码

```regex
https?://e\.12306\.cn/orderId/([A-Za-z0-9]+)/?
https?://e\.12306\.cn/[A-Za-z0-9-]+
https?://([A-Za-z0-9-]+\.12306\.cn)/[A-Za-z0-9/_\-]*
```

取第一个匹配；不要取 PDF 里的 `http://ns.adobe.com/...` 命名空间。

### 4.11 票价

```regex
票价[:：]?\s*(\d+(?:\.\d+)?)\s*元
```

发票格式不带“元”：

```regex
(?:票价|退票费)[:：]?\s*[￥¥]?\s*(\d+(?:\.\d+)?)
```

### 4.12 标志

在席别后 20 字符内找“孩/学/网/惠/退/改”；`infoline1 = 2` 如果出现“限乘当日当次车”。

## 5. 电子发票解析规则

版面顺序：

1. `发票号码:… 开票日期:…`
2. `<出发站> 站 <车次> <到达站> 站`
3. 站点拼音
4. `乘车日期 HH:MM开 NN车NN号 席别`
5. `票价/退票费: ￥ 金额`
6. `证件号 姓名`
7. `电子客票号:…`
8. `购买方名称: 姓名 …`

与行程单的差异：

- 日期必须匹配 `YYYY年MM月DD日 HH:MM开`，避免抓到开票日期；
- 姓名在证件号之后，优先 `购买方名称:`；
- 票价不带“元”；
- 映射后：发票号码 → 顶部红字（`ticketNo` 字段）；电子客票号 → 底部黑字（`machineId` 字段）。
- 改签/退票/学生/儿童标志从全文关键词判断。

## 6. 填充规则（必须按状态机实现）

### 6.1 来源

```ts
type Origin = 'manual' | 'pdf';
const origin = new Map<string, Origin>();
```

- 只有**用户输入事件**才标记 `manual`；程序赋值不触发/不标记；
- “清空表单”“切换行程”“新建行程”重置 origin；
- 每个行程一份独立 origin，不共享。

### 6.2 应用顺序

```text
for each parsed field:
  if (!value) continue;                    // 规则③：PDF 空值不覆盖
  if (origin[field] === 'manual') continue; // 规则②：手动优先
  set value; origin[field] = 'pdf';         // 规则①：自动回填
```

复选框：

```text
if (origin[field] === 'manual') continue;
set checked = !!parsed.flags[field];
if (checked) origin[field] = 'pdf';
```

### 6.3 二维码兜底

```text
if (!qrInput.value && origin.qrcode !== 'manual') {
  qrInput.value = 'https://www.12306.cn/';
}
```

如果 PDF 提供了 `qrcodeContent`，优先用它；没有才兜底。用户手动清空后（origin=manual），不再自动填。

### 6.4 拼音

```text
if (origin[stationPinyin] === 'manual') return;
if (!stationChangedByPdf) return;          // PDF 没改站名，不要动拼音
const py = lookup(stationName);            // 站名 → 全拼
set py || '';                              // 查不到就清空，避免旧站名拼音残留
```

### 6.5 表单摘要

以最终表单值为准（手动值优先），用于导入预览；不要把解析中间态写回行程副本。

### 6.6 行程隔离

- 每个行程 `{data, flags, selects, origin}` 深拷贝；
- 离开行程前快照写回自己；
- 切换时用目标副本覆盖表单；
- 批量导入时先收集所有 parsed，再逐条应用，避免共享引用。

## 7. 测试样例

| # | 输入 | 期望 |
| --- | --- | --- |
| 1 | 标准行程单：北京南→天津西 G2884 2026-09-16 10:24 02车11F 二等座 ￥381.0 | 全字段正确 |
| 2 | 日期/时间拆分式（标签一行、数字下一行） | 日期/时间正确，不用生成时间 |
| 3 | 检票口 `21A`、`24A25A` | 输出含号码，不误取车厢 |
| 4 | 4 字站名 `北京朝阳` / 6 字站名 | 站名完整，票面缩排不溢出 |
| 5 | 无发车时间 | `time=''`，票面不画“开” |
| 6 | 无票价/无座位 | 对应字段留空，不伪造 0 |
| 7 | 订单号 + 电子票号 | 顶部/底部映射正确 |
| 8 | 二维码 `e.12306.cn/orderId/...` | 二维码内容正确；缺失时回退 12306 首页 |
| 9 | 第二次导入，用户已手改票价 | 票价保持手动值 |
| 10 | 用户手动清空姓名后再次导入 | 姓名保持空（手动优先） |
| 11 | 行程 A 改座位，切到 B 再切回 | A 保留自己的座位，B 不受影响 |
| 12 | 电子发票 | 日期不取开票日期，姓名/票号映射正确 |
| 13 | 无文本层扫描件 | 明确提示“未检测到文本层”，不产生空字段 |
| 14 | 加密 PDF | 提示需要密码，不崩溃 |
| 15 | 批量 3 个 PDF | 每个行程独立，顺序稳定 |

## 8. 错误与降级

| 情况 | 行为 |
| --- | --- |
| 没有 pdf.js / 加载失败 | 禁用导入按钮，提示“离线解析组件缺失”，不静默 |
| PDF 没有文本层 | 提示使用 OCR/手动；不应用空结果 |
| 解析不到车次/日期 | 展示已解析字段 + 缺失项，允许手动补 |
| 票号位数异常 | 保留原文但 UI 标黄，提示核对 |
| 多页 | 逐页解析，取字段最完整的一页；不合并不同行程 |
| 超大文件 | >20MB 拒绝，提示压缩/拆分 |
| CMap 缺失 | 中文乱码时提示安装 cmaps；vendor 必须带 GB/UniGB CMap |

## 9. 隐私与合规

- `FileReader`/`ArrayBuffer` 本地读取，不发网络请求；
- 不把 PDF 原文、证件号、姓名写入日志/URL/埋点；
- 导出/预览中的证件号默认脱敏；
- 免责声明必须在使用导入前确认；
- 生成的票面必须带“纪念车票 · 不作乘车凭证”。
