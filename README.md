# Visual Coding

让 Agent 根据页面截图发现问题、修改代码，并通过浏览器重新验证视觉效果与交互。当前原型面向受控的静态 HTML/CSS/JavaScript 页面。

一个仓库包含两个可独立运行的项目：**Agent 负责模型推理和修订策略，Plugins 通过 MCP 提供代码、浏览器与视觉比较工具**。

![Visual Coding 视觉反馈流程](docs/visual-feedback.png)

[编辑 draw.io 流程图](docs/visual-feedback.drawio) · [SVG 矢量版](docs/visual-feedback.svg) · [流程说明](docs/ARCHITECTURE.md)

## 已实现

- 离线闭环，以及兼容 Chat Completions 的多模态模型适配器。
- 截图诊断 → 定位问题 → 修改源码 → 重新截图与复查，带修复次数、请求数和时间预算。
- 8 个 MCP 工具：文件读取/修改、静态预览、截图、DOM 检查、点击/输入、产物保存和 PNG 差异比较。
- 截图、评审、代码版本和 SHA-256 绑定，拒绝过期观察和越界路径。
- 5 个固定评测任务，独立比较初稿与修订后的视觉效果和交互；输出 HTML、JSON、Markdown、CSV。

## 快速开始

需要 **Node.js 24+、npm**。在仓库根目录执行：

```sh
git clone https://github.com/kissshhot/visual-coding.git
cd visual-coding
npm run setup
npm run build
npm run browser:install
npm test
npm run demo
```

`demo` 不需要模型密钥，演示 Agent 通过独立 MCP 进程生成页面、修改样式、截图并验证点击。运行产物保存在 `visual-coding-agent/runs/`，不进入 Git。

## 接入多模态模型

复制 `visual-coding-agent/.env.example` 为同目录 `.env`，填入支持**图像输入和 function calling** 的模型及 Chat Completions 服务地址：

```dotenv
OPENAI_CHAT_ENDPOINT=https://your-provider.example/v1/chat/completions
OPENAI_MODEL=your-vision-model
OPENAI_API_KEY_FILE=/absolute/path/to/model-key.txt
```

密钥文件只保存密钥本身；也可以使用 `OPENAI_API_KEY` 环境变量。`.env`、密钥和原始运行目录不上传。可选配置模板位于 `visual-coding-agent/configs/chat-completions.example.json`，通过 `VC_MODEL_CONFIG` 指定；请先替换模型和地址。

```sh
npm run demo:vision       # 参考图、带缺陷初稿、模型修订与真实交互
npm run check:vision      # 随机字符图像输入检查
```

修改已有项目：

```sh
cd visual-coding-agent
npm start -- --adapter multimodal --task /path/to/task.json --workspace /path/to/site
```

任务格式见 [Agent README](visual-coding-agent/README.md) 和 [示例任务](visual-coding-agent/examples/card.json)。模型只可修改任务声明的文件；当前验收使用 `h1`、`#action`、`#status` 定位元素。

## 固定评测

```sh
npm run benchmark:validate  # 不调用模型，验证参考实现和评测链路
npm run benchmark          # 调用模型，依次修订 5 个固定初稿
```

固定 1200×800 视口，分别比较初始状态与首次点击后状态，并检查重复点击、反向切换或第二个输入值。每个状态须变化像素比例 ≤ 1%、RGB MAE ≤ 2，且功能检查通过。模型自评通过不会覆盖独立验收失败；任一任务未达标，评测命令返回非零退出码。

2026-10-14 的一次历史运行，请求模型 `deepseek-v4-flash`：

| 任务 | 初稿差异 → 修订后差异 | 修订后交互 | 固定验收 |
| --- | ---: | --- | --- |
| 仪表盘 | 28.63% → 5.14% | 通过 | 未达标 |
| 商品页 | 31.61% → 0.00% | 通过 | 通过 |
| 文章页 | 21.42% → 0.00% | 通过 | 通过 |
| 设置表单 | 11.68% → 0.00% | 通过 | 通过 |
| 价格方案 | 13.26% → 0.00% | 通过 | 通过 |

差异为两个状态的平均变化像素比例，整体 **21.32% → 1.03%**，交互 **1/5 → 5/5**，固定验收 **4/5**。这组受控任务的单次结果不代表一般网站成功率。详见 [评测协议](visual-coding-agent/benchmarks/v1/README.md) 与 [结果记录](visual-coding-agent/docs/BENCHMARK_RESULTS.md)。

## 目录

```text
visual-coding/
├── visual-coding-agent/       # 模型适配、Agent 循环、预算与评测
│   ├── src/
│   ├── tests/
│   └── benchmarks/v1/        # 5 个固定初稿、参考实现与交互检查
├── visual-coding-plugins/     # MCP 服务、Playwright、文件与差异工具
│   ├── src/
│   └── tests/
└── docs/                     # draw.io 源图、PNG/SVG 与流程说明
```

两项目保留独立的 `package.json` 和锁文件；根目录命令只负责串联安装、构建与运行。

## 工具与边界

| 工具 | 作用 |
| --- | --- |
| `project_read` / `project_patch` | 读取源码、按版本修改文件 |
| `project_run` | 启动本地静态预览 |
| `browser_capture` / `browser_inspect` | 截图、文本/样式/可见性及错误检查 |
| `browser_act` | 点击、填写输入 |
| `visual_compare` | PNG 差异比例、MAE、区域统计、差异图 |
| `artifact_save` | 保存绑定代码版本的报告与轨迹 |

[工具契约](visual-coding-plugins/docs/CONTRACT.md) · [Plugins 使用说明](visual-coding-plugins/README.md)

当前自动测试共 28 项，使用模型替身和真实 MCP/Chromium，不消耗模型配额。多视口、感知质量指标、React/Vite 等框架构建仍待扩展。当前文件边界与浏览器限制用于受控项目，不构成任意不可信程序的隔离环境。

[Agent 开发计划](visual-coding-agent/PLAN.md) · [Plugins 开发计划](visual-coding-plugins/PLAN.md)
