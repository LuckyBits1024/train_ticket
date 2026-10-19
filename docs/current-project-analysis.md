# 当前项目分析（基线 281991e）

## 1. 结构与运行方式

```text
train_ticket/
├── server.js                 # 零依赖 Node HTTP 服务：API + 静态文件 + 登录态
├── src/
│   ├── cookies.js            # CookieJar
│   ├── http.js               # 带 Cookie 的 HTTP 客户端、ApiError
│   ├── rail.js               # 12306 登录/积分/明细接口封装
│   ├── store.js              # data/session.json 会话持久化
│   ├── export.js             # 积分 CSV/JSON 导出
│   ├── ticket_image.py       # Pillow 票面渲染器（2 款式）
│   ├── points_ticket.py      # 积分明细 → 票面字段
│   └── data/                 # 3404 个车站、拼音、首字母、席别
├── public/                   # 积分查询页（原生 HTML/CSS/JS，无构建）
├── scripts/                  # CLI 入口与冒烟测试
├── assets/ticket-template/   # 旧版 2 款票底（1070×730）
├── examples/                 # 票面 JSON 示例
├── output/                   # 生成的票面/模板草稿
└── README.md                 # 使用说明
```

运行：

```bash
node server.js                       # 默认 127.0.0.1:5178
npm run ticket -- --data examples/ticket.json --style both
```

约束：

- Node ≥ 20.11，**零第三方依赖**；
- Python ≥ 3.9 + Pillow（只在生成票面时需要）；
- 无构建步骤、无数据库、无 TypeScript；
- 服务只监听 127.0.0.1，写接口校验 Origin；
- 会话保存在 `data/session.json`（已被 `.gitignore` 忽略）；
- 当前分支基线：`origin/main` 的 `281991e`（仓库默认分支是 `main`，没有 `master`）。

## 2. 已有能力

### 2.1 积分查询

- 12306 App 扫码登录，Cookie 本地保存；
- 积分概览、流水分页、乘车明细展开；
- 区间筛选（最长 2 年）、三个页签（全部/收入/支出）；
- CSV/JSON 导出，含明细、进度、7 天清理；
- 前端：`public/index.html` + `public/app.js` + `public/style.css`，蓝色 12306 风格。

### 2.2 票面生成

- `src/ticket_image.py`：Pillow 逐字段绘制；
- 2 款式：`blue`（1070×730 底图）、`pink`（1070×705）；
- 默认输出 1800px 宽；
- 字段校验、证件号脱敏、日期/车次/车厢/座位/价格规范化；
- 字体从系统路径解析（华文黑体/宋体/Times/Arial Narrow），缺字体报错；
- CLI 支持 JSON、命令行字段、积分导出 JSON/CSV 批量；
- 批量输出命名 `{date}-{train}-{from}-{to}`；
- 测试：`scripts/test-ticket.py` 覆盖渲染与校验，`scripts/smoke-test.mjs` 覆盖服务。

### 2.3 数据

- `src/data/stations.json`：3404 条，`电报码 → 站名`；
- `src/data/stations-pinyin.json`：3404 条，`站名 → 全拼`；
- `src/data/stations-index.json`：3404 条，`{name,pinyin,short,code}`，供 `/api/ticket/stations` 与前端联想；
- `src/data/seats.json`：席别代码 → 名称；
- 没有站名简称/首字母索引，没有“站名 + 拼音 + 电报码”的统一结构。

## 3. 与 TraceDot 的差距

| 维度 | 当前 | TraceDot 4.1.8 | 差距等级 |
| --- | --- | --- | --- |
| 票面款式 | 2 款（蓝/粉） | 8 款（蓝/蓝纸/蓝磁/蓝雕/蓝雕磁/红/红纸/红磁） | 高 |
| 票面精度 | 近似版式，黑体/宋体混排 | 真实票面扫描底 + Times/Arial + 系统中文回退 | 高 |
| 实时预览 | 无（只能跑 CLI 看结果） | Canvas 实时预览 + 字号/字重/字体方案 | 高 |
| 编辑界面 | 无 | 全字段表单 + 细节调整 + 手机端 | 高 |
| PDF 导入 | 无 | 行程单 + 电子发票 + 三条填充规则 | 高 |
| 批量导出 | CLI 逐张 | 单张/全部行程 ZIP + 进度 + 正反面合并 | 中 |
| 背面 | 无 | 标题/条款/底图/遮罩/合并/分开 | 中 |
| 常用乘客 | 无 | 本地列表，一键填充 | 中 |
| 草稿 | 无 | 2 秒轮询 + 关闭保存 | 中 |
| 站名联想 | 无（CLI 靠全拼表） | 站名/全拼/首字母联想 | 中 |
| 设计语言 | 蓝色 12306 工具页 | 铁路信号台（松绿/冷纸/24 网格图标） | 中 |
| 离线 | 全离线 | 全离线（OCR 首次需联网） | 持平 |
| 架构 | 模块化、零依赖、可测试 | 13.5 MB 单 HTML | **我们更好** |
| 数据入口 | 12306 积分（真实行程） | 手动/PDF/OCR/分享 | **我们有差异化优势** |

## 4. 关键约束

