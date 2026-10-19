# TraceDot 4.1.8 逆向分析报告

> 目标：`TraceDot-4.1.8-arm64.dmg`（112,364,517 bytes，SHA-256 见 `.analysis/tracedot/graph.json`）
> 方法：REA 6.5.0 静态 JavaScript/Electron 分析 + asar 解包 + 运行时 Chrome 截图/画布导出
> 证据：`ev_788eb41e58154c6d72f0bddfb3b20189fb506d7207da35b882116acd516251a8`
> 结论置信度：`derived`；权威性：`shipped-artifact`（以发布产物为准）

## 1. 产物与运行时

| 项 | 值 |
| --- | --- |
| 安装包 | `TraceDot-4.1.8-arm64.dmg`，112 MB，UDIF zlib |
| 应用 | `迹点点.app`，约 254 MB |
| Bundle ID | `top.jidiandian.tracedot` |
| 版本 | `CFBundleShortVersionString = 4.1.8` |
| Electron | Chromium 130（Electron 33 代） |
| 主进程 | `Contents/Resources/app.asar` → `main.js`，5,740 bytes |
| 渲染层 | `app.asar` → `app/index.html`，13,489,098 bytes |
| asar | 15,664,283 bytes；241 个相关文件；173 个 JS 文件；50 个 source map |
| 依赖 | 仅 `electron-updater`；无原生模块 |
| 窗口 | 1 个 `BrowserWindow`，1440×900，最小 960×640 |
| 预加载 | **无 preload**；`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` |
| IPC | **0** 个 preload、0 个 contextBridge、0 个 IPC 通道（REA 静态结论） |
| 页面加载 | `win.loadFile(app/index.html)`，纯本地 `file://` |
| 外链 | `setWindowOpenHandler` 交给系统浏览器，应用内禁止导航 |
| 更新 | `electron-updater` + GitHub Releases；未签名时降级为打开发布页 |

### 1.1 为什么它“单文件也能跑”

`app/index.html` 不是普通页面，而是一个**壳 + 七个模块**：

- 壳：左侧导航、顶栏、iframe 容器、版本检查、通用交互；
- 七个模块：`payload-ledger`、`payload-ticket`、`payload-plane`、`payload-transit`、`payload-venue`、`payload-collection`、`payload-travel`，每个都是一整页 HTML，base64 后塞进 `<script type="text/plain">`；
- 运行时 `atob` 解码，写入 `<iframe srcdoc>`；模块之间通过壳层消息/存储联动。

| 模块 | payload 解码后 | 说明 |
| --- | --- | --- |
| 行程地图 `ledger` | 3.13 MB | 地图、统计、行程总览 |
| 火车票工坊 `ticket` | 4.75 MB | 本次重点，含 pdf.js、html2canvas、车站库、票面逻辑 |
| 登机牌 `plane` | 873 KB | 登机牌工坊 |
| 交通票 `transit` | 216 KB | 公交/地铁/出租车 |
| 影演票 `venue` | 235 KB | 电影/景区/演出 |
| 珍藏册 `collection` | 79 KB | 编年史时间轴 |
| 旅行计划 `travel` | 65 KB | AI 行程规划 |

这种结构带来极致的“单文件可分发”，代价是：

- 13.5 MB HTML 每次全量加载、解析、base64 解码；
- 代码无模块边界、无类型检查、无构建；
- 版本号、注释、功能容易漂移（见 §7）；
- 不适合作为本项目的目标架构，只适合提取“票面资产 + 规则”。

### 1.2 安全边界

REA 的 Electron fuse 读取结果（`inspect-electron-fuses`）：

| fuse | 状态 | 影响 |
| --- | --- | --- |
| `RunAsNode` | enabled | 可用 `ELECTRON_RUN_AS_NODE` 以 Node 运行 |
| `EnableNodeOptionsEnvironmentVariable` | enabled | 可注入 `NODE_OPTIONS` |
| `EnableNodeCliInspectArguments` | enabled | 可开调试端口 |
| `EnableEmbeddedAsarIntegrityValidation` | disabled | asar 完整性不校验 |
| `OnlyLoadAppFromAsar` | disabled | 可绕过 asar 加载 |
| `GrantFileProtocolExtraPrivileges` | enabled | file:// 额外权限 |

渲染进程本身是沙箱化、无 Node、无 preload 的，攻击面主要在主进程/打包层。**这套 Electron 打包方式不要照抄**；本项目是本地 Web 服务，保持“零原生依赖、只监听 127.0.0.1、静态资源白名单”更简单。

## 2. 车票工坊功能盘点

从 `payload-ticket` 的 DOM、CSS 与脚本可直接确认：

