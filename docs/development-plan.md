# 开发计划（交给实现 agent）

> 分支：`feat/ticket-template-upgrade`（基于 `origin/main` `281991e`）
> 目标：在不破坏现有积分查询/CLI 的前提下，新增一个离线、响应式、可编辑的「车票工坊」，复用 TraceDot 的八款票面与规则。
> 验收人：本轮分析 agent；验收清单见 §10。

## 0. 范围

### 必须交付（v1）

1. 八款正面模板 + 2x 导出；
2. Web 实时预览与全字段编辑；
3. 字号/字重/中英数字体方案；
4. 站名/拼音/首字母联想；
5. 常用乘客、草稿自动保存；
6. 12306 行程单/电子发票 PDF 导入（三条填充规则 + 二维码兜底）；
7. 从积分记录导入/批量导入；
8. 批量导出 ZIP、导出进度；
9. 背面编辑器（标题/条款/底图/遮罩）、合并/分开导出；
10. 响应式（桌面/平板/手机）、免责声明；
11. Python CLI 支持八款新模板（保留旧 `blue/pink`）；
12. 单元测试 + 视觉参考图回归 + README 更新。

### 明确不做（本版）

- Electron 打包 / 自动更新；
- 云端 OCR / AI 识别（接口可预留，默认关闭）；
- 用户账号、云同步、分享链接服务端；
- 深色主题（令牌预留，v1 只做浅色）；
- 多语言；
- 真实报销/乘车用途（产品内必须明确禁止）。

## 1. 里程碑

| 里程碑 | 内容 | 预计 | 退出条件 |
| --- | --- | --- | --- |
| M1 基础 | 资产路由、manifest、tokens/icons、`ticket.html` 骨架、免责声明、响应式壳 | 2–3 天 | 页面离线打开，8 缩略图可见，手机无横滚 |
| M2 正面 | Canvas 渲染、表单、字体控制、站名联想、草稿/乘客、PNG 导出、积分预填 | 4–5 天 | 8 款与参考图结构一致；长文本用例通过 |
| M3 导入/批量 | pdf.js vendor、解析器、填充状态机、批量导入、ZIP、进度 | 4–5 天 | 15 个 PDF 用例通过；手动优先/行程隔离 |
| M4 背面/打磨 | 背面编辑器、合并/分开、移动端导航、a11y、性能 | 3–4 天 | 正面+背面合并导出正确；手机 390×844 通过 |
| M5 Python | 拆模块、混排字体、8 款、背面、测试、旧参数兼容 | 3–4 天 | CLI 快照通过；旧命令不回归 |

> 单人顺序开发约 3 周；M2 与 M5 可并行（不同人）。

## 2. 目标结构

```text
public/
├── ticket.html
├── ticket.css
├── js/ticket/
│   ├── app.js            # 页面状态、事件、渲染循环
│   ├── templates.js      # manifest 加载、款式查询
│   ├── layout.js         # 坐标、长文本、换行、缩放
│   ├── renderer.js       # 正面/背面/合并
│   ├── pdf.js            # 解析 + normalize
│   ├── fill.js           # 三条填充规则状态机
│   ├── stations.js       # 站名/全拼/首字母索引
│   ├── store.js          # localStorage + IndexedDB
│   ├── export.js         # PNG/ZIP/文件名/进度
│   └── ui.js             # toast/modal/slider/tabs
├── js/vendor/pdfjs/      # legacy build + cmaps（懒加载）
└── data/stations.compact.json  # 可选，构建时从 src/data 生成

src/ticket/
├── __init__.py
├── templates.py
├── fonts.py
├── layout.py
├── render.py
├── back.py
└── validate.py
src/ticket_image.py       # 兼容壳：re-export 旧 API
```

服务端：

- `GET /assets/*` → 仓库 `assets/` 只读映射；补 `.webp/.woff2/.wasm/.map` MIME；拒绝 `..`、隐藏文件；
- `GET /api/ticket/stations` → `[[name, pinyin, code], ...]`，缓存 1 天；
- `GET /api/ticket/records?start&end` → 复用 `collectRecords`，返回票面草稿数组（P1，可先由前端拼 `/api/points` + `/api/detail`）。

