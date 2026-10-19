# 12306 会员积分 · 本地查询 / 导出

一个跑在自己电脑上的「12306 会员中心 · 积分查询」复刻页面：

- 用**铁路12306 App 扫码登录**，不接触账号密码；
- 登录态（Cookie）保存在本机，重启服务后自动恢复；
- 查询最近一年的积分流水，点击任意一条可展开**乘车明细**（乘车人、乘车日期、车次、区间、席别、车厢号、订单号）；
- 一键导出这一年（或任意区间）的**全部流水 + 全部乘车明细**为 CSV / JSON；

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
│   └── data/
│       ├── stations.json     # 电报码 -> 站名
│       └── seats.json        # 席别代码 -> 名称
├── public/
│   ├── index.html            # 复刻的积分查询页面
│   ├── style.css
│   └── app.js                # 扫码弹窗、查询、展开、分页、导出
├── scripts/
│   ├── build-stations.mjs    # 重新生成 stations.json
│   └── smoke-test.mjs        # npm test 的离线自检
└── data/                     # 运行时生成：session.json、exports/
```

重新生成站名表（12306 更新车站后）：

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
