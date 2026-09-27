# 原会话内切换 Native / Codex

## 用户入口

普通新会话与已有会话的输入框工具栏，在原模型选择器旁提供 Native / Codex 两段式开关。
不跳转页面，不新建另一条侧栏会话，不提供第二份输入框或预览消息流。
新会话的第一条消息先确认后端，再交给原发送入口；失败时恢复输入，不偷换 Native。
已有会话在任务、队列和压缩结束后原地切换。切换验证、提交期间禁止发送及第二次切换；
前置检查失败保留旧选择，传输结果不确定时读取实际记录再开放输入。

Codex 使用安装包内置程序、独立托管数据目录和现有模型设置中的 Responses 网关、凭据和代理。
模型选择仍在原位置，推理等级沿用当前绑定；不要求再次输入地址、密钥或登录 ChatGPT。
原独立预览入口已经移除，不删除原预览历史。

## 执行和历史所有权

原有 Kernel / Conversation journal 继续管理用户输入、排队、消息提交、历史编辑、恢复和会话身份。
组合根通过通用 composeExecution 端口选择本轮 TurnEngine；Core 不依赖 Codex 或 Desktop。
Codex 执行完整的模型/工具循环，Native AgentCore 不再执行该轮，也没有把 Codex 塞进 Native streamFn。
工具和文本事件转为原 SessionEvent，消息只由原 Kernel 提交一次。未测得的用量不会记成真实零费用。

当前切片为每一轮 Codex 指令建立并关闭独占进程/线程。新的 Codex 线程只接收 **Vetta Context Plane 已准备好的**
模型可见上下文；历史工具调用被标为数据而不是重新执行指令。本轮生成的文本和工具结果回到原 Conversation，
切回 Native 继续使用同一份 journal、Context Strategy 与 compaction 边界。

Vetta 是应用级上下文唯一 owner：Conversation 投影、Context Provider、token budget、统一 Context Policy、
自动/手动 compaction、
Context Summary、model-call transient transform/finalization、压缩持久化和恢复都不随后端切换。Codex 仅替换执行 loop；
进入 Codex loop 前会执行与 Native 首次模型调用一致的 Vetta context transform → model_call checkpoint/compaction →
finalization，再把结果封装成 Codex handoff。这样后续调整压缩阈值、keep-tail、summary 结构或 Context Provider 时，
Native 与 Codex 会同时生效，不需要维护两套策略。

Codex 内部单个 Turn 的工具输出和后续模型调用仍属于该外部 loop 的瞬时状态，Vetta 暂不能逐次拦截 app-server 内部
每一个模型调用；这些瞬时状态不会成为第二份应用历史。下一次 Vetta Turn 仍从 canonical Conversation/compaction
重新准备上下文。只交接模型可见的文本/结构化记录，不交接模型隐状态；二进制附件明确不交接。
3 MiB 仍作为 **Vetta 准备/压缩之后** 的 Codex handoff 硬传输上限，超过时 fail-closed，不偷偷截断。

本轮后端绑定按 sessionId / operationId 固定，既有模型/snapshot 在异步读取之前同步捕获。
切换记录以 custom metadata `desktop.runtime-backend` 保存，不改变原会话文件格式或 session ID。
校验请求中的 expectedSelectionId，损坏或新版本记录不能自动回退 Native。

## 稳定输入身份与重复准入

每次显式提交现在携带稳定 `inputId`：Desktop 在已有乐观用户气泡时复用其 identity，
否则生成独立 identity。该值经过 PromptRequest、RuntimeHost、Kernel admission 到 TurnEngine，
Codex 再将同一个值作为 `clientUserMessageId`。

Kernel 在真正执行前把 `inputId` 以 model-invisible、display=false 的
`runtime.input.identity` context fact 与持久化 `turnId` 绑定；不修改 Conversation 文件 schema。
内存中正在执行的相同 inputId、队列中的重复 inputId，以及已经在 journal 中出现过的 inputId
都会 fail-closed，不能再次启动模型或工具。恢复出的队列若包含重复 identity 也会拒绝加载。

当前策略是 **at-most-once admission，不是自动重放**：发现重复提交时要求调用方根据原会话的
durable turn 状态进行核对，不会因为网络回执丢失而重新执行命令。RuntimeHost 与 Desktop 现在
提供只读 `reconcileInput(inputId)`：返回 missing / active / completed / cancelled / failed /
transferred / ambiguous。renderer 在 prompt IPC 抛错后先调用它；若原请求已被持久化接收，则恢复
原历史/运行态并把这次发送视为既有工作，而不是生成第二个 Turn。只有返回 missing 才沿用原传输错误。
ambiguous 一律 fail-closed，要求人工检查历史。

目前形成的身份链为：
`inputId → turnId → toolCallId → approval requestId`。其中 approval requestId 已绑定
session/RPC/thread/turn/item，旧批准不能落到新的 Turn。

## 统一 Context Plane