## 3. 数据模型

```ts
type StyleKey =
  | 'blue' | 'blue-paper' | 'blue-mag' | 'blue-etch' | 'blue-etch-mag'
  | 'red' | 'red-paper' | 'red-mag';

interface TicketDraft {
  id: string;
  style: StyleKey;
  ticketNo: string;        // 顶部红字：订单号/短票号
  checkinRoom: string;
  startStation: string;
  startStationPY: string;
  endStation: string;
  endStationPY: string;
  trainNo: string;
  seatClass: string;
  date: string;            // YYYY-MM-DD
  time: string;            // HH:mm | ''
  carriageNo: string;      // 2 位
  seatNo: string;          // 11F | 无座
  seatPosition: string;    // 上铺/中铺/下铺/卧
  price: string;           // 一位小数
  identity: string;        // 显示时脱敏
  name: string;
  info1: '0' | '1' | '2' | '9';
  info2: string;
  info3: '0' | '1' | '2' | '9';
  machineId: string;       // 底部黑字：电子票号/取票机号
  qrcodeString: string;
  qrEnabled: boolean;
  flags: { child: boolean; student: boolean; online: boolean; discount: boolean };
  fontScale: number;        // 0.8–1.3
  fontWeight: 400 | 500 | 600 | 700 | 800;
  fontScheme: { zh: string; en: string; num: string };
  back: BackStyle | null;
  createdAt: string;
  updatedAt: string;
}

interface BackStyle {
  background: StyleKey | 'solid' | 'custom';
  solidColor: string;
  customImageId?: string;   // IndexedDB key
  mask: { enabled: boolean; color: 'black' | 'white'; alpha: number };
  title: string;
  titleSize: number;        // 10–80
  titleWeight: 400 | 500 | 600 | 700 | 800;
  titleColor: string;
  terms: string;
  termsSize: number;
  termsWeight: 400 | 500 | 600 | 700 | 800;
  termsColor: string;
  splitExport: boolean;
}

interface Passenger { id: string; name: string; identity: string; updatedAt: string; }
```

存储键（命名空间 `train-ticket:`）：

| key | 内容 |
| --- | --- |
| `train-ticket:draft:v1` | 当前草稿 |
| `train-ticket:trips:v1` | 行程数组（批量） |
| `train-ticket:passengers:v1` | 常用乘客 |
| `train-ticket:train-history:v1` | 车次历史 |
| `train-ticket:disclaimer:v1` | 已同意的免责声明版本 |
| IndexedDB `train-ticket-assets` | 自定义背面图片（Blob） |

迁移：不读取 TraceDot 的 `__ticketDraft_v1`，避免跨产品串数据；如未来要导入，单独做迁移工具。

## 4. 渲染器接口

```js
// templates.js
export async function loadTemplates(): Promise<TemplateManifest>;
export function getTemplate(key: StyleKey): Template;

// renderer.js
export function renderFront(canvas, draft, template, opts): void;
export function renderBack(canvas, draft, template, backStyle, opts): void;
export function composeFrontBack(frontCanvas, backCanvas): HTMLCanvasElement;

// opts
{ scale: 1 | 2 | 3, qrImage?: HTMLImageElement, imageSmoothing: boolean }
```

要求：

- 渲染器**不读 DOM**；输入是 draft + template；便于 Node 单测（用 `@napi-rs/canvas` 可选，不强制）。
- 预览与导出调用同一函数，仅 `scale` 不同；不允许两套布局。
- 文本槽位集中在 `layout.js`，不要散落在事件处理里。
- 所有坐标来自 `manifest.json` 的 `layout`，允许代码内默认值兜底，但必须与 manifest 一致。

Python：

```python
from src.ticket import render_ticket, normalize_fields, save_ticket
img = render_ticket(data, style='blue-etch', width=1618)
```

兼容：

