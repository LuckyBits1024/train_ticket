# 票面模板与渲染规范（Rail Memory v2）

> 适用：Web Canvas 渲染器（主）与 Python/Pillow CLI（副）。
> 目标：八款底图、统一坐标、跨渲染器一致、可回归。
> 资产：`assets/ticket-template/v2/`；机器可读元数据：`manifest.json`。

## 1. 资产清单

| key | 中文 | 画布 | 底图 | 家族 | 底图处理 | 默认导出宽 |
| --- | --- | --- | --- | --- | --- | --- |
| `blue` | 蓝色票 | 809×509 | 811×509 PNG | blue | 1:1 | 1618 |
| `blue-paper` | 蓝纸票 | 809×509 | 809×509 PNG | blue | 1:1 | 1618 |
| `blue-mag` | 蓝磁票 | 809×509 | 809×509 PNG | blue | 1:1 | 1618 |
| `blue-etch` | 蓝雕票 | 809×509 | 1255×772 WebP | blue | cover | 1618 |
| `blue-etch-mag` | 蓝雕磁票 | 809×509 | 1058×655 WebP | blue | cover | 1618 |
| `red` | 红色票 | 800×535 | 800×531 PNG | red | 1:1 | 1600 |
| `red-paper` | 红纸票 | 800×535 | 800×535 PNG | red | 1:1 | 1600 |
| `red-mag` | 红磁票 | 800×535 | 800×535 PNG | red | 1:1 | 1600 |

规则：

- 蓝家族逻辑画布 809×509，红家族 800×535；**所有坐标都写 1x 逻辑像素**。
- 导出时 `scale = outputWidth / logicalWidth`；默认 2x，允许 1x/2x/3x。底图原生分辨率只有 800–1255px，3x 不会增加细节，只用于排版放大。
- `cover`：`s = max(w/imgW, h/imgH)`，居中裁切；其余 `stretch` 到画布。
- 红家族先铺白底，再贴图（`red.png` 只有 531 高，底部 4px 留白）。

## 2. 坐标与偏移

### 2.1 家族偏移

| 家族 | dx | dy |
| --- | --- | --- |
| blue | 0 | 0 |
| red | 10 | 20 |

先算 `dy2 = dy + adjust.allDy`，再绘制。票号和检票口不使用 `allDy`。

### 2.2 基准坐标（未加家族偏移）

| 槽位 | x | y | 字号 | 对齐/说明 |
| --- | --- | --- | --- | --- |
| `ticketNo` | 45 | 50 | Arial 40，字距 4 | 左对齐，红色 `#ff0000` |
| `checkin` | 760 | 40 | Times 30 | 右对齐 |
| `startStation` | 60 | 105 | Times 50 + 站 32 | 左对齐；长站名公式见 §3 |
| `startPinyin` | 动态 | 145 | Times 30 | 居中 |
| `endStation` | 550 | 105 | Times 50 + 站 32 | 左对齐 |
| `endPinyin` | x+90 | 145 | Times 30 | 居中 |
| `trainNo` | 400 | 105 | Times 46 | 居中；箭头 `(x-55 → x+65, y+30)` |
| `datetime` | 40 | 190 | 数字 38 / 汉字 24 | 段间 5px |
| `carriageSeat` | 522 | 190 | 数字 40 / 汉字 24 | 段间 3px |
| `price` | 40 | 235 | 数字 36 / 元 24 | `￥` + 一位小数 |
| `flags` | 360 中心 | 235 | 24 | 每个 +40，圆圈 r=15 |
| `seatClass` | 620 | 235 | Times 30 | 居中 |
| `info1` | 40 | 270 | 24 | 左对齐 |
| `info2` | 40 | 305 | 24 | 左对齐 |
| `identity` | 40 | 345 | 35 | 左对齐 |
| `name` | 400 | 345 | 32 | 左对齐；禁区到二维码左缘 -8 |
| `dashBox` | 80 | 365 | 460×70 | 线宽 2，`[10,5]` |
| `info3.line1` | 300 | 385 | 24 | 居中 |
| `info3.line2` | 300 | 415 | 24 | 居中 |
| `machineId` | 40 | 蓝 475 / 红 485 | 27 | 已含家族 dy；再叠加 `machineDy` |
| `qr` | 蓝 600 / 红 600 | 蓝 300 / 红 360 | 128 / 136 | 蓝纸票 y=307 |

> `machineId` 的 475/485 已经包含 dy：蓝 `465+10`，红 `465+20`。不要再重复加 dy。

