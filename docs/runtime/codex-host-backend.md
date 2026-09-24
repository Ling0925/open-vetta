# Codex RuntimeHost 后端（R0.2 开发者预览）

## 当前完成范围

PR #2 在 R0.1 的独立进程与协议适配器之上，增加了真实 RuntimeHost Backend、会话关联目录、历史/事件投影、
能力矩阵及复用现有路由器的组合入口。它仍是开发者预览：**尚未修改 Electron 组合根、IPC、运行时选择器或审批界面**，
因此安装当前 App 不会自动切到 Codex，也不能据此宣称桌面端已可用。Native 默认设置和既有会话不变。

公开入口仍为 `@vetta/runtime-node/codex-app-server`，新增：

- `CodexRuntimeHostBackend`：按现有合同生成实际的 `RuntimeHostSessionAssembly`。
- `CodexHostSessionCatalog`：只负责 Codex Thread 与 Vetta 本地会话的关联及列表元数据。
- `createCodexRuntimeHostIntegration()`：复用现有 Catalog Router，将 Native 与 Codex 后端组合。
- `CODEX_HOST_CAPABILITIES`：宿主启用入口前必须检查的能力矩阵。

模型调用、工具执行、压缩和权威历史仍全部由 Codex 管理；没有加入第二层 Agent Loop。
R0.1 的可信二进制、版本核对、认证和权限边界见 [协议适配器说明](codex-app-server.md)。

## 宿主组合

构建完整 workspace 后，可由可信 Node Composition Root 显式组装。例如：

```ts
import { RuntimeHost } from "@vetta/runtime-core";
import { FileConversationOwnershipManager } from "@vetta/runtime-node/conversation";
import { CodexRuntimeHostBackend, type CodexHostProfile } from "@vetta/runtime-node/codex-app-server";

export function createCodexHost(profile: CodexHostProfile, catalogRoot: string) {
    const backend = new CodexRuntimeHostBackend({
        profile,
        catalogRoot,
        ownership: new FileConversationOwnershipManager(),
    });
    const host = new RuntimeHost({
        createSessionBackend: () => backend,
        sessionCatalog: backend.catalog,
    });
    return { host, backend }; // 应用关闭时 await host.close()，不能只断开 UI 订阅。
}
```

`profile` 来自可信宿主设置，需指定稳定 id、绝对路径 executable、精确 expectedVersion 和显式 codexHome；
可指定 model 与 read-only/workspace-write。codexHome 必须存在，且它和 catalogRoot 都不能位于任务工作区内。
不得从聊天、仓库文件、插件输入或会话索引中决定可执行文件、参数、登录目录或权限。

新建时通过 `host.createSession({ cwd, executionMode: "sandbox" })`；使用 `host.prompt()`、`host.abort()`、
`host.getFullHistory()` 和 `host.getState()`。保存 `host.getSessionPath()` 返回的关联路径，重开时传入
`host.createSession({ sessionPath, executionMode: "sandbox" })`。这里的 Host prompt 返回最终结果，
不同于底层 `startTurn()` 的即时回执；completed/cancelled/failed 必须分别处理，失败不能自动原样重发。

双后端使用 `createCodexRuntimeHostIntegration({ native: { backend, catalog, accessResolver }, ...options })`。
返回的 sessionBackend、sessionCatalog、sessionAccessResolver 可注入 RuntimeHost。
`defaultRuntime` 默认 native，仅在构造组合时显式选择 codex 才改变新会话路由；这不是已接好的每会话 UI 选择器。
既有路径始终按目录归属恢复。调用者仍拥有注入的 Native 后端；组合的 dispose 只关闭其 Codex 后端。
Codex 记录缺失、损坏、权限不兼容或启动失败，不会偷偷改走 Native。

## 会话关联与资源所有权

新增 `.codex-session.json` 记录只保存 runtime/schemaVersion、本地 sessionId、Codex threadId、可信配置指纹、
工作目录、创建/修改时间、名称和最多 120 字符的首条/末条预览。**不是第二份聊天历史**；预览仍可能含敏感文本，
按本地会话元数据保护，不能上传作遥测。记录不接受 Token、认证数据、可执行参数或完整 messages/turns。
文件有大小和字段校验；创建使用独占写，元数据更新使用临时文件发布；拒绝符号链接和路径穿越。

后端复用 `FileConversationOwnershipManager`，先持有本地关联文件的生命周期租约，再持有
`CODEX_HOME/.vetta-runtime-leases/<ThreadId 的 SHA-256>` 的租约。后者防止两个不同目录中的关联记录同时打开
同一个 Codex Thread。只有进程关闭得到确认，才释放租约；无法确认关闭则保守保留，不能趁机再打开第二个执行者。
这些租约约束使用该实现的 Vetta 客户端，不约束自行启动、忽略这些锁的外部 Codex 客户端。