- 八款正面底图：蓝色票、蓝纸票、蓝磁票、蓝雕票、蓝雕磁票、红色票、红纸票、红磁票；
- 实时 Canvas 预览（809×509 / 800×535），不是 DOM 票面；
- 全字段编辑：票号、检票口、始发/到达、拼音、车次、席别、日期、时间、车厢、座位、铺位、票价、证件号、姓名、附加信息 1/2/3、取票机编号、二维码内容；
- 字号 80%–130%、字重 400–800 实时调节；
- 中文/英文/数字三套字体方案，可分别选择或恢复系统默认；
- 12306 行程信息提示 PDF 导入（pdf.js 内联，离线解析）；
- 铁路电子发票解析；
- 纸质票 OCR（可选，Tesseract/PP-OCR/云端，首次需联网下载模型）；
- 常用乘客、本地草稿、车次历史；
- 正面 + 背面制作，合并导出或分开导出；
- 单张导出、全部行程批量 ZIP、导出进度；
- 二维码开关、二维码内容兜底；
- 免责声明强制确认（V4.9.1）；
- 细节调整浮窗（按模块调位置/字号/字距/字重，V5.3）；
- 手机端底部快捷导航、单列布局。

### 2.1 本地存储

| key | 内容 |
| --- | --- |
| `__ticketDraft_v1` | 当前表单全量快照（含票种） |
| `__commonPassengers_v1` | `[{name, identity}]` |
| `__trainNoHistory_v1` | 车次联想历史 |
| `__ticketQrEnabled` | 二维码开关 |
| `__ocrEngine` / `__ocr*Key` | OCR 引擎与密钥（可选） |

草稿每 2 秒轮询保存，`beforeunload` / `visibilitychange` 强制保存；恢复时如果 URL 有分享参数或珍藏册预填，则不覆盖。

## 3. 票面渲染：一套坐标，八张底图

### 3.1 画布与底图

| key | 中文 | 逻辑画布 | 底图 | 家族 | 底图处理 |
| --- | --- | --- | --- | --- | --- |
| `blue` | 蓝色票 | 809×509 | 811×509 PNG | blue | 1:1 |
| `blue-paper` | 蓝纸票 | 809×509 | 809×509 PNG | blue | 1:1 |
| `blue-mag` | 蓝磁票 | 809×509 | 809×509 PNG | blue | 1:1 |
| `blue-etch` | 蓝雕票 | 809×509 | 1255×772 WebP | blue | cover 居中裁切 |
| `blue-etch-mag` | 蓝雕磁票 | 809×509 | 1058×655 WebP | blue | cover 居中裁切 |
| `red` | 红色票 | 800×535 | 800×531 PNG | red | 1:1 |
| `red-paper` | 红纸票 | 800×535 | 800×535 PNG | red | 1:1 |
| `red-mag` | 红磁票 | 800×535 | 800×535 PNG | red | 1:1 |

底图本身已经去掉所有可变文字，只保留：纸张纹理、列车/山水版画、虚线框、底部色带、微缩 CR 文字。**文字、箭头、二维码全部由绘制层生成**。

### 3.2 基准布局（1x 像素）

`textBaseline = "middle"`，默认黑色；票号红色。蓝色家族 `dx=0, dy=0`，红色家族 `dx=10, dy=20`。

> 表中的 `Times`/`Arial` 是源码实参；V6.2.6 的 `normalizeTicketFamily()` 会把它们替换成系统无衬线栈，参考图即按系统无衬线渲染。

| 元素 | 位置 / 字号 | 备注 |
| --- | --- | --- |
| 票号 | `(45, 50)` Arial 40，字距 4，红色 | 左对齐 |
| 检票口 | `(760, 40)` Times 30，右对齐 | 部分票种与到达站“站”右缘对齐 |
| 始发站 | `(60, 105)` Times 50 + “站” 32 | 长站名按公式缩排 |
| 到达站 | `(550, 105)` Times 50 + “站” 32 | 同上 |
| 拼音 | 站名下方 `y+40`，Times 30，居中 | 起点 `max(x+90, 测量宽/2+100)` |
| 车次 | `(400, 105)` Times 46，居中 | 箭头从 `x-55` 到 `x+65`，`y+30` |
| 日期时间 | `(40, 190)` 数字 38 / 汉字 24，间隔 5 | 缺时间时只画到“日” |
| 车厢座位 | `(522, 190)` 数字 40 / 汉字 24 | `02车11F号` |
| 票价 | `(40, 235)` 数字 36 / “元” 24 | `￥381.0元` |
| 优惠标志 | 中心 `x=360`，`y=235`，24 | 孩/学/网/惠，圆圈 r=15 |
| 席别 | `(620, 235)` Times 30，居中 | 二等座等 |
| 附加信息 1 | `(40, 270)` 24 | 限乘当日当次车 / 退票费 |
| 附加信息 2 | `(40, 305)` 24 | 固定纪念文案 |
| 证件号 | `(40, 345)` 35 | 脱敏 |
| 姓名 | `(400, 345)` 32 | 超宽折两行，禁区到二维码左缘 -8px |
| 虚线框 | `(80, 365)` 460×70，线宽 2，`[10,5]` | 报销提示 |
| 底部提示 | `(300, 385/415)` 24，居中 | 两行 |
| 取票机号 | 蓝 `(40, 475)`；红 `(40, 485)`，27 | 均已含家族 `dy`；再叠加 `machDy` |
| 二维码 | 蓝 `(600,300,128)`；红 `(600,360,136)` | 蓝纸票 y=307，与虚线框底对齐 |