### 2.3 每款微调

| key | 参数 | 效果 |
| --- | --- | --- |
| `blue-paper` | `ticketNoDx=-5`, `ticketNoDy=-4`, `machineDy=-10` | 票号左/上微调，取票机号上移 |
| `blue-paper` | `checkinAlign=ticketNoBottom` | 检票口底端与票号底端对齐 |
| `blue-paper` | `qrBottomDash=true` | 二维码底边与虚线框底边对齐（y=307） |
| `blue-mag` | `machineDy=+12` | 取票机号下移 |
| `red` | `checkinAlign=endStationSuffix` | 检票口右缘对齐到达站“站”字右缘 |
| `red-paper` | 同 `red` | — |
| `red-mag` | `allDy=+14`, `checkinDy=+14`, `checkinAlign=endStationSuffix` | 内容整体下移，检票口再下移 |

### 2.4 绘制顺序

```text
底图 → 票号 → 检票口 → 始发站/拼音 → 到达站/拼音 → 车次/箭头
→ 日期时间 → 车厢座位 → 票价 → 优惠标志 → 席别
→ 附加信息 1/2 → 证件号 → 姓名 → 二维码 → 虚线框
→ 底部提示两行 → 取票机号
```

二维码最后画（避免被文字覆盖）；虚线框在姓名之后、底部提示之前（与 TraceDot 一致，允许框与二维码并列）。

## 3. 长文本与溢出

### 3.1 站名

```text
start:
  if len < 4:  宽度=160, 字号=50, 起点=x
  else:        起点=x-(len-3)*15, 宽度=170+(len-3)*20
  “站” x = x+165+(len>=4 ? (len-3)*33 : 0)

end:
  if len < 4:  宽度=160, 字号=50, 起点=x
  else:        起点=x-(len-3)*20, 宽度=170+(len-3)*20
  “站” x = x+165+(len>=4 ? (len-3)*25 : 0)
```

拼音：

```text
startPinyin.x = max(x+90, measure(startName)/2 + 100)
endPinyin.x   = x+90
两者 y = 站名 y + 40，居中
```

站名最多 6 个汉字；超过 6 个按 6 个处理并缩字号到 80%，再超则截断加省略号。

### 3.2 姓名

```text
zoneRight = qrX - 8
maxW = zoneRight - nameX
1) 一行放得下 → 一行
2) 否则枚举切分点，取“两行都不越界且宽度最接近”的切分
3) 两行仍越界 → 等比缩小字号（最低 20px）
4) 最后按 zoneRight 裁剪，绝不压二维码
```

### 3.3 通用规则

- 每个槽位有 `maxWidth`；超出时先按 `maxWidth / measure` 缩字号（最低 80%），仍超出则截断并加 `…`。
- 用户字号缩放 `fontScale` 在 80%–130%；布局坐标不变，只缩放字号。缩放后如果溢出，仍按上述规则兜底。
- 缺省值不绘制：时间为空不画“开”；票价为 0/空不画 `￥`；未勾选不画优惠圆圈。

## 4. 字体

### 4.1 字体栈

```css
/* UI */
font-family: "Nunito Sans", "PingFang SC", "HarmonyOS Sans SC", "Noto Sans SC",
             "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;

/* 票面 Latin/数字 */
"Times New Roman", "PingFang SC", "HarmonyOS Sans SC", "Noto Sans SC",
"Microsoft YaHei", serif;

/* 票号 */
Arial, "PingFang SC", "HarmonyOS Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
```

### 4.2 混排要求

- 浏览器 Canvas 设置完整字体栈即可自动逐字回退；
- Pillow 不会自动回退，必须实现 `draw_text_mixed()`：
  - ASCII 字母/数字/`￥`/`.`/`-`/`/` → Times New Roman（票号用 Arial）；
  - 中文、中文标点、`☆`、`站/年/月/日/车/号/元/开` → 系统中文字体；
  - 逐段测量、逐段绘制，段间不额外加空格；
  - 字距 `tracking` 只加在字符之间，不加在行尾。
- 中文优先 `PingFang SC`（macOS）→ `HarmonyOS Sans SC`（华为）→ `Noto Sans SC`（Linux/安卓）→ `Microsoft YaHei`（Windows）。
- 仓库不包含上述商业字体；Python 缺字体时必须报错并提示 `--font-cjk`。

### 4.3 字号缩放