后端开关不再切换 Context owner。无论当前执行的是 Native 还是 Codex，Session 的上下文控制面都来自同一套
Runtime snapshot，因此手动压缩、Context Summary、自动压缩开关和 eligibility 在 Codex 模式下也继续可用。
Codex 清理失败只阻止新的 Codex execution acquisition，不阻止用户读取历史或执行 Vetta 自己的手动压缩/摘要。

为了避免“两个 loop = 两个上下文系统”，后端选择器不再改 Kernel 的 snapshot。Kernel 始终使用完整
Context snapshot 完成 Provider、预算、压缩、summary 与 Context Plane 绑定；真正进入 Codex loop 时才生成一个
execution-only snapshot，移除 Native tools/instructions，同时移除所有 Context 实现 hook。Codex 只能消费已经绑定的
`contextPlane`，不能直接调用 ContextStrategy 或自行提交 Vetta compaction。手动压缩/summary 使用的是 Kernel 完整
snapshot，因此切到 Codex 后仍可正常执行。

## Codex 工具可观察性

原会话现在把 Codex `commandExecution` 映射到普通命令卡片：折叠行直接显示实际命令，
展开后复用终端卡显示完整命令、流式/最终输出、工作目录、耗时以及可取得的 exit code。
协议技术名不再作为主要标题。`fileChange` 会显示首个文件路径和文件数量，`mcpToolCall`
会显示 MCP server 与 tool 名称。原始工具 item 仍保留在会话记录中，展示层只做投影，
不改变 Codex 的执行、审批或历史事实源。

这一切片同时推进 R2 的可观察性边界：稳定 toolCallId 继续作为合并键，终态不会被晚到 delta
改回 running；展示增强不另建第二份工具状态，也不会因为 UI 识别失败重放命令。

## 审批、停止与限制

Codex 固定使用工作区写入沙箱，额外访问通过现有权限抽屉逐项确认；不给会话级永久批准。
命令审批优先展示实际 command 与 cwd，文件修改审批列出目标路径，再附完整原始请求供核对；
批准仍绑定这一项请求，展示优化不会扩大授权范围或把未知请求自动视为安全。
权限抽屉的 requestId 由 session / Codex RPC / thread / turn / item 身份哈希得到，不包含命令正文或凭据；
同一底层请求保持可关联，不同 item/turn 不复用 UI 身份。最终批准返回后，Codex session 仍重新校验
当前 active turn、itemId 和 abort signal，旧批准不能落到后续任务。
保留 Native 原权限选择供切回使用，但不把 Native 完全访问模式复制给 Codex。
权限请求结束/取消会移除原抽屉的陈旧请求；旧按钮回调不能作用于新的请求。
停止与消费者退出取消所属执行，关闭须等待进程和网关清理。清理未确认时禁止再接任务或切换执行者。
Runtime state 现在同时暴露 `currentTurnId`。Desktop 的 Stop 会先读取该身份，再以
`expectedTurnId` 提交 abort；若用户点击与主进程处理之间已经开始了新的 Turn，返回 stale 并且
**不会**中止新 Turn，也不会清理新 Turn 的后台任务。旧调用方不提供 expectedTurnId 时仍保留兼容的
无条件 stop 语义；scoped RuntimeHostSession 也继续保留原来的 `abort(reason?)` 合同，另提供
`abortExpectedTurn(expectedTurnId)` 给需要身份保护的调用方。Turn 尚在 admission、还未持久化 turn.started 的极短窗口可能拿不到 identity，
此时 renderer 不猜测一个 Turn ID。
停止不回滚已完成的外部操作，不保证远端计算立即终止。

当前支持本地普通会话的文本任务和 Codex 原生工具。远程项目、团队、独立 Agent 权限档案、Native 计划模式、
Native 附件/插件/MCP 注入暂不自动转换，界面与主进程明确拒绝。不因切换引擎扩大这些权限。
原会话记录仍在原路径，持久化选择不代表支持跨运行时移植所有工具能力或内部上下文。

## 验证范围

定向离线执行 26 项行为测试全部通过，包括原会话选择、失败/并发保护、首条消息确认、权限取消、
实际 Codex 协议适配器事件、取消、异常清理、上下文交接和有界缓存。Vitest 注册映射到 node:test；
生产逻辑是真实源码，外部进程/模型/仓储端口按用例使用替身。不是完整 Native/Vitest 或 Electron 验收。

另提供真实 ComposedRuntimeFactory、Kernel、内存 Conversation repository 的双向切换/关闭重开测试，
真实 React 工具栏交互测试，以及固定 Codex 0.157.0 进程和本机 Responses fixture 的原会话引擎测试。
这些测试需完整依赖的 GitHub Actions 执行，结果以对应提交的报告为准。
本切片初次提交时，不把基线已通过的旧聊天测试或旧 preview 二进制测试当成新增路径通过。
用户自建网关和跨平台实际安装效果仍需要安装联调。