- `src/ticket_image.py` 继续导出 `FIELDS / LIMITS / FontBook / normalize_fields / render_ticket / save_ticket`；
- `render_ticket(style='pink')` 映射旧 pink；`both` 仍为 blue+pink；
- 新增 `--style all`、`--scale`、`--back`、`--back-only`。

## 5. 任务拆分

### M1 基础

- [ ] `server.js`：`/assets/*` 只读路由 + MIME + 路径校验；加 `HEAD`；
- [ ] `public/ticket.html`：顶栏、两列骨架、预览卡、模板条、表单占位、免责声明；
- [ ] `public/ticket.css`：引入 `assets/design/tokens.css`，完成桌面/平板/手机布局；
- [ ] 内联 `assets/design/icons.svg`（或 fetch 注入）；
- [ ] `templates.js` 读取 manifest，渲染 8 个缩略图；
- [ ] 免责声明：首次强制确认，3 秒倒计时，拒绝回积分页；`localStorage` 记版本；
- [ ] 空状态/加载态/错误态。

**验收**：断网打开 `/ticket.html` 无 404；8 缩略图；390×844 无横滚；键盘可操作免责声明。

### M2 正面

- [ ] `layout.js`：§2 坐标、§3 长文本、姓名折行、字号缩放；
- [ ] `renderer.js`：8 款底图、cover/stretch、混排字体、二维码、虚线框；
- [ ] 表单：全部字段、校验、错误提示、脱敏；
- [ ] 字号/字重滑块 + 三套字体方案（系统默认/内置列表）；
- [ ] 站名联想：站名/全拼/首字母，键盘上下/回车，选中回填拼音；
- [ ] 常用乘客：保存/填充/删除；
- [ ] 草稿：2 秒防抖 + beforeunload；恢复时不覆盖分享/预填；
- [ ] 导出：2x PNG、文件名、PNG 元数据、导出前二维码就绪等待；
- [ ] 积分预填：从 `/api/points` + `/api/detail` 取一条，映射字段；缺省不伪造；
- [ ] 预览性能：rAF 合并、底图 decode 一次、二维码缓存。

**验收**：8 款 1x/2x 与参考图结构一致；4/6 字站名、长姓名、无时间/无票价不溢出；导出文件名合法；刷新恢复草稿。

### M3 导入/批量

- [ ] vendor pdf.js legacy + cmaps，懒加载；`file://` 可用；
- [ ] `pdf.js`：行聚类、行程单解析、发票解析、normalize；
- [ ] `fill.js`：manual/pdf 状态机、非空优先、二维码兜底、拼音联动；
- [ ] 行程数组：多 PDF/多记录、切换隔离、逐条编辑；
- [ ] 批量导入积分记录：选择范围/记录、进度、失败列表；
- [ ] 批量导出：ZIP（store）、重名处理、进度/取消；
- [ ] 解析预览：字段表 + 缺失项 + “应用”按钮；
- [ ] 错误：无文本层/加密/超大/解析失败。

**验收**：`pdf-import-spec.md` §7 的 15 个用例；第二次导入不覆盖手改；A/B 行程隔离；ZIP 可解压、张数正确。

### M4 背面/打磨

- [ ] 背面编辑器：底图/纯色/自定义、遮罩、标题、条款、字号/字重/颜色；
- [ ] 导出询问：否/是；合并 26px 白缝；分开导出；
- [ ] 批量时逐行程背面/统一背面；
- [ ] 移动端底部导航、吸顶、44px 触控；
- [ ] a11y：label、aria、focus trap、对比度、reduced motion；
- [ ] 性能：无 backdrop-filter、静态渐变、导出不阻塞；
- [ ] README/使用说明/截图。

**验收**：正面+背面合并图尺寸正确；手机全流程可完成；Lighthouse 无严重可访问性问题（若可跑）。

### M5 Python

