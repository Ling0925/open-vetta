# 原生 Agent 产品能力收敛

## 目标与当前边界

Vetta 的原生 Agent Loop 是产品能力的主要实现位置。会话、输入队列、上下文预算、压缩、摘要、checkpoint、finalization 和恢复仍由现有 Runtime / Coding Agent 负责，不增加第二份计划或历史存储。

已有 Codex App Server 接入保留为兼容执行路径。本次不重解释旧的后端选择记录，不转换独立 Codex transcript，也不删除目前可用的模型配置或登录方式。把外部完整 Turn 包装成原生工具或 `StreamFn` 会形成嵌套循环，不能算原生能力融合。

原生已有工具、审批、流式事件、后台任务、计划模式、子任务、MCP / 插件和逐次模型调用 Context Plane。此次先收紧共享输入事务，并把完整计划原子更新加入原生工具。

## 能力矩阵

| 能力 | 原生现状 / 本次变化 | 事实源与后续边界 |
| --- | --- | --- |
| 模型与工具循环 | 已有原生单一循环；本次使用真实 Responses 编解码作离线全流程验证 | `packages/agent/src/engine/run-agent-turn.ts`；不嵌套外部 Turn |
| 上下文 / 压缩 / 摘要 | 已有统一 Context Plane，每次原生模型调用进入 checkpoint 与 finalizer | `packages/runtime-core/src/kernel/model-call-context.ts`；Codex 外部循环只能在 handoff 前进入一次 |
| 输入 / 接续 / 恢复 | 本次修复提交前出队、正文持久化窗口、成功终态后的未消费追问 | `packages/runtime-core/src/kernel/`；不承诺外部副作用 exactly-once |
| 执行计划 | 本次新增原子完整计划更新，沿用同一个 TodoRuntime | `packages/coding-agent/src/features/todo/`；场景锁与顺序不变 |
| 工具审批 / 停止 | 已有授权与二次取消检查；本次验证迟到批准不能触发写入 | Native `tool-executor` 与 Host 授权边界；不扩大权限 |
| 文本 / 参数 / 工具 / 用量流 | 原生已有；本次验证 HTTP/SSE delta、工具调用、终态和 usage | `packages/ai/src/providers/`、Native execution observations |
| 文件修改 | 本次为 write 补齐限量真实 diff，与 edit 复用展示；写入结果随原 ToolResult 保存 | 旧、新文本最多 64 KiB / 2048 行；未知原文不生成假 diff，无并发回滚保证 |
| 进程 / 交互终端 | 原生已有前台与后台 shell、输出制品和停止 | 持续 stdin / PTY 需要新窄 Port 和本地 / SSH 一致合同 |
| 子任务 / 计划模式 / 用户问答 | 已有原生产品 Feature | `packages/coding-agent/src/features/`，后续按真实流程验证而非复制 Codex UI |
| MCP / 插件 | 原生已有 generation 固定与权限边界 | 不启动第二套 MCP 生命周期或共享未知 OAuth 授权 |

### 后续实施顺序

0. 压缩提交失败边界：继续修复 / 验证 append 已完成但后续 document read 失败时的提交回执与恢复，避免把已提交压缩当成未提交；本次没有宣称覆盖该路径
1. 文件变更结果的下一阶段：统一多文件 review / patch，明确并发修改与回滚边界，不增加第二份历史
2. 交互命令：Runtime 管理 process handle、stdin / PTY、超时和关闭；覆盖本地与 SSH，复用既有授权策略
3. 产品入口：在上述能力与真实网关验收后，将后端选择逐步收敛为明确的兼容选项；保留旧记录读取和显式切换，不静默迁移
4. 标准 ChatGPT 登录：独立实现官方 Sign in with ChatGPT 客户端注册和专门用户授权，复用 Vault；不借用旧 token 或修改用户计费方式

## 完整计划更新

现有 `todo` 工具新增 `action="replace"`，一次提交整个执行计划：

```json
{
  "description": "更新实现进度",
  "action": "replace",
  "plan": [
    { "content": "核查现有实现", "status": "done" },
    { "content": "修复并补充回归测试", "status": "in_progress" },
    { "content": "运行质量检查", "status": "pending" }
  ]
}
```

- 与 `create`、`update`、`list`、`clear` 使用同一个 `CodingAgentTodoRuntime`、UI 观察事件和 `todo_snapshot`
- 先验证整个计划，再发布一次更新；不会出现清空后再创建的中间状态
- 保留描述未变的条目 ID；新增步骤取得新 ID，重复描述按原有出现顺序匹配
- 最多一个 `in_progress`，拒绝空白步骤；取消已生效时不修改计划
- 场景锁定的计划只能更新状态，不能增加、删除、改写或重排步骤，仍须按顺序完成
- 非锁定计划可提交空数组来清空；持久化格式没有变化，重新打开继续读取同一份计划

## 输入事务与接续

