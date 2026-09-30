# 原生 Agent 产品能力收敛

## 目标与当前边界

Vetta 的原生 Agent Loop 是产品能力的主要实现位置。会话、输入队列、上下文预算、压缩、摘要、checkpoint、finalization 和恢复仍由现有 Runtime / Coding Agent 负责，不增加第二份计划或历史存储。

已有 Codex App Server 接入保留为兼容执行路径。本次不重解释旧的后端选择记录，不转换独立 Codex transcript，也不删除目前可用的模型配置或登录方式。把外部完整 Turn 包装成原生工具或 `StreamFn` 会形成嵌套循环，不能算原生能力融合。

原生已有工具、审批、流式事件、后台任务、计划模式、子任务、MCP / 插件和逐次模型调用 Context Plane。第一批收紧共享输入事务，并把完整计划原子更新加入原生工具。第二批继续修复压缩提交回执，并为本地原生命令增加可持续 stdin pipe（Linux / macOS；本轮在 Linux 验证）。

## 能力矩阵

| 能力 | 原生现状 / 本次变化 | 事实源与后续边界 |
| --- | --- | --- |
| 模型与工具循环 | 已有原生单一循环；本次使用真实 Responses 编解码作离线全流程验证 | `packages/agent/src/engine/run-agent-turn.ts`；不嵌套外部 Turn |
| 上下文 / 压缩 / 摘要 | 已有统一 Context Plane；第二批区分压缩已持久化与后置视图刷新失败 | `packages/runtime-core/src/kernel/model-call-context.ts`；Codex 外部循环只能在 handoff 前进入一次 |
| 输入 / 接续 / 恢复 | 本次修复提交前出队、正文持久化窗口、成功终态后的未消费追问 | `packages/runtime-core/src/kernel/`；不承诺外部副作用 exactly-once |
| 执行计划 | 本次新增原子完整计划更新，沿用同一个 TodoRuntime | `packages/coding-agent/src/features/todo/`；场景锁与顺序不变 |
| 工具审批 / 停止 | 已有授权与二次取消检查；本次验证迟到批准不能触发写入 | Native `tool-executor` 与 Host 授权边界；不扩大权限 |
| 文本 / 参数 / 工具 / 用量流 | 原生已有；本次验证 HTTP/SSE delta、工具调用、终态和 usage | `packages/ai/src/providers/`、Native execution observations |
| 文件修改 | 本次为 write 补齐限量真实 diff，与 edit 复用展示；写入结果随原 ToolResult 保存 | 旧、新文本最多 64 KiB / 2048 行；未知原文不生成假 diff，无并发回滚保证 |
| 进程 / 交互终端 | 原有前台 / 后台 shell；第二批增加本地 `interactive` pipe 与 `task_input`，复用同一个进程 owner | pipe 不是 PTY；Windows / SSH / sandbox 暂不支持，明确拒绝，不降级到非沙箱执行 |
| 子任务 / 计划模式 / 用户问答 | 已有原生产品 Feature | `packages/coding-agent/src/features/`，后续按真实流程验证而非复制 Codex UI |
| MCP / 插件 | 原生已有 generation 固定与权限边界 | 不启动第二套 MCP 生命周期或共享未知 OAuth 授权 |

### 后续实施顺序

0. 压缩提交回执：第二批处理 append 成功、后续可选 document read 失败；后置 hook 与 continuation 各自仍可失败，不承诺跨全部副作用的原子事务
1. 文件变更结果的下一阶段：统一多文件 review / patch，明确并发修改与回滚边界，不增加第二份历史
2. 交互命令下一阶段：在本地 pipe 基础上，独立设计真正 PTY、SSH helper stdin、sandbox 内进程与继续输入授权；覆盖跨平台进程树与断线清理
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

取消分为两个阶段：等待批准时可立即停止，迟到批准不会触发工具；工具副作用开始后，执行循环和 Runtime adapter 保留对工具 Promise 的所有权；本批文件写入 / 精确编辑及本地交互进程端口进一步等待实际 I/O 或进程结束，再释放本轮执行。用户的 Stop 等待可以超时并返回，但此时 Session 仍处于 cancelling，不能启动新的冲突任务。写入成功后收到取消不代表内容已回滚。

## 本地交互命令：所有权与权限边界

Linux / macOS 原生 `bash` 可用 `interactive: true` 启动持续接收 stdin 的本地命令，立即返回已有后台任务格式的 task ID。模型在当前会话的后续工具调用或后续 Turn 用 `task_input` 写入内容、发送 EOF；输出与终止继续使用 `task_output` / `task_stop`。不新增第二套 Agent Loop、进程表或输出历史。

工具调用示例（`task_id` 必须使用同一会话刚返回的实际值）：

```json
{ "command": "python interactive_script.py", "interactive": true, "timeout": 120 }
```

```json
{ "task_id": "<returned-task-id>", "input": "answer\n", "close_stdin": true, "wait_ms": 1000 }
```

