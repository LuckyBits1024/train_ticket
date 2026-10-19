# 车票模板升级 · 分析与开发文档

本目录是 `feat/ticket-template-upgrade` 分支的交付文档，面向接手开发的 agent。

## 先读哪一篇

| 文档 | 内容 | 读者 |
| --- | --- | --- |
| [trace-dot-analysis.md](trace-dot-analysis.md) | 用 REA 对 TraceDot 4.1.8 的完整拆解：架构、模块、票面绘制、PDF 规则、设计语言、优缺点 | 所有人 |
| [current-project-analysis.md](current-project-analysis.md) | 当前 `train_ticket` 的结构、能力、差距与约束 | 所有人 |
| [ticket-template-spec.md](ticket-template-spec.md) | 八款模板、坐标、字体、排版微调、导出与验收标准 | 前端 / Python 渲染 |
| [design-system.md](design-system.md) | 「铁路信号台」设计令牌、图标、布局、组件、响应式与性能 | 前端 / UI |
| [pdf-import-spec.md](pdf-import-spec.md) | 12306 行程单 / 电子发票解析、填充优先级、二维码兜底、测试样例 | 前端 / 解析 |
| [development-plan.md](development-plan.md) | 目标结构、分阶段任务、接口、数据模型、测试与完成定义 | 开发 agent / 验收 |

## 交付物

- `assets/ticket-template/v2/`：八张已去字的正面底图、缩略图、参考渲染、`manifest.json`、来源与权利说明。
- `assets/design/`：30 个 24 网格线性图标（`icons.svg`）、设计令牌（`tokens.css`）、三张参考截图。
- `docs/`：本目录。

## 一句话结论

TraceDot 最值得复用的是**八款真实票面底图 + 基于 809×509 逻辑画布的排版参数 + PDF 回填规则 + 背面编辑器**；最不值得复刻的是**13.5 MB 单 HTML、iframe 注入、无构建/无类型检查**。本项目应保留 Node 零依赖 + Python/Pillow 的轻量结构，新增一个模块化的 Web 车票工坊，并让 Python CLI 与 Web 共用同一份模板清单。

## 重要限制

- 底图来自第三方应用，权利状态见 `assets/ticket-template/v2/NOTICE.md`。仅限个人纪念用途；不得用于报销、乘车或伪造。
- 本文档中的姓名、证件号、票号、二维码均为虚构示例。
- TraceDot 的实际版本号存在漂移：安装包/页面写 4.1.8，票面模块源码头写 V6.3.0，官网更新日志写到 V4.9.3。本文以**实际二进制内容**为准，版本号只作引用。

## 实现状态

- Web 车票工坊（M1–M4）已在本分支实现：`public/ticket.html`、`public/js/ticket/*`、`/api/ticket/*`、`/assets/*`；
- 前端纯函数测试：`npm run test:web`（23 个用例）；Python 测试：`.venv-ticket/bin/python scripts/test-ticket.py`（16 个用例）；
- Python CLI 的八款 parity（M5）已完成：`--style all`、`--scale`、`--back`、`--back-split`，旧的 `blue/pink/both` 命令保持兼容。
- 实现截图见 `assets/design/screenshots/ticket-studio-implementation-*.webp`。