队列条目在准备阶段保留 reservation。只有当前输入身份、附加 context 和完整用户正文已经由 canonical repository 接收，才提交出队；准备失败、取消或明确落盘失败不会提前删除输入。

Native 在执行中消费的追加输入，同样将身份、context 和正文一起追加，避免“身份已落盘、正文尚未写入”的窗口。后续用户可见事件不会再次追加同一正文。

成功结束后仍有未消费 follow-up 时，由 Session 的统一队列调度接续下一轮。取消、失败和暂停不会自动续跑。此机制也覆盖不在内部消费队列的外部执行引擎，后端不再各自实现接续状态。

这仍不是对外部工具副作用的 exactly-once 保证。结果不确定时需按 durable input identity 对账，不自动重放文件修改或命令。

## 模型和认证

已配置的 `openai-responses` 模型可以直接经过原有 ModelRuntime、AuthStorage / Vault 和 `@vetta/ai` provider 进入 Native Loop，无需经过 Codex 子进程或新增凭据存储。

保留已有 `openai-codex-responses` 兼容实现，不将其中的私有 `backend-api` 路径宣传为新的官方公共 API 接入。本次不读取真实凭据、不注册 OAuth client、不扩大 scope，也不自动迁移登录。未来标准 Sign in with ChatGPT 接入应独立审查官方客户端注册、用户授权、token audience 和模型请求限制。

官方依据：[开源本地应用登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。这些文档说明标准路径，不代表现有 Codex token 已满足新的授权。付费或远程托管产品需另行核对官方申请条件。

## 文件审阅与安全停止

成功写入小型文本文件后，`write` 在 canonical ToolResult 中记录实际 UTF-8 字节数与写前观察得到的 diff。Desktop 在原工具卡片中复用 edit 的增删预览。执行中、失败或无法取得真实 diff 时，仍显示原内容预览与错误，不把请求内容当作已经发生的修改。

本地与 SSH 的预读端口都是可选且有界的；读取权限不足不能阻止原本允许的写入。未知原文、二进制、超限、未实现预读能力都会明确标记 diff 不可用。预览不是文件锁、原子 compare-and-swap 或撤销保证。

取消分为两个阶段：等待批准时可立即停止，迟到批准不会触发工具；工具副作用开始后，执行循环和 Runtime adapter 保留所有权，等待工具及 I/O 结束后才释放 Session。用户的 Stop 等待可以超时并返回，但此时 Session 仍处于 cancelling，不能启动新的冲突任务。写入成功后收到取消不代表内容已回滚。

## 尚未合并的能力

- Codex 式可持续 stdin / PTY 命令会话需要明确的 Runtime 进程生命周期端口；不能通过启动一个额外 Agent Loop 实现
- 文件变更 diff / review、权限请求和动态工具的展示及协议仍有差异
- 安全的工具并发需要先定义副作用与授权次序，不能直接把串行执行换成 `Promise.all`
- 外部 Codex 最终历史快照的完整性、缺失项与流式记录的逐项核对仍需独立加固
- 不声称覆盖所有 Codex 功能，也不声称离线 fixture 等同于真实模型、用户网关或跨平台 Electron 验收

## 验证入口

遵循根目录 `AGENTS.md` 和 `docs/dev/quality-gates.md`，使用 `test:impact` / `test:changed` 准备 workspace 构建产物，再通过官方 Vitest wrapper 执行。

- `packages/coding-agent/test/features/todo/`：原子更新、场景锁、持久化与恢复
- `packages/coding-agent/test/native-runtime-product-integration.test.ts`：真实 Native / Responses HTTP-SSE / 计划 / 文件工具 / 审批 / 流式 / 取消 / 新仓储实例恢复
- `packages/runtime-core/test/kernel/turn-pipeline.test.ts`：准备失败、取消及 durable admission
- `packages/runtime-node/test/codex-app-server/conversation-queue-integration.test.ts`：真实 Session / Pipeline 与 Codex 协议适配器的接续、取消和失败
- `packages/runtime-node/test/codex-app-server/conversation-turn-engine.test.ts`：Context Plane 克隆 / 文本归一化之后的当前用户请求定位
- `packages/agent/test/tool-effect-lifecycle-regression.test.ts` 与 `packages/runtime-core/test/kernel/native-tool-cancellation-fence.test.ts`：底层工具所有权、真实 Session 停止等待和新输入隔离
- `packages/runtime-node/test/coding-suite/write/write-change-result.test.ts` 与 edit 合同测试：真实 diff、UTF-8 计数、未知 / 非文本 / 超限、inflight I/O 取消
- `apps/desktop/src/renderer/domains/conversation/components/blocks/ToolCallBlock.write-diff.test.tsx`：原工具卡片展开、运行中到成功切换、失败与未知回退

完整 `bun run check` 仍是独立门禁；定向行为测试通过不能代替全仓质量检查。
