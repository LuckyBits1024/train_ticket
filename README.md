# 12306 会员积分 · 本地查询 / 导出

一个跑在自己电脑上的「12306 会员中心 · 积分查询」复刻页面：

- 用**铁路12306 App 扫码登录**，不接触账号密码；
- 登录态（Cookie）保存在本机，重启服务后自动恢复；
- 查询最近一年的积分流水，点击任意一条可展开**乘车明细**（乘车人、乘车日期、车次、区间、席别、车厢号、订单号）；
- 一键导出这一年（或任意区间）的**全部流水 + 全部乘车明细**为 CSV / JSON；
- 用积分流水直接批量生成**纪念车票**（蓝色磁介质 / 经典粉红两款）。

> 仅供查询自己的 12306 会员积分。接口来自 12306 网页端，不是官方公开 API，页面改版后可能需要调整。

## 快速开始

要求：Node.js >= 20.11（无第三方依赖，不需要 `npm install`）。

```bash
cd /Users/lyx/code/train_ticket
node server.js
```

浏览器打开终端里打印的地址（默认 <http://127.0.0.1:5178>），点击右上角「扫码登录」：

1. 打开「铁路12306」App →「我的」；
2. 点右上角「扫一扫」，扫描页面上的二维码；
3. 在手机上确认登录，页面会自动加载积分概览和流水。

端口被占用时会自动顺延到 5179、5180……也可以手动指定：

```bash
PORT=8080 node server.js
```

## 功能说明

### 积分查询

- 默认区间是「今天往前 365 天」，与 12306 页面默认行为一致；
- 支持「积分明细 / 收入明细 / 支出明细」三个页签，对应接口的 `queryType=0/1/2`；
- 表格字段：日期、收入/支出、项目、积分有效期、备注；
- 点击任意一行展开乘车明细，再次点击收起（手风琴效果，同时只展开一条）。

### 导出

页面右上角「导出 CSV / 导出 JSON」：

- 导出范围 = 当前选择的开始/结束日期，不受当前分页限制；
- 勾选「导出含乘车明细」时，会先翻页拉取全部流水，再逐条请求明细；
- 右下角会显示进度（查询流水 → 抓取明细 → 生成文件），完成后自动下载；
- 文件保存在服务端的 `data/exports/`，7 天后自动清理。

CSV 为 UTF-8 with BOM，Excel 直接双击打开不会乱码。列包括：

```
日期, 收支, 积分, 项目, 积分有效期, 车票备注,
乘车人, 乘车日期, 车次, 出发站, 到达站, 区间, 席别, 车厢号, 订单号,
明细类型, 改签/升席积分差值, 手续费, 商户名称, 流水类型, 流水ID
```

如果一条流水对应多位乘车人，会展开成多行；没有明细的流水保留一行、明细列留空。

JSON 则保留完整结构：`range / user / summary / totals / records[]`，每条 `record` 下有 `details[]`，`details[].raw` 是接口原始字段，便于以后做二次处理。

## 纪念车票图片生成

使用已确认的 Rail Memory v2 底图，本地绘制字段并输出 PNG。蓝票、粉红票均保留底部纪念说明，顶部没有“纪念”大字，二维码区域留空。生成过程不联网、不调用图像 API，也不依赖积分查询服务。

> **模板升级进行中**：`feat/ticket-template-upgrade` 分支已拆出八款新版票面底图（蓝/蓝纸/蓝磁/蓝雕/蓝雕磁/红/红纸/红磁），并完成 TraceDot 4.1.8 的逆向分析与开发规范。设计、坐标、PDF 规则与分阶段任务见 [docs/README.md](docs/README.md)。当前 CLI 仍输出 `blue` / `pink` 两款，待 Python 渲染器完成 M5 后切换；Web 车票工坊为新增页面，不影响现有积分查询。

### 安装与运行

此功能需要 Python 3.9+ 和 Pillow；上面的积分查询服务仍然只需要 Node.js。首次安装：

