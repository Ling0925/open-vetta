# Codex App Server 接入（开发者预览）

本页介绍 **R0.1：Node 进程、协议与会话适配层**。PR #2 现已继续实现 R0.2 的 RuntimeHost Backend、
关联目录、历史/事件投影与能力矩阵，见 [后端接入说明](codex-host-backend.md)。
**Electron 组合根、桌面选择器和审批界面尚未接线**，还不能在 App 中直接选择 Codex。
原生集成及真实二进制验收待完成，见 [实施路线](runtime-roadmap.md)。Native runtime、默认设置和旧会话格式不变。

## 边界

公开入口为 `@vetta/runtime-node/codex-app-server` 的 `openCodexAppServerSession()`。
一个对象独占一个本地 `codex app-server --listen stdio://` 子进程及一个 Thread。
模型请求、工具调用、压缩与权威历史均由 Codex 负责；Vetta 不在外面再套一次模型循环。

适配器实现：启动与版本核对、initialize/initialized、thread/start/resume/read、turn/start/steer/interrupt、
流式通知、终态确认、命令/文件审批转交及资源关闭。第一阶段仅支持文本输入，不伪造附件、MCP、
动态工具、分支编辑或模型用量适配。其他服务端请求返回明确的不支持错误，而不是空成功响应。