- [ ] 抽 `src/ticket/`，`ticket_image.py` 兼容；
- [ ] 读 manifest；8 款；cover/stretch；
- [ ] 混排字体（ASCII Times/Arial + CJK 系统字体），缺字体报错；
- [ ] 长文本/姓名折行与 JS 对齐；
- [ ] 背面绘制 + 合并；
- [ ] CLI：`--style all`、`--scale`、`--back`、`--back-only`；旧参数兼容；
- [ ] 测试：8 款快照、长文本、批量积分、旧 `blue/pink/both`。

**验收**：`npm run ticket -- --data examples/ticket.json --style all` 生成 8 张；`--style both` 仍生成 2 张；`scripts/test-ticket.py` 全绿。

## 6. 测试计划

### 6.1 单元测试（Node `node:test`，零依赖）

- `layout.test.mjs`：站名宽度、姓名折行、槽位 maxWidth、缩放；
- `pdf.test.mjs`：15 个文本样例（纯文本，不需要真 PDF）；
- `fill.test.mjs`：手动优先、非空优先、二维码兜底、行程隔离；
- `validate.test.mjs`：日期/车次/车厢/座位/价格/证件脱敏；
- `export.test.mjs`：文件名清洗、重名、ZIP 结构（可用纯 JS 解析）。

### 6.2 视觉回归

- 固定输入（见 `ticket-template-spec.md` §8）；
- 8 款 × 3 用例 = 24 张；
- 与 `reference/` 对比：结构框偏差 ≤2px（1x），背景 MAE ≤1.5%；
- 人工走查：字体、间距、二维码、虚线框、红色票号。

### 6.3 端到端

- 桌面 1440×1000 / 平板 820×1180 / 手机 390×844；
- 全流程：打开 → 免责 → 选款 → 填字段 → 导入 PDF → 改字段 → 背面 → 导出 → 批量 ZIP；
- 断网（DevTools Offline）重复全流程（除 OCR/更新）；
- 刷新/关闭恢复草稿；
- 积分页回归：登录（可用 mock）、查询、导出 CSV/JSON。

### 6.4 性能预算

| 项 | 预算 |
| --- | --- |
| 首屏 JS（不含 pdf.js） | ≤300 KB gzip |
| 首屏图片（8 缩略图） | ≤100 KB |
| 预览重绘 | ≤16ms 桌面 / ≤50ms 手机 |
| 2x 导出 | ≤1s/张 |
| 内存 | ≤150 MB（8 张 2x 画布） |
| pdf.js | 仅导入时加载 |

## 7. 接口契约

### 7.1 `GET /api/ticket/stations`

```json
{ "updatedAt": "2026-10-20", "stations": [["北京南","Beijingnan","VNP"], ...] }
```

- 3404 条；gzip 后约 40–60 KB；
- `cache-control: public, max-age=86400`；
- 失败时前端回退到内置精简表（可选）。

### 7.2 `GET /api/ticket/records?start=&end=`

```json
{
  "range": { "start": "2025-10-20", "end": "2026-10-20" },
  "records": [
    {
      "id": "...",
      "date": "2026-09-16",
      "trainNo": "G2884",
      "fromStation": "北京南",
      "toStation": "天津西",
      "fromStationPY": "Beijingnan",
      "toStationPY": "Tianjinxi",
      "seatClass": "二等座",
      "carriageNo": "02",
      "passengerName": "李某某",
      "time": "",
      "seatNo": "",
      "price": ""
    }
  ],
  "warnings": ["积分明细不含发车时间/座位号/票价"]
}
```

- 复用 `collectRecords`/`flattenRecords`；不新增 12306 请求；
- 只读；不写 `data/`；
- 失败返回 502 + 可读错误。

## 8. 安全与隐私

- 所有票面/PDF 处理在浏览器；服务端不接收 PDF；
- 不要用 `innerHTML` 插入用户字段；一律 `textContent`；
- 文件名清洗：`[\\/:*?"<>|]` → `_`；长度 ≤120；
- 导出 PNG 加 `Description=纪念车票 · 不作乘车凭证`；
- 免责声明版本化；未同意不得进入工坊；
- 不在日志/URL/埋点写证件号、姓名、票号；
- 不引入第三方统计、CDN 字体、远程图片；
- 服务端静态路由防目录穿越；`/assets/*` 只允许白名单扩展名。