配置指纹覆盖 profile id、canonical executable/home、参数、版本、模型和沙箱设置。不同配置不能直接续接旧会话；
它**不是**对同一 home 内实际登录账号、端点或配置文件内容的认证证明。同目录换账号/改配置仍需后续 R5 的显式身份绑定。
本实现不会复制或修改 auth.json/config.toml，不会自动迁移旧会话或删除 Codex 的原始历史。

## 终态与显示一致性

直播条目和恢复历史以 Thread/Turn/Item ID 归并；最终条目覆盖临时增量，重复事件和最终状态之后的迟到增量被忽略。
支持用户/助手消息、计划、推理摘要和工具 call/result 显示投影；未知条目保留为带身份的 opaque marker，不解释成 Native 工具。
工具失败、非零退出码或未知退出码不会被投影为成功。

Codex 的 `turn/completed` 可以携带未加载或摘要级的 items。后端不会让这种稀疏终态覆盖已流出的回复；
完成后从 Codex 重新读取权威 Thread，确认 itemsView 为 full，再替换历史并更新列表元数据。
这段核对期间会话仍保持 busy，最后才发布宿主终态。历史不完整或读取失败进入恢复状态，不伪造空历史或成功。
大历史分页仍未实现；遇到适配器帧大小限制或只能取得部分历史时会明确失败，而不是静默裁剪。

`backend.readSnapshot(sessionId)` 返回 Codex 状态、执行中工具、能力、历史与实例游标，供后续桌面组合使用。
游标是实例内观察序列，不是跨进程持久化日志；桌面切换会话的快照/订阅衔接仍要做专门端到端验收。

## 能力真实性

| 操作 | 当前行为 |
| --- | --- |
| 文本发送、流式显示、显式 steering、停止、重开 | 已提供 Host ports；steering 只针对当前活动 Turn |
| 列表、项目分组、本地名称 | 通过关联目录读取/更新，不启动模型 |
| 已打开会话历史 | 从 Codex 权威记录投影，不读取 Native JSONL |
| 离线 Native 文件历史查看 | 不支持；accessResolver 的 readHistory=false 指这条文件读取路径，不是已打开的历史视图 |
| Native 跟进队列、隐式 continue/retry、消息编辑、分支和删除 | 明确 UNSUPPORTED，不返回空成功 |
| 图片/附件、Native context/promptRef/metadata、模型和思考覆盖 | 明确拒绝；不能默默丢弃用户限制或附件后照常发送 |
| Native 密钥共享、工具安装、用量统计 | 不支持，不隐式转交认证，不在显示投影中运行工具 |
| 完全访问或运行中扩大权限 | 拒绝；沿用已验证的固定 Codex profile |

现有 Message/State 合同要求数字 usage/context 和字符串模型字段，因此显示兼容消息用 unavailable/专用 runtime 标识及
数值占位。**它们不是实测 Token、费用或真实模型参数**，不发 usage.update，Native 用量统计及模型/思考控件必须禁用。
能力矩阵位于 Assembly 扩展和 backend snapshot，现有 Host 不会自动把它变成 UI 开关；R0.3 必须显式接线。

## 验证记录

本次新增 42 项测试：40 项完成离线执行、0 失败，2 项完整 workspace 集成测试尚未执行。

| 分组 | 新增用例 | 本次执行情况 |
| --- | ---: | --- |
| 后端与生命周期 | 13 | 通过 |
| 关联目录 | 8 | 通过 |
| 历史/事件投影 | 12 | 通过 |
| 既有后端路由组合 | 4 | 通过 |
| 真正 Node 子进程与 stdio | 3 | 通过 |
| 实际 RuntimeHost + 现有文件锁 | 2 | 未执行，等待完整 workspace |

离线执行对真实新增源码做 TypeScript 转译，测试注册从 Vitest 改为 node:test；外部 Codex 用确定性的协议替身。
文件目录和子进程/管道是真的，普通用例中的持久化租约用 storage port fixture；组合测试加载两份完整且哈希核对一致的
原有路由模块，不冒充完整 RuntimeHost。只有最后两项使用真正 RuntimeHost 和 FileConversationOwnershipManager，
它们未纳入已通过的 40 项。原 R0.1 的 39 项未在本轮重新执行，不能把历史结果相加当作本轮全套通过。

本环境无 Bun 和完整 workspace 依赖，原生检查尝试返回 `bun: command not found`。
转译成功只证明语法，不等于严格类型、Biome 或全仓质量门禁通过。本次未运行真实 Codex、真实模型、Electron、
Windows/macOS 进程回收或完整包回归；子进程测试环境为 Linux，不使用生产项目或用户登录数据。

完整检出环境应使用仓库脚本：

```bash
bun run test:pkg runtime-node
bun run check
```

以上门禁、当前版本发布说明与 R0.3 桌面验收完成前，PR 保持 Draft，不自动合并或改变用户的默认 runtime。