### 3.3 每款底图的排版微调

```js
blue-paper:  ticketNoDx -5, ticketNoDy -4, machineDy -10,
             checkin 与票号底部对齐, qr 与虚线框底部对齐
blue-mag:    machineDy +12
red:         checkin 右缘与到达站“站”右缘对齐
red-paper:   同 red
red-mag:     allDy +14（票号/检票口以外整体下移）, checkinDy +14,
             checkin 右缘对齐
```

`allDy` 只作用于除票号/检票口以外的内容；`machineDy` 只作用于取票机号；`checkinDy` 只作用于检票口。

### 3.4 长文本策略

- 站名 <4 字：可用宽度 160px；≥4 字：向左扩展，宽度 `170 + (len-3)*20`，字号不变；
- 到达站“站”的 x 位移比始发站更保守（`+25/字` vs `+33/字`），给检票口对齐留空间；
- 姓名：在 `[400, qrX-8]` 内先尝试一行；不行则找“两行最均衡”的切分；仍不行按比例缩小字号（最低 20px）；最后用禁区裁剪兜底；
- 字号滑块是全局缩放，不改变基准坐标；长内容溢出时应“先缩、再截断”，不能压到二维码。

## 4. PDF 导入：三条规则 + 二维码兜底

这是 TraceDot 最值得直接复用的业务规则（V4.8/V4.9 固化）：

1. **自动回填**：导入后自动抓取 PDF 字段填入表单；
2. **手动优先**：字段一旦被用户手动修改，后续任何 PDF 导入都不覆盖；
3. **非空优先**：PDF 里空白/未识别到的字段，不覆盖表单中已有的非空值。

实现要点：

- 用 `fieldOrigin[field] = "manual" | "pdf"` 记录来源；程序回填不触发 `input/change`，所以不会被误标记为 manual；
- 用户手动改过的复选框/下拉框也不再被覆盖；
- 二维码：PDF 未回填且用户没手动改过、当前为空 → 恢复 `https://www.12306.cn/`；
- 拼音：站名回填后按车站库联动；用户手动改过拼音则跳过；
- 票号映射（V4.9.3）：PDF 的**订单号（短串）**写顶部红字票号，**电子票号（长数字）**写底部黑字取票机号；两者不要反；
- 绝不用 PDF 的“生成时间”当乘车日期；
- 行程之间数据独立深拷贝，编辑 A 行程不能污染 B（V4.9.1）。

解析器接受两类 PDF：

- 「行程信息提示」：站名行 + “站 站”标签行、`YYYY年MM月DD日`、`HH:MM`、`03车10F号`、席别、检票口、姓名+证件、电子票号、订单号、`e.12306.cn` 二维码、票价；
- 「电子发票（铁路电子客票）」：发票号码/开票日期、出发站/车次/到达站、乘车日期、席别、票价等。

详细字段映射与正则样例见 [pdf-import-spec.md](pdf-import-spec.md)。

## 5. 背面制作

默认背面不是图片，而是**用同一张正面底图 + 标题 + 条款**绘制：

- 标题默认 `报销凭证使用须知`，40px / 700 / `#333`；
- 条款默认 6 条（领取期限、退票费凭证、遗失不补、改签退票交回、不能乘车、其他规定），21px / 500 / `#3c3c3c`；
- 背景可选：六款票面底图 / 纯色 / 自定义图片；
- 可加遮罩（黑/白 + 透明度）；
- 标题/条款字号、字重、颜色均可调；
- 导出方式：正反面合并为一张（中间 26px 白缝）或分开两张；
- 批量时每个行程可独立背面，或统一款式。

默认条款原文（可直接作为产品默认值，注意这是“报销凭证”文案，不是乘车须知）：