## 9. 提交与协作

建议提交序列（每个可独立回滚）：

1. `chore: add ticket template assets and design tokens`
2. `feat(ticket): add template manifest loader and studio shell`
3. `feat(ticket): canvas renderer for eight ticket styles`
4. `feat(ticket): editor form, station autocomplete, passengers, drafts`
5. `feat(ticket): pdf import and fill precedence`
6. `feat(ticket): batch import/export with progress`
7. `feat(ticket): back side editor and merge export`
8. `feat(ticket): responsive layout and accessibility`
9. `feat(ticket): python renderer parity`
10. `docs: update README and ticket studio guide`

要求：

- 不提交 `.analysis/`、`output/_analysis/`、`data/session.json`、任何真实个人信息；
- 大文件只提交 `assets/ticket-template/v2` 与必要截图；
- 每个提交前跑 `node --test` 与 `npm run test`；
- PR 描述附 8 款截图 + 手机截图 + 测试命令输出。

## 10. 验收清单（我会按这个检查）

### 资产与许可

- [ ] `manifest.json` 的 8 个 `sha256` 与文件一致；
- [ ] `NOTICE.md` 保留，README 有免责声明；
- [ ] 未打包 PingFang/HarmonyOS/微软雅黑/Times New Roman 字体文件。

### 票面

- [ ] 8 款 1x 渲染与 `reference/` 结构一致；
- [ ] 2x 导出尺寸：蓝 1618×1018，红 1600×1070；
- [ ] 蓝纸票票号/检票口/取票机号微调正确；
- [ ] 红磁票整体下移 14px、检票口再下移 14px；
- [ ] 蓝雕 cover 裁切不拉伸；
- [ ] 二维码位置/大小/清晰度正确；无旧码；
- [ ] 长站名（6 字）、长姓名（>10 字）、无时间/无票价/无座位不溢出；
- [ ] 票号红色、其余黑色；Times/Arial + 中文回退，无宋体错配；
- [ ] 底部“纪念车票 · 不作乘车凭证”存在。

### PDF

- [ ] 三条规则逐条可演示（自动/手动/非空）；
- [ ] 订单号/电子票号映射正确；
- [ ] 二维码兜底与手动清空；
- [ ] 行程隔离；
- [ ] 无文本层/加密/超大文件有明确提示；
- [ ] 不联网、不上传。

### 交互

- [ ] 桌面/平板/手机全流程；
- [ ] 手机无横滚、触控 ≥44；
- [ ] 草稿恢复、乘客保存、站名联想；
- [ ] 导出进度、取消、失败列表；
- [ ] 背面合并/分开、批量逐行程；
- [ ] 免责声明无法绕过；
- [ ] 键盘可完成主要流程，焦点可见。

### 工程

- [ ] `node server.js` 无报错；积分页回归；
- [ ] `npm run ticket -- --data examples/ticket.json --style both` 仍工作；
- [ ] `--style all` 生成 8 张；
- [ ] `node --test` 全绿；
- [ ] 无 `backdrop-filter`、无 CDN 字体/图片、无第三方统计；
- [ ] 首屏/导出性能在预算内；
- [ ] README 更新，包含截图与限制说明。

## 11. 开放问题（实现前确认）

1. 旧 `pink` 是否保留为 legacy？建议保留，`both` 不变，新增 `all` 用八款。
2. PDF 导入是否允许“部分应用”？建议允许，预览里勾选字段。
3. 背面默认文案是“报销凭证”还是“纪念说明”？建议保留报销凭证默认，但允许改成纪念文案；导出图仍带“不作乘车凭证”。
4. 是否引入 Nunito Sans 自托管？建议先不引入，用系统栈；后续再加 woff2 + OFL。
5. 批量导出 ZIP 是否用 store-only？建议是，零依赖、足够快。
6. 自定义背面图片存 IndexedDB 还是 localStorage？建议 IndexedDB（Blob），避免 5MB 限制。