1. **不要引入构建链**。当前项目最大的优点是 `node server.js` 即跑；新增前端应使用原生 ES Modules，避免 Vite/React 依赖。
2. **不要破坏 CLI**。`npm run ticket`、`--style blue|pink|both`、`--points`、`--width` 等现有参数必须继续可用；新增参数只能追加。
3. **服务端零依赖**。PDF 解析、ZIP、二维码、Canvas 渲染尽量放浏览器；服务端只做数据与静态资源。
4. **静态资源根目录只有 `public/`**。如果模板放在 `assets/`，需要给 `server.js` 增加只读 `/assets/` 路由与 MIME（`.webp`、`.woff2`、`.wasm`、`.map`）。
5. **字体不可随包分发**。PingFang/HarmonyOS/微软雅黑只能调用系统字体；Nunito Sans 是 OFL，可自托管，但必须带 license。
6. **隐私**。PDF/照片/身份信息不得上传；所有解析与渲染本地完成。
7. **合规**。首次使用强制免责声明；导出图必须带“纪念车票 · 不作乘车凭证”。

## 5. 建议的目标结构

```text
public/
├── index.html                 # 积分页（保留，增加“车票工坊”入口）
├── ticket.html                # 新增：车票工坊
├── style.css                  # 现有积分页样式（逐步抽 tokens）
├── ticket.css                 # 工坊样式（引用 assets/design/tokens.css）
├── app.js                     # 现有积分页逻辑
├── js/ticket/
│   ├── app.js                 # 页面编排、事件、状态
│   ├── templates.js           # 读 manifest、款式元数据
│   ├── layout.js              # 坐标、长文本、换行、缩放
│   ├── renderer.js            # 正面/背面/合并 Canvas
│   ├── pdf.js                 # 12306 行程单/发票解析
│   ├── stations.js            # 站名/全拼/首字母联想
│   ├── store.js               # 草稿、乘客、行程、IndexedDB 图片
│   ├── export.js              # PNG/ZIP/进度/文件名
│   └── ui.js                  # toast、modal、slider、tabs
├── js/vendor/pdfjs/           # 离线 pdf.js（legacy build）
└── assets/                    # 若服务端映射 /assets → 仓库 assets，可省略

src/ticket/                    # Python 侧拆分（保持 src/ticket_image.py 兼容壳）
├── __init__.py
├── templates.py               # 读 assets/ticket-template/v2/manifest.json
├── fonts.py                   # 中英混排、系统字体发现
├── layout.py                  # 与 JS 对齐的坐标与长文本策略
├── render.py                  # 正面
├── back.py                    # 背面
└── validate.py                # 字段规范化（从 ticket_image.py 抽出）

docs/                          # 本目录
assets/ticket-template/v2/     # 新模板资产（已交付）
assets/design/                 # 令牌、图标、截图（已交付）
```

### 5.1 服务端新增

| 路由 | 用途 |
| --- | --- |
| `GET /assets/*` | 只读映射仓库 `assets/`，带 `webp/woff2/wasm/map` MIME；禁止 `..` |
| `GET /api/ticket/records?start&end` | 复用 `collectRecords`，返回可直接喂给工坊的票面草稿数组（可选，P1） |
| `GET /api/ticket/stations` | 返回精简站名/拼音/首字母索引（可选；也可直接静态 JSON） |

### 5.2 前端新增

- `ticket.html`：三栏（预览 / 模板+操作 / 表单），手机单列；
- 从积分页行/明细跳转：`/ticket.html?record=<id>` 或 `sessionStorage` 传 draft；
- 从积分页批量：“生成纪念车票” → 工坊批量模式；
- 从 PDF 导入：拖拽/选择 → 解析 → 预览 → 应用（遵守三条规则）；
- 背面编辑器：正面导出前询问“是否制作背面”，或独立入口；
- 免责声明：首次进入工坊强制确认，`localStorage` 记录版本号。

## 6. 迁移策略

1. **先加不改**：新增 `ticket.html` 与 `public/js/ticket/*`，积分页只加入口，不动现有逻辑。
2. **模板双读**：Python 先支持 `v2` manifest 的 8 款；旧 `blue/pink` 保留为 alias（`blue → blue`，`pink → red`），避免破坏现有脚本。
3. **样式隔离**：工坊使用 `--td-*` 令牌；积分页暂不重写，等工坊稳定后再统一。
4. **测试先行**：先落地 `manifest` 校验、PDF 规则单测、参考图对比，再接 UI。
5. **可回滚**：所有新增文件独立；服务端路由加在白名单末尾；不改 `data/` 结构。

## 7. 验收基线

- `node server.js` 启动后，积分页功能不回归；
- `npm run ticket -- --data examples/ticket.json --style both` 仍生成两张图；
- 新工坊可生成 8 款 2x PNG，尺寸/版式与 `reference/` 参考图在容差内；
- PDF 导入通过 [pdf-import-spec.md](pdf-import-spec.md) 的 10 个样例；
- 手机 390×844 无横向滚动，触控目标 ≥44px；
- 断网后除“检查更新/OCR”外全部可用。

## 8. 本分支实现状态（Web）

已在同一分支落地 M1–M4：

- `public/ticket.html`、`public/ticket.css`；
- `public/js/ticket/`：`app / templates / layout / renderer / validate / stations / store / fill / pdf / export`；
- `public/js/vendor/`：pdf.js 3.11 legacy + cmaps + standard fonts、qrcode 1.5.1；
- `server.js`：`/assets/*` 只读路由、`/api/ticket/stations`、`/api/ticket/records`；
- `src/data/stations-index.json`：3404 条站名/全拼/首字母/电报码；
- `tests/ticket/*.test.mjs`：`npm run test:web`，23 个用例；
- `scripts/test-ticket.py`：16 个用例，覆盖八款尺寸、背面合并、CLI `all/both/pink`。

Python CLI 的八款 parity（M5）已在 `src/ticket/` 内完成：`--style all`、`--scale`、`--back`、`--back-split`，旧的 `blue/pink/both` 命令保持兼容。