`timeout` 是正数秒数的进程硬截止，未提供时命令可持续至主动停止或 Session 关闭；`wait_ms` 仅限制本次等候结果的时间，不会因为等待时间到达就杀死进程。硬超时触发终止请求，回执仍须等待真实清理；它不是“到了该秒数就可安全释放 Session”的保证。

这是字节流 pipe，不提供 TTY、终端尺寸、光标 UI 或控制键的终端语义。程序若要求真正终端，不能假定它可正常工作。Windows、SSH 与 sandbox 不具备该端口时必须明确拒绝请求，不转向本机或 full-access 重试。

威胁模型与不变量：

- 进程属于创建它的 Session 环境；task ID 是不透明句柄，不是跨会话能力凭证。旧历史中的 ID 不得误指向另一个新进程
- `task_input` 是独立、有副作用的工具。每次输入都进入现有 ToolPolicy；启动命令被允许不等于后续 stdin 自动允许。既有 full-access 策略仍可允许，受限策略可拒绝
- 等待审批时取消不写入；已经开始写入或终止时保留进程所有权，直到端口确认完成。停止不代表撤销进程已经产生的副作用
- 一次成功写入仅表示内容已交给 stdin，不表示目标程序已经处理，更不表示业务命令成功；输入不确定时不自动重放
- EOF 与停止需要幂等；关闭 stdin 后拒绝新内容；并发输入必须有序且有界，防止无限缓冲
- Session 关闭等待进程清理；恢复只恢复工具历史，不重启旧进程。切换执行模式或撤销工具不得通过旧工具绑定继续输入
- 输入与缓冲有界，写入背压有超时；调用者可指定进程硬超时。低层明确记录硬超时 / 输出上限；关闭等待真实结算，未确认前不宣布释放

验证覆盖真实 Node 子进程和 Native / Responses 双 Turn 流程；并不等同于真实模型、Windows / macOS 或 Electron 窗口验收。

普通显式 timeout 前台命令也需要等待终止确认；成功 daemon 命令的旧快速返回语义保留。脱离进程组并持续持有输出管道的后代可能使取消清理继续等待，此时 Session 保持 cancelling，不应宣称已安全释放。full-access 进程组不是能约束任意逃逸程序的安全沙箱。

## 尚未合并的能力

- POSIX 本地 pipe 命令可持续输入；Windows 进程树所有权、真正 PTY（终端尺寸、控制字符 / TTY 语义）、SSH 和 sandbox 输入会话尚未实现
- 文件变更 diff / review、权限请求和动态工具的展示及协议仍有差异
- 安全的工具并发需要先定义副作用与授权次序，不能直接把串行执行换成 `Promise.all`
- 外部 Codex 最终历史快照的完整性、缺失项与流式记录的逐项核对仍需独立加固
- 既有 SSH helper 停止回执尚未统一为远端实际终止确认，断线与远端取消需要独立协议加固；本地验证不能代替远端退出证明
- 不声称覆盖所有 Codex 功能，也不声称离线 fixture 等同于真实模型、用户网关或跨平台 Electron 验收

## 验证入口

遵循根目录 `AGENTS.md` 和 `docs/dev/quality-gates.md`，使用 `test:impact` / `test:changed` 准备 workspace 构建产物，再通过官方 Vitest wrapper 执行。

- `packages/coding-agent/test/features/todo/`：原子更新、场景锁、持久化与恢复
- `packages/coding-agent/test/native-runtime-product-integration.test.ts`：真实 Native / Responses HTTP-SSE / 计划 / 文件工具 / 审批 / 流式 / 取消 / 新仓储实例恢复；新增跨 Turn 命令输入、逐次授权拒绝、迟到授权取消
- `packages/runtime-node/test/coding-suite/command/interactive-command-lifecycle.test.ts` 与 `interactive-node-host.test.ts`：进程端口、真实本地 stdin / EOF、清理与资源边界
- `packages/runtime-core/test/kernel/context-compaction-commit-regression.test.ts`：提交后视图刷新失败、自动 / 手动、取消、执行失败重试、崩溃与重复恢复
- `packages/runtime-core/test/kernel/turn-pipeline.test.ts`：准备失败、取消及 durable admission
- `packages/runtime-node/test/codex-app-server/conversation-queue-integration.test.ts`：真实 Session / Pipeline 与 Codex 协议适配器的接续、取消和失败
- `packages/runtime-node/test/codex-app-server/conversation-turn-engine.test.ts`：Context Plane 克隆 / 文本归一化之后的当前用户请求定位
- `packages/agent/test/tool-effect-lifecycle-regression.test.ts` 与 `packages/runtime-core/test/kernel/native-tool-cancellation-fence.test.ts`：底层工具所有权、真实 Session 停止等待和新输入隔离
- `packages/runtime-node/test/coding-suite/write/write-change-result.test.ts` 与 edit 合同测试：真实 diff、UTF-8 计数、未知 / 非文本 / 超限、inflight I/O 取消
- `apps/desktop/src/renderer/domains/conversation/components/blocks/ToolCallBlock.write-diff.test.tsx`：原工具卡片展开、运行中到成功切换、失败与未知回退

完整 `bun run check` 仍是独立门禁；定向行为测试通过不能代替全仓质量检查。
