# @vetta/runtime-node

Vetta Runtime 协议的共享 Node.js 实现层。

本包拥有文件系统、进程、锁、本地持久化及 Node Coding Tool 的具体行为，可由 Desktop、CLI
和服务端 Node Host 复用。产品或平台 Composition Root 负责选择和配置适配器；协议包不包含 Node I/O。

主要入口：

- `@vetta/runtime-node/conversation`：文件/内存 Repository、租约、原子发布、会话服务与 Legacy 迁移
- `@vetta/runtime-node/coding`：具体 Coding Tool、Schema、模型描述、文件/命令/PDF/OCR 实现与 Node Host 原语
- `@vetta/runtime-node/mcp`：文件配置与凭证、stdio/HTTP Client、MCP SDK/OAuth 和 Device Flow 实现
- `@vetta/runtime-node/host`：资源、Knowledge、结果制品与通用文本文件等 Node Host 适配器
- `@vetta/runtime-node/codex-app-server`：Codex 独占进程/协议适配器、独立历史兼容 Backend，以及原会话中的完整 Turn 兼容执行入口；见 [原会话接入](../../docs/runtime/chat-runtime-switch.md) 和 [原生产品能力收敛](../../docs/runtime/native-agent-product.md)

`runtime-node` 不拥有 Agent Turn/Session Kernel，也不拥有 Electron IPC、Desktop 生命周期、UI 或产品策略。
平台无关编排属于 `runtime-core`，Desktop 生命周期和平台装配属于 `runtime-desktop`。当前
`coding-agent` 的 Node 宿主显式选择本包实现；非 Node 宿主不得依赖本包。

## 文件写入结果

`write` 成功后在原有 ToolResult 的 `details` 中保存 `WriteToolDetails`：实际 UTF-8 字节数、
变更类型，以及可用时与 `edit` 相同格式的 `diff` / `firstChangedLine`。这些结果跟随原 Conversation
保存，不另外维护文件变更历史。`diffBasis: "pre-write-read"` 表示写入前观察到的内容快照，不提供
跨进程并发修改检测或回滚保证。

`WriteOperations.readForDiff` 是可选的限量读取端口，宿主应至多返回 `maxBytes + 1` 字节。
明确不存在时返回 `missing`；读取失败不能当作空文件。默认本地实现和 SSH 实现均限制预读大小。
旧、新文本各最多 64 KiB / 2048 行，diff 最多 128 KiB；超过限制、内容非文本、无法读取或旧宿主未
提供该端口时，结果明确标记 `diffStatus: "unavailable"`，不凭空生成 diff，也不阻止原本允许的写入。
SSH shell 路径无法可靠区分缺失与读取权限失败时同样报告未知；仅结构化 ENOENT 可作为明确缺失。

取消会阻止尚未派发的文件写入。已派发的 `write` 和 exact-text `edit` 等待底层写入结束后才返回
取消结果，不能据此声称已回滚文件。受路径策略拒绝的 `write` 返回错误结果，且不尝试预读或写入。