```bash
python3 -m venv .venv-ticket
.venv-ticket/bin/python -m pip install -r requirements-ticket.txt
```

修改 `examples/ticket.json`，然后生成蓝、粉两款：

```bash
npm run ticket -- --data examples/ticket.json --style both --output output/tickets/my-trip.png
```

输出为 `output/tickets/my-trip-blue.png` 和 `output/tickets/my-trip-pink.png`。传入 `--style blue` 或 `--style pink` 时只输出指定的一张，使用原始文件名。图片默认宽度为 1800 像素，可用 `--width 2400` 调整；底纹来自固定栅格图，文字按输出分辨率绘制。同名输出会被替换。

也可以直接传字段，无须准备 JSON：

```bash
npm run ticket -- \
  --from 北京南 --to 天津 \
  --from-pinyin Beijingnan --to-pinyin Tianjin \
  --train C2021 --date 2014-08-28 --time 10:35 \
  --coach 01 --seat 02A --seat-type 二等座 \
  --price 57 --name 王某某 --gate 18 \
  --style blue --output output/tickets/beijing-tianjin.png
```

两种输入可混用，命令行参数优先，例如：

```bash
npm run ticket -- --data examples/ticket.json --name 李某某 --seat 05F --style pink
```

不使用 Node.js 时，可直接运行 `.venv-ticket/bin/python scripts/generate-ticket.py`，参数相同。`--data -` 从标准输入读取 JSON，`--help` 查看全部参数。`TICKET_PYTHON` 环境变量可为 npm 入口指定其他 Python 解释器。

Windows 安装命令为 `py -m venv .venv-ticket` 和 `.venv-ticket\Scripts\python.exe -m pip install -r requirements-ticket.txt`；npm 入口会自动选择对应虚拟环境。

### 从 12306 积分导出直接生成

积分查询页导出的 JSON（含 `records[].details[]`）或 CSV 都可以直接批量生成：

```bash
# 先试 5 张，确认效果
npm run ticket -- --points data/exports/12306-points_2025-10-18_2026-10-18.csv \
  --style blue --limit 5 --output-dir output/tickets/points

# 全部生成：每条乘车记录一张，both 同时出蓝/粉两张
npm run ticket -- --points data/exports/12306-points_2025-10-18_2026-10-18.csv \
  --style both --width 1800 --output-dir output/tickets/points
```

- `--points` 支持 `.json`（本项目的 JSON 导出）和 `.csv`（本项目/积分页导出的表格）。
- 一条乘车明细生成一张；同一订单多位乘车人会生成多张。
- `商户消费`、没有车次/日期/站名的流水会被跳过，并在终端提示。
- 文件名是 `日期_车次_出发-到达_序号[-blue|-pink].png`，同名会覆盖。
- 批量模式默认输出到 `output/tickets/points`，可用 `--output-dir` 改。
- `--style both` 会把 50 条生成 100 张、约 140MB（1800px）；建议先用 `--limit 5` 看效果。
- 订单号（`E…`）不会写进票面：票面底部的流水号是 21 位票号，不是订单号。

#### 积分明细能提供哪些票面字段

| 票面字段 | 积分明细 | 来源 / 说明 |
| --- | --- | --- |
| 出发站 / 到达站 | ✅ | `board_station_name` / `arrive_station_name` |
| 车次 | ✅ | `station_train_code` |
| 乘车日期 | ✅ | `train_date` |
| 车厢 | ✅ | `coach_no` |
| 席别 | ✅ | `seat_type_name` |
| 乘车人 | ✅ | `v_assignee_id_name` |
| 站点拼音 | ➖ | 积分接口没有；脚本用 `src/data/stations-pinyin.json` 按站名补 |
| 发车时间 | ❌ | 积分流水只有日期，没有时刻；票面留空，不猜 |
| 座位号 | ❌ | 只有车厢号，没有 02A 这类座位号 |
| 票价 | ❌ | 积分流水不含金额 |
| 检票口 / 票号 / 流水号 / 出票车站 / 渠道 | ❌ | 留空 |

