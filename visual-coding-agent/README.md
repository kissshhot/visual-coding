# Visual Coding Agent

通过独立的 `visual-coding-plugins` MCP 服务读取和修改代码、启动浏览器、截图和验证交互。支持离线演示与真实多模态模型两种模式。

多模态模式已通过现有研究网关的 `deepseek-v4-flash` 实测：模型查看参考图与当前截图，指出标题过大、卡片裁切和按钮颜色错误，生成 CSS 修复，然后重新截图评审并验证真实点击。

## 安装

需要 Node.js 24+，两个项目目录位于同一父目录（本仓库已满足）：

```sh
cd ../visual-coding-plugins
npm ci
npm run build
npm run browser:install
cd ../visual-coding-agent
npm ci
npm run build
```

## 配置模型

将 `.env.example` 复制为 `.env`，配置支持图像输入和 function calling 的服务：

```dotenv
OPENAI_CHAT_ENDPOINT=https://your-provider.example/v1/chat/completions
OPENAI_MODEL=your-vision-model
OPENAI_API_KEY_FILE=/absolute/path/to/model-key.txt
```

也可使用 `OPENAI_API_KEY` 环境变量。可选的 `configs/chat-completions.example.json` 包含请求预算等参数，替换其中地址和模型后，通过 `VC_MODEL_CONFIG` 指定。密钥仅由 Agent 进程读取；`.env` 与运行目录被 Git 忽略。

当前适配器使用 Chat Completions。新环境需先配置服务和密钥，离线演示与自动测试不需要密钥。

## 运行

```sh
# 随机字符只出现在截图中，检验服务是否真的读取图像
npm run check:vision

# 自动生成参考图与带布局缺陷的草稿，运行真实模型修复
npm run demo:vision

# 从空目录生成页面，并执行视觉评审、必要修订与交互验证
npm start -- --adapter multimodal --task examples/card.json

# 无密钥的原始离线演示（依据 DOM 样式修订）
npm run demo
```

修改已有静态项目：

```sh
npm start -- --adapter multimodal --task /path/to/task.json --workspace /path/to/site
```

任务保留 `examples/card.json` 中的标题、正文、颜色、按钮文本和成功文本，可增加：

```json
{
  "instructions": "匹配参考图，保持双栏布局和按钮交互。",
  "reference_image": "reference.png",
  "editable_files": ["index.html", "styles.css", "app.js"]
}
```

这是补充字段示例；完整任务仍需基础字段。参考图路径相对任务 JSON，支持 PNG/JPEG，最多 10 MB。可编辑文件默认 `index.html`、`styles.css`；模型只能改列表中的文件。页面使用 `h1`、`#action`、`#status` 供当前验收器定位。离线模式仍要求空项目。

## 视觉反馈闭环

```text
读取项目 / 模型生成初稿 → 浏览器截图
→ 模型仅看图与任务，返回区域化问题清单
→ 模型结合问题、截图与源码生成修复 → MCP 修改代码
→ 新版本截图 → 模型复查
→ DOM 检查 → 点击 → 确认状态变化 → 最终截图及模型复查
→ 保存报告
```

视觉诊断请求不附带源码、DOM 或预设缺陷答案；修复请求才提供源码。所有源码修改和浏览器操作均经过 Plugins，模型 API 只返回结构化评审或文件内容。图像通过真实的 `image_url` 数据块传入服务。

截图图像块须与产物 SHA-256 匹配。评审绑定截图 ID、哈希与代码版本；每次修改后重新验证，即使代码回退到曾出现过的哈希也不能复用旧观察。最终评审通过且运行、DOM、点击后状态变化均通过，才能交付。`model_review_passed` 表示模型判断通过，不代表独立视觉评分或像素完全一致。

## 预算和失败

- CLI 默认最多 40 次策略决策；多模态运行最多 10 分钟，离线最多 90 秒。
- 默认最多 3 次修复、12 次 API 请求（含重试），单次请求最多 120 秒、输出 8192 tokens，最小请求间隔 3.2 秒。
- HTTP 429/5xx 和结构化结果无效时有界重试；401 等鉴权失败立即停止。网络或工具失败、预算耗尽均返回非零退出码。
- `--max-steps`、`--timeout-ms`、`--max-repairs` 可调整运行预算；模型预算在配置 JSON 中调整。
- `--model-config`、`--api-key-file` 可覆盖本地配置；`--browser-channel chrome` 可使用本机 Chrome；`--plugins-server` 可指定其他位置的编译后 MCP 服务。

## 产物

每次运行在 `runs/run-*/` 保存：

| 文件 | 内容 |
| --- | --- |
| `result.json` | 最终版本、截图路径、运行/DOM/交互/视觉结论 |
| `model-events.jsonl` | 调用阶段、响应 ID、模型名、用量、图像哈希、结构化输出或错误 |
| `visual-reviews.jsonl` | 每张被评审截图的问题清单及通过/修订判断 |
| `events.jsonl` | MCP 调用、参数和结果，不重复嵌入图像 Base64 |
| `reference.png` / `reference.jpg` | 实际送入模型的参考图副本（若有） |
| `failure.json` | 失败信息；已有轨迹与产物保留 |

源码位于 `--workspace` 或默认 `runs/run-*/site/`；Plugins 产物位于工作区 `.visual-coding/runs/<run-id>/`。`demo:vision` 的参考图、草稿和任务放在独立的 `runs/vision-fixture-*/`，避免覆盖用户项目。

## 5 个固定评测任务

```sh
npm run benchmark:validate  # 无模型校准：验证参考页、评分和交互检查
npm run benchmark          # 真实模型依次修复五个固定初稿
```

任务涵盖仪表盘、商品页、文章页、设置表单、价格方案页。参考与候选在初始状态和点击后状态分别比较，输出像素差异、MAE、区域边界、差异图，以及初稿/修订后的独立交互结果。二次点击、反向切换和第二个输入值也参与检查。

报告输出 HTML、JSON、Markdown、CSV；失败或未达标任务保留，任一任务未达标时 CLI 返回非零退出码。模型的视觉评审通过不自动等于固定阈值通过。[完整协议与任务](benchmarks/v1/README.md) · [本轮评测结果](docs/BENCHMARK_RESULTS.md)。

`visual_compare` 接收当前截图 ID 和参考 PNG，拒绝尺寸不一致、哈希不匹配与失效截图；有 PNG 参考图的多模态运行会自动调用它，将数值证据提供给模型。JPEG 仍支持语义评审，但不进入该 PNG 比较工具。`setup_actions` 可声明点击前填写输入框的操作。

## 模块与验证

`models/chat-completions.ts` 负责 API、图像输入、用量与重试；`models/multimodal.ts` 负责视觉评审和修订流程；`agent/runner.ts` 负责 MCP 执行、预算、证据约束与交付；`evaluation/` 负责当前任务的确定性检查。

```sh
npm run build
npm test
```

自动测试使用本地 HTTP 模型替身和真实 MCP/Chromium，不消耗 API 配额。真实模型能力由单独的 `check:vision`、`demo:vision` 验证。详见 [验收记录](docs/VALIDATION.md) 和 [开发计划](PLAN.md)。

当前范围为固定 1200×800 的单页 HTML/CSS/JS，已有像素差异指标和 5 个固定任务。响应式多视口、感知指标、框架构建及更广泛的交互任务仍待扩展。

接口依据 [OpenAI Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)；MCP 客户端依据 [TypeScript SDK 文档](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)。
