# 视觉反馈闭环验收记录

日期：2026-10-14。

最新阶段已补齐视觉差异工具和 5 个固定评测任务，共 28 项自动测试通过；实际结果见 [固定任务评测](BENCHMARK_RESULTS.md)。以下保留此前多模态接入阶段的验收记录。

## 自动验证

- Agent 编译通过，14 项测试通过。
- Plugins 编译通过，6 项测试通过；两个仓库共 20 项测试。
- 原有离线闭环、已有文件保护、步骤与时间预算保持通过。
- 新增真实 HTTP 协议模型替身 + MCP 子进程 + Chromium 的视觉闭环集成测试，核对请求中的真实 PNG、截图哈希、诊断/修复分离、版本更新和最终评审。
- 验证临时 HTTP 错误及无效输出的有界重试、401 不重试、请求取消、修复预算终止、无视觉评审不能交付、旧截图不能授权交付、回退到旧哈希仍须重新观察。
- 交互验收要求点击前后状态变化，拒绝预填成功文本的无效按钮。

自动测试使用本地模型替身，不用于声称真实模型能力；以下为独立的实际 API 调用。

## 真实模型图像读取

`runs/vision-smoke-ae9ac124/result.json`：浏览器渲染随机六字符，文字提示不包含答案。模型从 PNG 正确读出 `Z652FX`，结果通过。请求模型为 `deepseek-v4-flash`，网关响应名称为 `deepseek-flash`。

## 真实视觉修复

最终代码复测：`runs/run-47b470b5/result.json`。工作区：`runs/vision-fixture-96d52367/site/`。

1. 固定草稿包含标题过大、右卡片移出视口、按钮颜色错误。
2. 模型仅收到任务、参考 PNG 和当前 PNG，给出三个区域的可见问题；该诊断请求没有源码或 DOM。
3. 独立修复请求提供源码及上述问题，模型生成 CSS 修改，经 MCP 写入。
4. 修订后重新截图，模型评审通过。
5. 实际点击后，状态从 `Ready for interaction` 变为 `Interaction verified — the loop is complete.`，再截图并通过模型复查。

共 4 次模型请求：视觉诊断、修复、修订后评审、交互后评审；1 次代码修复，3 张页面截图，10 次业务工具调用，另有 2 次报告保存。

运行结果：`runtime=passed`、`specified_dom_checks=passed`、`interaction=passed`、`visual_quality=model_review_passed`；无浏览器错误。初稿与最终截图已目视检查。

首轮联调 `runs/run-d259e689/result.json` 也成功，保留了首次 HTTP 429 后有界重试成功的实际记录。`runs/` 由 Git 忽略，以上是本机产物。

## 从空项目生成

`runs/run-bb35673b/result.json`：真实模型生成初稿后完成必要修订、截图复查和点击前后状态变化验证，最终全部通过；5 次模型请求。该路径也使用现有网关，未调用离线模板生成候选页面。

## 复现

配置 `.env` 引用已有密钥后：

```sh
npm --prefix ../visual-coding-plugins run build
npm run build
npm test
npm run check:vision
npm run demo:vision
```

`model-events.jsonl` 记录模型请求编号、阶段、响应 ID、服务返回用量、输入图像哈希与结构化输出；`visual-reviews.jsonl` 记录截图与代码版本绑定的评审结果。它们不保存密钥或重复的图像 Base64。

## 结论边界

已经证明真实模型能够读取截图、诊断这个受控页面的可见问题、生成修复并复查。视觉结论来自同一模型的评审，尚不是独立质量评分。当前任务使用固定视口、已知 DOM 定位约定和简单按钮交互；计划中的 5 个研究评测任务、多视口和独立视觉差异工具尚未完成。20 项自动测试属于工程验证，不是 20 个研究任务。