所以默认生成的是「日期 + 车站 + 车次 + 车厢 + 席别 + 姓名」的纪念版，不会伪造时间、票价或票号。如果手上有原始车票/订单，可以只生成某一条并补字段：

```bash
npm run ticket -- --points data/exports/12306-points_2025-10-18_2026-10-18.csv \
  --index 18 --time 10:35 --seat 02A --price 513 --style blue
```

`--index` 是批量输入里的第 N 条（从 1 开始），补字段只对这一条生效；不指定 `--index` 时不允许逐字段覆盖。

### 字段

JSON 支持下列英文键，也支持表中对应的中文键。中英文同名字段不能重复出现。必填字段只有出发站、到达站、车次、日期；时间可选（积分导出没有时刻，留空时票面只显示日期）。其余字段省略时留空；不会自动填入模板里的假票号、票价或姓名。

> 注意：本项目 JSON 里 `details[].seat` 是**席别名称**（如“二等座”），适配器会把它填到票面的 `seat_type`，座位号留空；只有显式提供 `seat_type` 时，`seat` 才会被当作座位号（如 `02A`）。

| JSON 键 | 中文键 | 命令行参数 | 说明 |
| --- | --- | --- | --- |
| `from_station` | 出发站 | `--from` | 必填；可带末尾“站”，绘制时只显示一次 |
| `to_station` | 到达站 | `--to` | 必填；长站名自动缩放 |
| `train` | 车次 | `--train` | 必填，例如 C2021、G123 |
| `date` | 日期 | `--date` | 必填，YYYY-MM-DD，校验实际日期 |
| `time` | 时间 | `--time` | 可选，24 小时制 HH:MM；留空只显示日期 |
| `from_pinyin` | 出发站拼音 | `--from-pinyin` | 可选；手动模式未填留空，`--points` 模式用站名拼音表补 |
| `to_pinyin` | 到达站拼音 | `--to-pinyin` | 同上 |
| `coach` | 车厢 | `--coach` | 1～99，自动补齐两位 |
| `seat` | 座位 | `--seat` | 例如 02A、086、无座 |
| `seat_type` | 席别 | `--seat-type` | 例如 二等座、一等座、商务座 |
| `price` | 票价 | `--price` | 非负金额，最多两位小数，0 也可用 |
| `passenger_name` | 姓名 | `--name` | 可选 |
| `id_number` | 证件号 | `--id-number` | 默认自动脱敏；已有星号的值保持原样 |
| `gate` | 检票口 | `--gate` | 例如 18、A12/B12 |
| `ticket_number` | 票号 | `--ticket-number` | 左上红色编号 |
| `serial_number` | 流水号 | `--serial-number` | 底部流水号；含前导零时必须写 JSON 字符串 |
| `issuing_station` | 出票车站 | `--issuing-station` | 例如 北京南，自动补齐“站售”后缀 |
| `channel` | 购票渠道 | `--channel` | 例如 网；未填留空 |

需要按输入原样显示证件号时增加 `--show-id`。示例数据仅供排版演示，长站名示例 `examples/ticket-long-stations.json` 不代表实际列车路线或票价。

### 字体与素材

底图保存在 `assets/ticket-template/`，从已确认的模板提取。系统字体按站名、正文、拼音/车次、数字四类分别绘制，附属汉字缩小并对齐基线。macOS 默认使用华文黑体、宋体、Times New Roman、Arial Narrow；Windows/Linux 会尝试对应的中文、衬线和窄体字体。不同系统的字体外观可能略有差异，缺少字体时脚本会明确报错。

可使用 `--font-hei`、`--font-song`、`--font-latin`、`--font-number` 覆盖字体路径。TTC 字体集合可用 `文件.ttc#索引` 指定子字体，例如 `--font-song '/System/Library/Fonts/Supplemental/Songti.ttc#6'`。项目不分发系统字体文件。

离线自检覆盖输入校验、脱敏、两种票面、空白二维码、可选字段/时间留空、积分 JSON/CSV 适配和 CLI 批量输出：

```bash
npm run test:ticket
```

