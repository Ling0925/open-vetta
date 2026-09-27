# Vetta 统一拥有跨执行后端的 Context Plane

## 状态

Accepted

## 背景

原会话已经可以在 Native 与 Codex TurnEngine 之间切换。早期 Codex 接入为了避免“双 Agent Loop”同时拥有
压缩、工具与重试，曾在 Codex snapshot 中关闭 Vetta 的 Context Strategy、Context Provider、手动压缩和摘要，
并把完整可见历史直接交给 Codex。这样能快速隔离执行 loop，但会让后续 Context 策略出现两套所有权：
Native 受 Vetta 的预算/压缩控制，Codex 只得到旁路历史。

产品后续会重点调整上下文组成、压缩阈值、摘要结构、长期记忆以及 Workflow/Subagent 的 Context budget。
这些策略如果按执行后端分叉，将无法稳定演进。

## 决策

应用级 Context Plane 永远归 Vetta Runtime 所有，Execution Backend 只决定 Turn 的执行 loop。

统一 Context Plane 包括：

- canonical Conversation / active branch 投影；
- Context Provider 与模型可见临时上下文；
- token budget 与 reserved output budget；
- Context Strategy 与自动压缩；
- 手动 compaction 与 Context Summary；
- model-call transient transformer / finalizer；
- compaction journal、continuation、恢复与观察；
- Context usage / composition 的宿主状态。

Native TurnEngine 继续在每次模型调用前使用这些 Runtime hook。Codex TurnEngine 在进入外部 app-server loop 前，
执行一次与 Native 首次模型调用等价的 Vetta context sequence：

1. model-call context transformer；
2. Runtime `model_call` checkpoint（包括自动 compaction 与持久化）；
3. model-call message finalizer；
4. 将最终模型可见消息序列封装为 Codex handoff。

Codex snapshot 只移除 Native loop 专属的 tools、instructions、model-call frame/contribution、AgentRunPreparer 与
continuation policy；不得移除 Context Plane 能力。手动压缩和 Context Summary 在 Codex 选中时仍由 Vetta 执行，
也不依赖 Codex 子进程是否可复用。

## 边界

Codex app-server 内一个 Turn 可能包含多个内部模型调用和工具结果。当前协议没有把每个内部模型调用暴露成 Vetta
checkpoint，因此 Vetta 只拥有 **跨 Turn 的 canonical context** 和进入 Codex loop 前的 prepared context；本 Turn
内部的瞬时上下文由 Codex loop 暂时管理。它不能写成第二份应用历史，下一 Vetta Turn 重新从 canonical
Conversation/compaction 准备。

这不是允许 Codex 自己维护另一份长期摘要。未来若 app-server/provider bridge 能暴露内部 model-call checkpoint，
应把它接回同一 Runtime Context Strategy，而不是新增 Codex 专属 compactor。

Codex handoff 的 3 MiB 上限是 transport safety guard，发生在 Vetta transform/compaction 之后；超过时明确失败，
不得静默截断或绕过 Vetta Context policy。

## 后果

- 调整 Vetta compaction settings、keep-tail、summary format、Context Provider 或长期记忆策略时，Native 与 Codex
  同时获得变化。
- 后端切换不会切换上下文事实源，已有 `context.compacted` 对两个 loop 都有效。
- Codex 仍是独立 Agent Loop，不会把 Native tools/system prompt 注入其内部执行。
- Context 与 execution 的职责可以分别演进：后续 Workflow/Subagent/A2A Advisor 可以共享 Vetta Context Plane，
  而各自保留不同执行策略。
