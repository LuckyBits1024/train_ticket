# 来源、权利与使用限制

## 素材来源

- 来源应用：**迹点点 TraceDot 4.1.8（arm64）**，`TraceDot-4.1.8-arm64.dmg`。
- 容器：`迹点点.app/Contents/Resources/app.asar`（SHA-256 `878ecded…75c12`）。
- 页面：`app/index.html`（SHA-256 `50e3dc11…28bcb0`），单文件应用，八张底图以
  `<img id="blueImg" …>` 等内联 `data:image/...;base64` 形式存在。
- 提取方式：REA 6.5.0 静态 JavaScript/Electron 分析 + base64 解码；未修改像素，
  仅重命名、转码（JPEG/PNG/WebP）并生成缩略图/参考图。
- 原始元素 ID：`blueImg`、`bluePaperImg`、`blueMagImg`、`blueEtchImg`、
  `blueEtchMagImg`、`redImg`、`redPaperImg`、`redMagImg`。

## 权利说明

- TraceDot 的**代码**在其仓库中标注为 MIT；**票面底图**是 12306 纸质车票的扫描/再创作，
  其权利可能属于原设计者、扫描者或中国国家铁路集团。本项目不声称拥有这些底图的版权。
- 这些底图仅用于**个人纪念、手账与前端技术演示**。严禁用于报销、退票、逃票、诈骗、
  伪造证件或其他违法用途；生成的图片不是真实铁路报销凭证。
- 若权利人认为本仓库的使用方式不当，请联系维护者删除；生产/商业使用前请自行取得授权，
  或替换为自行绘制/拍摄的底图。

## 字体

- 仓库**不包含**任何商业字体文件。
- 推荐 UI 字体：Nunito Sans（SIL OFL，可自托管）、PingFang SC、HarmonyOS Sans SC、
  Noto Sans SC、Microsoft YaHei。
- 票面字体：Times New Roman / Arial（系统字体）+ 中文系统字体回退。没有这些字体时，
  渲染器必须给出可操作的替代方案，而不是静默使用错误字体。

## 隐私

- 素材与渲染全部在本地完成，不包含用户数据，不发起网络请求。
- 参考图中的姓名、证件号、票号均为虚构示例。
