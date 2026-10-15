# Visual Coding Plugins

为 Visual Coding Agent 提供工具的独立 MCP 服务。当前支持本地静态 HTML/CSS/JS 项目，包含文件修改、预览、浏览器观察与交互、产物存储。

## 安装与启动

需要 Node.js 24+：

```sh
npm ci
npm run build
npm run browser:install
```

服务由 Agent 自动以子进程启动，也可以供其他 MCP 客户端启动：

```sh
node dist/mcp/stdio.js --root /absolute/existing/workspace
```

默认以无头模式使用 Playwright 的完整 Chromium，安装命令通过 `--no-shell` 仅下载所需浏览器。本机已有 Google Chrome 时，可省略下载，使用 `--browser-channel chrome`。每个运行使用独立浏览器上下文。

`stdout` 仅用于 MCP 协议。工具日志和错误不写入该通道。进程退出时关闭浏览器与本地预览服务。

## 工具

| MCP 名称 | 能力 |
| --- | --- |
| `project_read` | 读取文件；首次调用获取代码版本 |
| `project_patch` | 按预期版本替换 UTF-8 文件并记录修改 |
| `project_run` | 启动仅监听本机的静态 HTTP 预览 |
| `browser_capture` | 页面或元素截图，返回 PNG 图像块和产物信息 |
| `browser_inspect` | 获取元素文本、布局、计算样式和控制台错误 |
| `browser_act` | 点击、填写输入框，保留当前页面状态 |
| `artifact_save` | 保存与代码版本绑定的 JSON 报告或轨迹 |
| `visual_compare` | 对比参考 PNG 和当前截图，返回差异图、区域边界、像素比例和 MAE |

工具采用下划线命名，与计划中的 `project.read` 等逻辑操作对应。具体请求和响应见 [工具契约](docs/CONTRACT.md)。

## 实现范围

- 工具仅访问 `--root` 内的项目，拒绝路径穿越、隐藏路径、`node_modules` 和符号链接。
- 当前 `project_run` 启动内置静态服务器；应用框架构建和任意 shell 执行尚未接入。
- 页面固定为 1200×800、UTC、浅色模式；加载字体后截图，并禁用截图时的动画。
- 浏览器请求限制在当前本地预览源，静态演示使用本地资源。当前能力用于受控项目，不作为运行任意不可信程序的安全沙箱。
- 页面状态按运行和代码版本隔离。代码变化后创建新页面，避免把旧页面观察当成新代码结果。
- 项目当前限制 200 个文件、20 MB；一次修改最多 16 个文件，每个文件最多 1 MB。
- 同一服务进程内串行执行工具；跨进程写入依靠内容版本检测，不提供分布式锁。

## 结构

```text
src/
├── core/        # 工具 schema、结果契约、执行调度
├── project/     # 受限文件操作、版本计算、静态预览
├── browser/     # Playwright 会话与页面观察
├── artifacts/   # 产物、哈希与版本关联
├── visual/      # PNG 像素差异与区域指标
└── mcp/         # MCP 注册与 stdio 入口
```

同级 Agent 已使用 MCP 工具跑通真实多模态反馈：browser_capture 的 PNG 图像块进入模型，模型给出诊断并生成代码修改，project_patch 应用后重新截图和交互验证。模型配置与密钥只由 Agent 管理，Plugins 不调用模型。

视觉差异比较现已接入多模态 Agent 和 5 个固定任务的评测。后续扩展多视口、感知指标、框架启动器及更多浏览器工具。新增工具应复用统一结果契约，业务规划和质量决策保留在 Agent。

## 验证

```sh
npm run build
npm test
```

本仓库测试文件边界、版本冲突、修改前校验、产物存储与预览生命周期。真实浏览器和跨进程 MCP 联调由同级 Agent 的集成测试覆盖，见 [验收记录](docs/VALIDATION.md)。

实现参考 [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server) 和 [Playwright 浏览器 API](https://playwright.dev/docs/api/class-browsertype)。依赖版本由 `package-lock.json` 固定。