协议字段核对基于 OpenAI Codex 源码提交
`b19cebecc0169097bda7539af03c886e03bdeafe` 的
`codex-rs/app-server-protocol/schema/typescript/`。
参考 [App Server 官方文档](https://developers.openai.com/codex/app-server) 和
[该提交的协议目录](https://github.com/openai/codex/tree/b19cebecc0169097bda7539af03c886e03bdeafe/codex-rs/app-server-protocol/schema/typescript)。
这是协议参考，不是声称某个发布二进制已经通过验收。`expectedVersion` 必须由宿主提供精确的已验证版本，
适配器拒绝与 `codex --version` 不一致的安装；不会下载、升级 Codex 或执行项目给出的安装命令。
版本字符串核对不替代二进制来源、签名或校验和验证。

## 手动开发验证

先在隔离目录配置可信的 Codex CLI。认证由 Codex 自身负责，适配器不读取、复制、写入 `auth.json`，
也不接收 Vetta 的 OAuth token。启动的 Codex 仍会按自己的配置访问凭证、写会话历史和发送模型请求。
省略 `codexHome` 时会使用 Codex 的默认目录，因此开发验证建议显式指定隔离目录，不指向真实工作会话。
R0.2 的 Host Backend 则强制显式提供 codexHome，另在其下保存 Vetta Thread 租约，不修改认证或配置文件。
不要把真实凭证、完整协议转储或任务输出放进测试日志。

构建 `runtime-node` 及依赖后，可在可信 Node 宿主中调用：

```ts
import { openCodexAppServerSession } from "@vetta/runtime-node/codex-app-server";

// 均来自可信宿主设置；不得让模型、插件或仓库文件指定 executable/executableArgs。
const session = await openCodexAppServerSession({
    executable: configuredCodexExecutable, // 绝对路径；Node CLI 可用 executableArgs 指定可信入口
    expectedVersion: hostVerifiedCodexVersion,
    cwd: isolatedWorkspace,
    codexHome: isolatedCodexHome,
    sandbox: "read-only",
});
const unsubscribe = session.subscribe((event) => {
    // 适配到宿主显示层，不直接将原始事件/敏感内容写日志。
    updateConversationView(event);
});
try {
    const run = await session.startTurn({ text: "阅读项目结构，不修改任何文件。" });
    // startTurn 返回回执，不是最终完成。
    const result = await run.completed;
    renderOutcome(result.status); // completed / interrupted / failed 均需分别处理
} finally {
    unsubscribe();
    await session.close();
}
```

示例中的配置和 UI 函数由宿主提供；真实 `startTurn` 会访问已配置的模型并可能产生费用。
自动化测试不执行这个示例、不启动真实 Codex、不使用用户登录目录。

运行中插入消息必须使用 `steer({ text, expectedTurnId })`；停止可以使用 `interrupt(turnId)`。
操作只针对当前对象所属的 Thread/Turn。超时或连接退出会让会话进入 `recovery-required`，禁止继续发送；
调用方应关闭对象，读取/核对 Codex 的已存历史，再显式恢复，不能把原任务自动重发。
`inputId` 转发为 `clientUserMessageId`，用于关联，不宣称提供恰好一次执行或持久化去重。

## 权限与取消

默认请求 `read-only`、`on-request` 和 `approvalsReviewer: user`。
返回的工作目录、沙箱类型、网络权限及审批路由不符合请求时，停止初始化，不发送 Turn。
`workspace-write` 需要显式 `onApproval`；额外 writable roots 不能超出工作目录。
该模式沿用 Codex 的临时目录行为，不等价于只允许一个文件夹中的全部副作用。

命令/文件审批只支持本次 `accept / decline / cancel`；没有处理器时默认 decline。
不提供 acceptForSession、执行规则修订、自动审查或完全访问模式。
宿主审批 UI 必须原样呈现动作范围；停止、终态、服务端撤销和连接关闭会取消审批 signal，迟到的 accept 不再提交。
这不是对 Codex 配置中所有 MCP/插件的统一授权保证：本地沙箱不能约束远端 MCP 的副作用。
桌面启用前，必须完成这些能力的白名单、授权与显示门禁，不能把本适配器冒充完整的只读安全产品。

interrupt 回执只确认信号；`interrupt()` 等待匹配的 `turn/completed`。
停止超时不冒充 idle，而进入恢复状态并关闭拥有的连接。
关闭先结束 stdin，超过宽限再结束拥有的进程组（Windows 用进程树终止），最后核对根进程退出。
不能据此宣称已经回滚文件改动、停止远端请求或终止自行脱离进程组的任务。

## 资源限制与可观察性

默认 RPC 超时 30 秒、宿主请求等待 60 秒、停止确认 10 秒、任务截止 30 分钟；均可由可信宿主调整。
默认最多 64 个待处理请求、单帧 8 MiB、Turn 回执前最多 256 条 / 8 MiB 通知。
这些值是可配置的适配器保护，不改变 Native 的默认循环预算。
stdout 仅作 NDJSON 协议；stderr 排空但不记录，协议畸形/非法 UTF-8/超限会断开连接。

事件携带 `instanceId + sequence + threadId`，保留 Codex 的 `turnId / itemId`。
这是本实例的实时观察序列，不是跨进程事件日志。历史在 idle 状态用 `refreshHistory()` 读取，
不能将历史快照与任意旧事件盲目混合。R0.2 已增加 Host 侧条目投影与完整历史核对；
终态前的晚订阅实时回放、历史分页和桌面投影接线仍属于后续工作。

## 验证

新增测试位于 `packages/runtime-node/test/codex-app-server/`。完整检出环境从根目录运行：

```bash
bun scripts/quality/run-vitest.mjs --run --config packages/runtime-node/vitest.config.ts packages/runtime-node/test/codex-app-server
bun run test:pkg runtime-node
bun run check
```

R0.1 首次提交的离线验证使用实际模块、Node 子进程/管道和独立临时目录；只将测试注册接口从 Vitest 换成 node:test，
严格类型检查当时仅覆盖 R0.1 新增生产模块。这是上一阶段的验证记录，不代表当前分支整体已完成严格类型检查。
本轮 R0.2 新增测试和执行范围单独记录在 [后端接入说明](codex-host-backend.md)：40 项离线测试通过，
2 项真实 RuntimeHost/文件锁集成用例待执行。完整 Bun/Vitest、全仓类型/格式/架构检查、真实 Codex 二进制和桌面 E2E
尚未执行，不能将替身协议测试当成这些检查通过。PR 保持 Draft，以上门禁完成前不建议合并或启用。
