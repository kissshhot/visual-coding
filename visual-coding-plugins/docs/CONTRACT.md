# 工具契约 0.1.0

契约定义在 `src/core/contract.ts`。Agent 通过 MCP 发现工具 schema，并校验结果的 `contract_version`；两个项目没有源码导入或 npm 本地依赖关系。

## 请求

每次工具调用使用相同的上下文：

```json
{
  "workspace": "/absolute/site",
  "run_id": "demo-001",
  "revision": null,
  "params": { "path": "index.html" }
}
```

只有 `project_read` 允许 `revision: null`，用于获取当前代码版本。之后调用必须携带最近返回的版本；版本是项目可见文件内容与路径的 SHA-256，排除 `.visual-coding`、其他隐藏文件和 `node_modules`。所有工具都校验版本，外部改动会返回 `REVISION_CONFLICT`。

`project_patch` 的 `params.files` 为 `{ "path": "styles.css", "content": "..." }` 数组。当前操作是完整文件替换，返回新的版本及修改记录。版本检查是乐观并发控制；服务进程外的写入需要调用方协调。

## 响应

```json
{
  "contract_version": "0.1.0",
  "ok": true,
  "run_id": "demo-001",
  "revision": "<64-character SHA-256>",
  "data": {},
  "artifacts": [],
  "error": null,
  "duration_ms": 12
}
```

结果同时放在 MCP 的 `structuredContent` 和文本块中；截图调用另含 `image/png` 图像块。`artifacts` 包含 `id`、本机绝对 `path`、`mime_type`、`sha256`、`revision`，文件写入 `workspace/.visual-coding/runs/<run_id>/`，采用唯一名称。

业务失败返回 `ok: false` 和 `{code, message}`，同时设置 MCP `isError`。MCP SDK 在进入处理器前拒绝的非法 schema 参数可能仅有标准 MCP 错误内容，客户端应将其视为调用失败。失败结果不得作为交付证据。

## 生命周期与复现

- `project_run` 的 URL 仅在当前服务进程存活期间有效。
- 同一运行、同一版本的浏览器操作复用页面；代码版本改变后重建页面。
- 截图固定视口和环境，并记录使用的浏览器通道。页面有异步应用逻辑时，应先通过显式观察确认就绪。
- 交付前应完成当前版本的截图和任务检查；仅能运行不代表视觉质量通过。
- 调用方负责总预算、失败处理和结束时关闭连接。

0.1.0 提供本地 stdio 和静态项目能力。远程传输、感知质量评分、应用框架构建与更广泛的隔离机制属于后续版本。

## visual_compare（增量工具，结果信封仍为 0.1.0）

先调用 `browser_capture`，取得本次连接内、当前工作区与运行的截图 ID，再比较：

```json
{
  "workspace": "/absolute/site",
  "run_id": "demo-001",
  "revision": "<current code SHA-256>",
  "params": {
    "candidate_id": "<browser_capture artifact UUID>",
    "reference": {
      "data_base64": "<canonical PNG Base64>",
      "sha256": "<reference PNG SHA-256>"
    },
    "threshold": 8,
    "regions": [{ "name": "main", "x": 0, "y": 100, "width": 1200, "height": 650 }]
  }
}
```

输入尺寸必须相同；工具不缩放、不对齐、不自动裁剪。参考图最多 10 MB，单图最多 400 万像素、单边最多 8192；最多 16 个完全位于图内的区域。候选图只接受服务自己生成的截图 ID，不接受任意文件路径；每次源码修改后失效。连接关闭后失效，服务最多保留最近 32 张截图用于比较。

`data` 返回：

- `metric_version: rgb-white-v1`、`width`、`height`、`threshold`。
- `total_pixels`、`changed_pixels`、`changed_ratio`、`mae`、`changed_bounds`。
- `regions`：各区域坐标、像素统计与变化边界，坐标均为整图 PNG 像素坐标。
- `reference_sha256`、`candidate`：参考图哈希及候选截图完整产物信息。

算法将 RGBA 合成到白底，比较 8-bit RGB。某像素任一通道绝对差 **大于** threshold 时计为变化；MAE 是全部像素三个通道绝对差的平均值，范围 0–255。无变化时 `changed_bounds=null`。不做 gamma 修正、抗锯齿过滤或感知相似性建模，像素差异不等同于视觉质量。

返回一个 MCP PNG 图像块，及两个持久产物：`diff.png` 和 `comparison.json`。差异图以洋红色标注变化像素，未变化区域为淡灰背景。它们绑定当前代码版本；比较数据同时记录两张源图的证据。

额外错误：`UNKNOWN_SCREENSHOT`、`IMAGE_HASH_MISMATCH`、`INVALID_IMAGE`、`IMAGE_TOO_LARGE`、`IMAGE_SIZE_MISMATCH`、`INVALID_REGION`。这些错误不应被当作零差异或评测通过。
