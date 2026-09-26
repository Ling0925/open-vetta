# Subagent V2 实现说明

## 职责目录

```text
packages/runtime-subagents/
  contracts / coordinator / dispatcher / run / pool / delivery / recovery

packages/coding-agent/src/composition/subagent/
  profiles.ts                    内置 Definition
  profile-policy.ts              新策略与旧 profile 的单一兼容边界
  task-contract.ts               结构化委派合同
  report-to-parent-tool.ts       child -> root 报告
  subagent-session-extension.ts  Session 生命周期所有权
  session-assembly.ts            宿主端口与 child Runtime 装配
  child-composition-policy.ts    单层、工具、MCP、Skill 投影
  child-handle.ts                Runtime Session -> 通用 Child Handle
```

## 可配置合同

`CodingAgentSubagentProfile` 的真实变化维度由策略表达：

- `toolPolicy`：继承父激活或显式激活；
- `mcpPolicy`：继承并可按前缀拒绝，或完全关闭；
- `skillPolicy`：继承、关闭或名称 allow-list；
- `contextPolicy`：完整快照或 fresh；
- `todoPolicy`：开启或关闭；
- `workspacePolicy`：共享或隔离，隔离可选择端口缺失时失败或兼容回退。

旧的 `activation`、`inheritParentMcp`、`forkParentContext`、`includeTodo` 和 `denyToolNamePrefixes` 仍可读取，但只在 `profile-policy.ts` 映射，不能在其它模块继续增加旧字段分支。

`subagentTypeRegistry` 与 `subagentWorkspacePort` 是 Composition Root 的内部装配扩展点，不属于稳定公共 SDK。工具和 Skill 的默认行为是继承父会话；显式 deny/allow-list 决定收窄，不能扩大到父宿主没有的能力。

## 交付语义

普通 `spawn_agent` 使用 terminal delivery。`dispatch_workflows` 为每次调用生成 batch id，所有成员持久化 `deliveryMode=batch` 与 `batchId`。Delivery 仍负责 generation claim；Coordinator 只在批次全部终态时把全部成员排入一次通知，因此 wait 和自动通知仍然互斥消费同一 generation。

`subagent_state_v1` 的快照 Schema 同步接受可选 `deliveryMode`/`batchId`。字段保持可选，因此旧记录继续可读；新记录在进程重启后能够恢复批次身份并回放到 Desktop。

## 用户直接跟进 Child

Desktop 通过现有 Session Extension 新增 `subagents.follow-up` 控制面。用户可以从 Workflow/Subagent UI
直接给指定 child 追加指令：运行中的 child 在自然停点接收 follow-up，已经终态的 child 则复用原 transcript
原地恢复，不会重新创建一个“同名但没上下文”的任务。IPC 对文本做非空与 16 KiB 上限校验，仍由 child 自己的
权限/工具策略执行，renderer 不能扩大能力。

## A2A Advisor

内置 `advisor` 是基于同一 SubagentCoordinator 的只读顾问类型，不引入第二套 Agent runtime。
根 Agent 通过 `ask_advisor` 发起一次咨询：Advisor 继承当前父会话上下文，只开放 read/grep/glob/find/ls/dir_tree，
禁用 MCP、Skill、Todo 与二次委派；它可以核对代码事实，但不能修改工作区。

`ask_advisor` 默认同步等待 90 秒并通过现有 delivery claim 取得唯一终态结果，因此正常完成不会再额外产生一份
重复的 subagent notification。超时不会杀掉 Advisor，也不会自动再派一个；原 child 转入后台，后续仍走现有通知与
Subagent UI。这个设计把“第二意见”做成一种明确的 A2A 交互，而不是伪装成普通 workflow。

## UI 合同

活动面板展示 Solar 状态图标与主题语义色、结构化 objective、Todo `done/total`、聚合 token/cost，以及权限、上下文、连接、执行四类错误。选择和状态变化使用 200ms 过渡；长内容使用换行、截断或限定高度滚动。旧事件不含 usage 时安全省略该指标。

## 当前边界

- 保持单层，不开放递归树和 sibling messaging。
- 完整上下文与 fresh 已可配置；尚未引入语义检索或自动 token-budget projector。
- 工作区核心只定义租约端口，不在 Coding Agent 内直接调用 Git；是否用 worktree、临时副本或远端 workspace 由最终宿主决定。
- 未引入 DAG 调度。存在真实依赖的步骤应留在 root 顺序执行，避免把等待包装成昂贵子代理。

## 验证入口

```powershell
bun scripts/quality/run-vitest.mjs --run packages/runtime-subagents/test packages/coding-agent/test/runtime-core/subagent-control-tools.test.ts packages/coding-agent/test/runtime-core/subagent-session-assembly.test.ts
bun run check:quick
bun run check
```

Desktop 真实验证使用根目录 `verify:ui:*` 流程；开发环境会话必须通过 `vetta debug`，不得用生产状态目录代替。

## 2026-08-20 实测

- 简单算术会话直接由 root 回答，没有产生子代理调用。
- 一个包含两个无关复杂审计工作流的会话实际创建两个 `workflow` child；两者使用同一个 batch id，首个完成时未通知，整批终态后只追加一次父上下文通知并自动继续 root turn。
- 两个 child 分别执行了定向测试并同步 Todo 与 usage；父进程重启后，`subagent_state_v1` 恢复出两条完成记录和 generation，Desktop “工作流”标签可切换查看各自 transcript。
- 实测过程中发现并修复了恢复 Schema 未接受 `deliveryMode`/`batchId` 的兼容性缺口；对应回归测试位于 `subagent-state-persistence.test.ts`。
- Debug Profile 的 Windows sandbox host 不认识当前 `--capabilities` 参数，因此真实模型会话使用了隔离状态目录下的 full-access profile，并将子任务约束为只读；未访问生产状态目录。
