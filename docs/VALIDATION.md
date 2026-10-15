# 仓库整理验证

日期：2026-10-16。

在这个新仓库目录中，按根 README 的安装和运行方式完成：

- `npm run setup`：从两个项目的锁文件安装依赖。
- `npm run build`：Plugins 和 Agent 编译通过。
- `npm test`：Plugins 11 项、Agent 17 项，共 28 项通过。
- `npm run demo`：离线 Agent → MCP → Chromium → 修订 → 点击验证闭环通过。
- `npm run benchmark:validate`：5/5 参考校准通过，最终像素差异均为零，模型请求数为零。
- draw.io 31.4.5 成功导出 PNG/SVG，已检查流程图布局。
- 仓库内文档链接检查通过，上传清单不包含 `.env`、密钥、依赖、编译目录或原始运行记录。

本次没有重新调用付费模型；README 中的真实模型结果来自 2026-10-14 的历史运行，详见 [原结果记录](../visual-coding-agent/docs/BENCHMARK_RESULTS.md)。