`setFont(size) = weight + " " + round(size*fontScale) + "px " + family`。默认 `weight=500`、`fontScale=1.0`。票号/二维码/虚线框不参与字重，但票号参与字号缩放。

## 5. 二维码

| 家族 | x | y | size |
| --- | --- | --- | --- |
| blue | 600 | 300 | 128 |
| blue-paper | 600 | 307 | 128 |
| red | 600 | 360 | 136 |

- 内容默认 `https://www.12306.cn/`；为空且用户未手动清空时回退默认值。
- 纠错级别 L，margin 0，透明底，黑色模块。
- 绘制时关闭图像平滑（`imageSmoothingEnabled=false`），保证模块边缘锐利。
- 生成失败/未就绪时：导出必须等待最多 3 秒；超时则导出**不带二维码**并在 UI 提示，不能导出旧码/空白块。
- 二维码不参与字号/字重滑块。

## 6. 背面

### 6.1 画布

与正面同家族：蓝 809×509，红 800×535。导出时同 scale。

### 6.2 布局

```text
titleSize  = 40 * (w/809)
titleY     = h*0.072 + titleSize/2
termsSize  = 21 * (w/809)
left       = w*0.052
maxW       = w - left*2
indent     = termsSize*2
lineHeight = termsSize*1.62
startY     = titleY + titleSize*0.5 + h*0.032 + lineHeight/2
```

- 标题居中，默认 `报销凭证使用须知`，700，`#333333`；
- 条款左对齐，默认 21px/500/`#3c3c3c`，按 `maxW` 换行，首行悬挂缩进 `indent`；
- 支持标题/条款的字号（10–80）、字重（400–800）、颜色；
- 背景：`blue|blue-paper|blue-mag|red|red-paper|red-mag|solid|custom`；
- `custom` 图片按 cover 铺满；`solid` 用纯色；
- 遮罩：黑/白，alpha 0–1，画在背景之上、文字之下。

### 6.3 合并

```text
gap = 26
outW = max(front.w, back.w)
outH = front.h + gap + back.h
背景 #FFFEFB
front 居中 (x=(outW-front.w)/2, y=0)
back  居中 (x=(outW-back.w)/2, y=front.h+gap)
```

分开导出时文件名加 `-front` / `-back`；合并时加 `-front-back`。

## 7. 导出

| 项 | 规范 |
| --- | --- |
| 格式 | PNG（无损） |
| 默认宽度 | 蓝 1618 / 红 1600（2x） |
| 可选 | 1x / 2x / 3x；宽度上限 4800 |
| 色彩 | sRGB，不嵌入 ICC |
| 元数据 | `Description=纪念车票 · 不作乘车凭证`、`Software=Rail Memory v2`、`Template=<key>` |
| 文件名 | `{date}-{train}-{from}-{to}-{name}-{style}.png`，非法字符替换为 `_`，长度 ≤120 |
| 批量 | ZIP（store 即可），根目录平铺；重名追加 `-2` |
| 进度 | `已完成/总数`，可取消；失败项列出原因，不中断其他项 |

## 8. 参考图与回归

`assets/ticket-template/v2/reference/` 是 TraceDot 实际渲染的参考图（虚构数据）：

- 输入：北京南 / 天津西，G2884，2026-09-16 10:24，02车11F，二等座，￥381.0，李某某，110101********1234，检票口 12B，取票机号 北京南站 001；
- 八张分别对应八款；用于视觉走查，不作为运行时素材。

回归建议：

1. 固定上述输入，分别用 Web 与 Python 输出 2x PNG；
2. 与参考图缩放到同尺寸，计算：
   - 结构：文字 bounding box 中心/宽高偏差 ≤ 2px（1x 坐标）；
   - 像素：背景区域 MAE ≤ 1.5%；文字区域允许抗锯齿差异；
3. 额外用例：4 字站名、6 字站名、超长姓名、无时间、无票价、无座位、无二维码；
4. 每款至少 3 个用例，共 24 张 golden；任何一款回归失败都阻塞合并。

## 9. 已知取舍

- 底图原生分辨率有限，2x 是“清晰 + 不虚假放大”的平衡；3x 只用于排版展示。
- 参考图来自浏览器 Canvas，Pillow 的字体栅格化不可能 100% 一致；以**结构一致**为主，不追求逐像素相同。
- `red.png` 比画布矮 4px，底部白边是原素材的一部分，不要裁掉或拉伸。
- 蓝雕两款是 cover 裁切；改动画布比例会裁掉列车头/尾，必须保持 809×509。