## 它是怎么工作的

### 1. 接口分析

积分页面 `https://cx.12306.cn/tlcx/jfinformation.html` 的前端逻辑在：

```
https://cx.12306.cn/tlcx/merged/jfinformation_js_v20011.js
```

从 bundle 里可以直接读到站点内部接口（`baseUrl = https://cx.12306.cn/tlcx/`）：

| 用途 | 方法 | 地址 | 主要参数 |
| --- | --- | --- | --- |
| 检查登录态 | POST | `login/checkLogin` | – |
| 退出登录 | POST | `login/loginOut` | – |
| 积分概览 | POST | `memberInfo/memberPointQuery` | `queryType=0` |
| 积分流水 | POST | `memberInfo/pointSimpleQuery` | `queryType`、`queryStartDate`、`queryEndDate`、`pageIndex`、`pageSize` |
| 流水明细 | POST | `memberInfo/PointDetailQuery` | `queryType=<trade_type>`、`trade_id=<trade_id>` |
| 扫码登录 | POST | `https://kyfw.12306.cn/passport/web/create-qr64` | `appid=otn` |
| 轮询扫码 | POST | `https://kyfw.12306.cn/passport/web/checkqr` | `appid=otn`、`uuid`、`RAIL_DEVICEID`、`RAIL_EXPIRATION` |
| 换取令牌 | POST | `https://kyfw.12306.cn/passport/web/auth/uamtk` | `uamtk`、`appid=member` |
| 建立积分站会话 | POST | `https://cx.12306.cn/tlcx/uamauthclient` | `tk=<newapptk>` |

几个字段约定（来自 bundle 的渲染逻辑）：

- `trade_flag = 2` 表示支出，否则为收入；收入取 `cumulate_point`，支出取 `consume_point`；
- `stop_date` 是积分有效期（`YYYYMMDD`），`train_date` + `train_code` 拼出「车票：2月21日 C1048次车」；
- 明细里的 `query_type`：`tg`=改签、`ts`=升席、`fc`/`fr`=商户消费，其余按普通乘车处理；
- 站点自己的站名/席别映射在 `js/framework/station_name_new.js` 和 `seatTypes` 变量里，本项目已转换为 `src/data/stations.json`、`src/data/seats.json`。

### 2. 扫码登录时序

```
浏览器（本项目）                12306
     │  POST create-qr64(appid=otn)  │
     │ ─────────────────────────────>│
     │ <──────── uuid + 二维码图片 ──│
     │                               │  用户用 App 扫码并确认
     │  POST checkqr(uuid)           │
     │ ─────────────────────────────>│
     │ <──── result_code=1 已扫码 ───│
     │  POST checkqr(uuid)           │
     │ ─────────────────────────────>│
     │ <──── result_code=2 + uamtk ──│
     │  POST auth/uamtk(uamtk,       │
     │       appid=member)           │
     │ ─────────────────────────────>│
     │ <──────── newapptk ───────────│
     │  POST cx/tlcx/uamauthclient   │
     │       (tk=newapptk)           │
     │ ─────────────────────────────>│
     │ <──── cx 的 JSESSIONID ───────│
     │  POST login/checkLogin        │
     │ ─────────────────────────────>│
     │ <──── flag=1, name, mobile ───│
```

`cx.12306.cn` 与 `kyfw.12306.cn` 的 Cookie 是分开的，本项目用一个按域名/路径隔离的 `CookieJar` 同时保存两份，所以 `uamtk`、`JSESSIONID`、`RAIL_DEVICEID` 都不会串。

### 3. 登录态持久化

- 登录成功后 Cookie 写入 `data/session.json`（权限 `600`）；
- 服务重启时加载该文件，并调用一次 `login/checkLogin` 验证；
- 页面刷新、服务重启、电脑重启（Cookie 未过期时）都不需要重新扫码；
- 退出登录会调用 `login/loginOut` 并删除本地会话文件。

## 自检

不需要登录、也不会访问 12306 的离线自检（字段归一化、mock 的扫码换票流程、CSV/JSON 生成）：

