# Codex 取消与收尾验证（R0 稳定性收口 / R1 局部准入）

## 范围

继续 `Ling0925/open-vetta` 的 PR #3，基线为 `bc912f2ba2a3bd60d4884e88b04ec2a78bc36f7a`。
本轮优先修复已接入路径中的执行边界，不扩大工具权限，不切换默认引擎，不改 Native 内核或会话持久化格式。
所有提交仅在 fork；Issues 按用户要求暂缓，PR 保持 Draft。

## 复现与修复

原有共享模型后端先等待 `bridge.assertCurrent()`，之后才把指令交给 Turn 控制器。
在这段等待期间，停止操作只能中止一个尚未启动的 Turn，无法撤销仍在等待的指令；
凭据读取稍后返回时，原指令仍可能被发出。原实现还会在启动回滚失败后让随后的 dispose 返回成功。

现在，两种 Codex 配置模式复用 `WorkspaceTurnAdmission`：它拥有从准备、启动到收尾的一次操作，
不执行模型循环，也不取代 Codex 的历史或工具调度。停止信号覆盖配置等待，并继续通过既有
`promptWhenAvailable(request, signal)` 交给真实宿主。没有另建消息队列，也不让该操作自动重放。

- 网关校验尚未返回时，停止会取消等待并阻止迟到的启动；后续明确发送的新指令可继续使用未失效的配置。
- 已发出的任务必须等到真实结果及停止清理完成才能释放准入；停止回执不等于任务已经结束。
- 只将能够证明发生在启动前的取消报告为 cancelled，外部错误和未知结果不改写成成功取消。
- 关闭立即关闭新任务入口，取消准备并等待资源清理；清理失败必须返回失败，不能被尚未返回的任务结果掩盖。
- 共享后端启动回滚失败会保留失败状态，后续 close 不能假装成功，不能再创建另一个执行所有者。
- 网关关闭、配置变更及 HTTP 客户端离开会中断等待中的凭据读取。底层读取可不响应取消，但其迟到结果/异常被接住，不能继续发送请求。

`CodexProviderBridge.assertCurrent(signal?)` 的参数是可选的，原调用者兼容。
这里的取消不意味着撤销已完成的文件写入，也不能保证远端服务回滚已接受的请求。

## 可重复的验证结果

相同的共享后端流程测试在旧源码上 **5 项中 4 项失败**，分别覆盖准备中停止、关闭会话、整体后端释放和启动清理失败；
另一项原有的正常关闭失败保护在旧版已通过，保留为不回归检查。修复后这 5 项全部通过。
旧实现与新实现的试验均使用完整的对应共享后端函数与真实 HTTP 桥接，不通过重写几行简化算法来模拟问题。

本轮总计执行 **54 项行为测试，54 通过，0 失败**：

| 范围 | 用例数 | 情况 |
| --- | ---: | --- |
| 之前的配置解析、桥接与密钥变更流程 | 31 | 本轮重新执行，而非引用历史结果 |
| 新准入层：取消、互斥、终态与关闭 | 12 | 通过 |
| 凭据读取中的取消/关闭/配置变更 | 6 | 通过，包含真实 loopback HTTP 请求 |
| 实际共享后端的连续流程与清理失败 | 5 | 通过，另在旧源码复现 4 项失败 |

执行环境是 Linux / Node 22.16.0。源码经 TypeScript 转译，测试注册由 Vitest 映射为 node:test。
共享后端测试在外部 Codex Host、文件锁和凭据存储边界使用同一组 fixture；离线执行器对这些 import 做对应映射，
与仓库中的 Vitest mock 使用相同边界。配置解析、准入逻辑、共享后端与本机 HTTP 桥接本身是真实代码。
这不是实际 RuntimeHost、真实 Codex 二进制或 Electron 的运行结果，也没有访问真实网关、账号或项目。

定向严格 TypeScript 检查通过的范围是独立网关桥接、模型解析、共享 DTO 和配置校验；
不包含依赖完整 workspace 类型的 Desktop 准入/装配，也不能代替全仓类型、格式和架构检查。
完整检查尝试被环境阻止：`bun: command not found`。工作区仅有已核对的源码子集，不能冒充完整检出环境。
查询基线提交的 GitHub Actions 未返回运行记录，不能据此声称远端检查通过或推断仓库设置的具体原因。

## 规划进度与后续验收

本轮对应 [路线](runtime-roadmap.md) 中 R0 接入的稳定性收口，以及 R1/R3 的局部取消边界。
六项改造没有因此全部完成：

| 工作项 | 本轮后状态 |
| --- | --- |
| R0 Codex 独立后端与桌面/网关接线 | 已有代码，继续修复验证；真实二进制、账号/端点、MCP 能力和 Electron 门禁仍未完成 |
| R1 统一准入与稳定输入身份 | 本轮统一 Codex 两种配置模式的准备/执行准入；Native 全入口与持久化 inputId、去重提交协议尚未实现 |
| R2 稳定 Item、终态和快照恢复 | 保留已有 ID 投影；跨进程版本边界与完整恢复验收仍待完成 |
| R3 工具取消与受控并发 | 本轮保护宿主准备与收尾；不声称实现了 Native 工具物理取消或并发调度 |
| R4 上下文预算、压缩与无进展检测 | 维持原计划，未新增实现 |
| R5 连接归属、凭据失效与缓存 | 改善等待阶段的失效响应；真实账号/端点核验与缓存专项仍待实施 |
| R6 授权、沙箱和重试 | 保持原来的保守审批与不自动重试，不扩大权限；完整策略版本化未完成 |

完整检出环境至少运行：

```bash
bun run test:pkg runtime-node
bun scripts/quality/run-vitest.mjs --run --config apps/desktop/vitest.config.ts \
  apps/desktop/src/main/codex-workspace/turn-admission.test.ts \
  apps/desktop/src/main/codex-workspace/shared-model-backend-flow.test.ts \
  apps/desktop/src/main/codex-workspace/model-source.test.ts \
  apps/desktop/src/main/codex-workspace/model-source-bridge.test.ts
bun run test:changed
bun run check
```

既有两项 RuntimeHost/文件锁集成、React/IPC 测试、跨平台清理、真实固定版本 Codex/schema、自建网关和 Electron 验证仍是门槛。
不因为局部测试通过就更换默认运行时、合并 PR 或发布。当前版本发布说明应在完整检出环境收口，候选用户条目如下：

> Codex 预览在读取网关配置期间也能停止，停止后不会因读取结果晚到而继续发送原指令；关闭失败会明确保留未确认状态，不会悄悄再启动一个执行者。真实二进制和完整桌面验收仍未完成。