```text
☆购票后如需报销凭证的，应在开车前或乘车日期之日起180日以内(含当日),持购票时所使用的有效身份证件原件到车站售票窗口、自动售票机领取。
☆退票后如需退票费报销凭证，应在办理之日起180天以内(含当日),持购票时所使用的有效身份证件原件到车站退票窗口领取。
☆报销凭证开具后请妥善保管，丢失后将无法办理补办申领手续。
☆已领取报销凭证的车票办理改签、退票或退款手续时，须交回报销凭证方可办理。
☆报销凭证不能作为乘车凭证使用。
☆未尽事宜见《国铁集团铁路旅客运输规程》等有关规定和车站公告。跨境旅客事宜见铁路跨境旅客相关运输组织规则和车站公告。
```

## 6. 设计语言：铁路信号台

票面工坊的 CSS 头部写得很清楚：

- 主题：绿皮车 × 现代时刻表；
- 原始色板：青松墨阶 `--c-pine-*`、信号绿 `--c-signal-*`、冷纸 `--c-paper-*`、油墨 `--c-ink-*`；
- 浅色语义：背景 `#F0F8F3`、卡片 `#FCFEFC`、主色 `#3F9471`、文字 `#1F3328`；
- 图标：30 个 24 网格线性 SVG，1.8 描边、圆角接头，禁用 emoji；
- 卡片：实色 + 发丝线 + 斜向微光 + 聚光，不用毛玻璃；
- 性能铁律：禁用 `backdrop-filter`、背景渐变静态化、聚光层固定尺寸 + transform；
- 响应式三档：手机 <768、平板 768–1023、桌面 ≥1024；
- 手机：预览 → 行程 → 乘客 → PDF → 识别的单列流 + 底部快捷导航；
- 触控目标 ≥44px，`prefers-reduced-motion` 全部瞬时切换。

> 注意：4.1.8 产物里仍能搜到 8 处 `backdrop-filter`，与 V4.9.2 更新日志“全站禁用”不完全一致。本项目以**更新日志的设计方向**为准：新代码零 `backdrop-filter`。

截图见：

- `assets/design/screenshots/ticket-studio-desktop.webp`
- `assets/design/screenshots/ticket-studio-mobile.webp`
- `assets/design/screenshots/ticket-studio-disclaimer.webp`

## 7. 官网、版本与字体

- `https://jidiandian.top/release/TraceDot-V4.1.8.html` 与桌面端 `app/index.html` **字节完全一致**（SHA-256 `50e3dc11…28bcb0`）。所以“网页端/桌面端”是同一份单文件，不是两套代码。
- 官网首页（`https://jidiandian.top/website/`）是另一套营销站：Plus Jakarta Sans + Noto Sans SC + JetBrains Mono，CDN Tailwind；与工坊的实际字体栈不同。
- 工坊实际 UI 字体栈：`PingFang SC, HarmonyOS Sans SC, Noto Sans SC, Microsoft YaHei, sans-serif`；**没有加载 Nunito Sans**。
- 票面字体：源码里写的是 `Times New Roman` / `Arial`，但 V6.2.6 的 `normalizeTicketFamily()` 会把它们替换成**系统无衬线栈**；参考图的数字/英文/中文都是系统无衬线。没有内嵌票面字体文件。
- 版本漂移：安装包 4.1.8、页面标题 4.1.8、票面模块头 V6.3.0、官网更新日志到 V4.9.3。做竞品对比时要看**代码内容**，不要只看版本号。

## 8. 可复用 / 不复用清单

### 直接复用

- 八张已去字底图（见 `assets/ticket-template/v2/`）；
- 809×509 / 800×535 逻辑画布与基准坐标；
- 每款底图的排版微调参数；
- PDF 三条填充规则、二维码兜底、票号映射；
- 背面默认文案、合并/分开导出逻辑；
- 30 个 24 网格图标、信号台色板、响应式三档；
- “手动优先 / 非空优先 / 行程隔离”的测试用例。

### 只借鉴、不照搬

- 单文件 + base64 + iframe 注入：改为模块化 Web 页面；
- 13 MB 内联 pdf.js/OCR：改为按需加载、可离线缓存的 vendor；
- OCR 云端密钥：默认不启用，避免隐私与密钥问题；
- Electron 打包/fuse：本项目是本地 Web 服务，不需要 Electron；
- 低分辨率 809px 底图直接导出：改为 2x 逻辑导出，并明确素材上限。

### 风险

- **权利风险**：底图来自第三方对 12306 票面的再创作，商用/公开发布前必须确认授权，见 `NOTICE.md`；
- **合规风险**：生成的票面必须显著标注“纪念车票 · 不作乘车凭证”，首次使用强制免责声明；
- **字体风险**：PingFang/HarmonyOS/微软雅黑不可随包分发；只能调用系统字体；
- **精度风险**：Pillow 与浏览器 canvas 的字体度量不同，必须用参考图做视觉回归；
- **维护风险**：如果同时维护 Web canvas 与 Python Pillow 两套渲染器，必须有共享 manifest + 同一组 golden 测试，否则很快漂移。