```bash
npm test
```

## 安全与隐私

- **只支持扫码**，代码里没有任何账号密码输入框，也不保存密码；
- `data/session.json` 等价于「已登录的 12306 会话」，请像密码一样保管，不要提交到 Git、不要发给别人；
- 服务默认只监听 `127.0.0.1`，局域网内其他设备访问不到；
- 所有 12306 请求都由本机 Node 进程直接发出，没有第三方中转、没有埋点；
- 导出的 CSV / JSON 里含姓名、手机号（脱敏）、车次行程，分享前请自行脱敏。

## 常见问题

**扫码后提示「登录已失效，请重新扫码」**
12306 的会话有时效，重新扫码即可；如果反复出现，先在浏览器里登录 [积分页面](https://cx.12306.cn/tlcx/jfinformation.html) 确认账号状态。

**提示「扫码已确认，但积分站点仍未建立登录态」**
通常是 12306 风控或临时抽风。等几十秒后刷新二维码重试；终端里会打印每一步的日志，可据此判断是 `uamtk` 还是 `uamauthclient` 失败。

**二维码一直不显示 / 生成失败**
检查本机能否访问 `kyfw.12306.cn`；公司网络、代理、VPN 有时会拦截。点击「刷新二维码」重试。

**查询结果为空**
先用 12306 官网页面同样的日期范围确认是否有记录；积分流水通常只保留最近一段时间，太久远的区间可能查不到。

**导出很慢**
导出会为每条流水单独请求一次明细，一年 100 条左右大约需要几秒到十几秒。进度面板会显示「正在抓取乘车明细（x/y）」。如果中途失败，已抓到的数据不会写文件，重新导出即可。

**提示「返回了 HTML 页面（可能被风控或需要重新登录）」**
12306 对频繁请求会返回验证页。稍后再试，或减少导出频率。

## 项目结构

```
train_ticket/
├── server.js                 # HTTP 服务 + 路由 + 导出任务
├── src/
│   ├── cookies.js            # 按域名/路径隔离的 CookieJar
│   ├── http.js               # fetch 封装：重定向、重试、超时、JSON 解析
│   ├── store.js              # data/session.json 读写（0600）
│   ├── rail.js               # 12306 接口客户端 + 字段归一化
│   ├── export.js             # 翻页、抓明细、CSV/JSON 生成
│   ├── ticket_image.py       # 纪念车票绘制（Pillow）
│   ├── points_ticket.py      # 积分 JSON/CSV -> 车票字段适配
│   └── data/
│       ├── stations.json     # 电报码 -> 站名
│       ├── stations-pinyin.json  # 站名 -> 拼音
│       └── seats.json        # 席别代码 -> 名称
├── assets/ticket-template/   # 纪念车票底图（blue.png / pink.png）
├── output/tickets/            # 生成的纪念车票（gitignored）
├── public/
│   ├── index.html            # 复刻的积分查询页面
│   ├── style.css
│   └── app.js                # 扫码弹窗、查询、展开、分页、导出
├── scripts/
│   ├── build-stations.mjs    # 重新生成站名/拼音表
│   ├── generate-ticket.py    # 单张/批量生成入口
│   ├── generate-ticket.mjs   # npm run ticket 入口
│   ├── test-ticket.py        # npm run test:ticket
│   └── smoke-test.mjs        # npm test 的离线自检
└── data/                     # 运行时生成：session.json、exports/
```

重新生成站名表/站名拼音表（12306 更新车站后）：

```bash
npm run build:stations
# 或指定本地文件
node scripts/build-stations.mjs /path/to/station_name_new.js
```

## 限制

- 非官方接口，12306 改版 / 加风控后可能失效；
- 只读取积分与积分对应的乘车记录，不涉及购票、改签、退票等写操作；
- 日期区间最长 2 年（本地限制），实际可查范围以 12306 为准；
- 本项目不提供任何绕过风控、验证码或登录保护的能力，登录必须由本人在 12306 App 上确认。
