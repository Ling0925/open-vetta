# Codex App Server 以独占进程与会话适配器接入

## 状态

Proposed（R0.1 与 R0.2 Backend/Catalog 实现随 Draft PR #2 提交；原生集成门禁和 R0.3 桌面接线尚未完成）

## 背景

Native runtime 的会话竞争与取消修复已通过 PR #1 合入。项目所有者希望优先接入完整 Codex runtime，
并逐步改进 Native 的执行边界。既有 RuntimeHost 有 Backend/Catalog 合同，但必需的历史、配置与模型 Port
不能用空成功实现填满，否则 UI 会显示实际不具备的能力。

## 决策

在 `runtime-node` 增加实际拥有 Node 子进程的 `codex-app-server` 适配器：版本探测、NDJSON、双向 RPC、
Thread/Turn 映射、终态、审批与关闭。它不实现模型或工具循环，不改通用 Kernel，不拥有 Desktop 配置。

R0.2 使用现有 RuntimeHost 合同提供 Backend、元数据 Catalog 与 ID 化显示投影，组合入口复用现有
CatalogRoutedRuntimeHostSessionBackend。新会话可由可信组合根选择后端，旧路径仍按原归属路由；
Codex 出错不得静默切 Native。一条会话只由一个 runtime 管理权威历史，不支持的 Native 操作明确拒绝。
能力矩阵必须由后续桌面组合显式用于界面和调用门禁，不能仅通过结构检查就宣称 App 已具备所有功能。

会话持久化只增加独立的版本化 `.codex-session.json` 关联索引，记录 Thread 身份、可信配置指纹和列表元数据，
不复制 Codex transcript。复用现有 ConversationOwnershipManager 持有关联文件与 Codex home 下的 Thread 租约，
关闭拥有的进程后再释放。不会读取或修改原生 Codex 历史文件，也不改变 Native 的格式或默认配置。

未知副作用状态使对象进入恢复状态，禁止自动重放请求；取消回执不等于任务完成。
未加载/摘要级的 Codex 终态 items 不能覆盖完整直播条目，完成后需核对权威完整历史再释放 Host busy 状态。
默认保守的沙箱请求及审批路由必须与 Codex 返回的有效设置一致；审批缺失或失效不默认批准，
版本不匹配在进入会话前拒绝，不自动下载或升级二进制。

## 备选方案

- 把 Codex 当作 Native streamFn：拒绝，会形成两套循环、压缩、重试和终态所有权。
- 一次性替换 Native 与会话数据：拒绝，破坏旧会话和多模型兼容，也难以隔离回归。
- 先实现全部 Desktop Port 的空壳：拒绝，违反能力真实性，审批/历史错误后果较高。
- 新建 workspace 包：本阶段没有必要，现有 runtime-node 已拥有 Node 外部运行时资源生命周期。
- 复制一份 Codex transcript 到 Native Repository：拒绝，两份历史难以保持一致，只保留关联索引和可重建投影。

## 后果与后续门禁

增加一个公共子路径及其类型，不引入依赖；新增的关联索引有独立 schema，不修改现有会话格式。
单会话独占进程更易隔离故障，但有启动与内存成本；多会话共享池需要另行证明身份隔离后再考虑。
租约只协调遵守该合同的 Vetta 客户端，不能拦截独立 Codex 客户端；配置指纹不等于实际账号认证身份。
显示兼容消息的 unavailable 用量与 runtime 模型标识不能计入 Native 模型用量账本。

协议替身测试不证明任何发布版 Codex 已兼容。桌面可用前仍需完成实际 Composition Root/IPC、能力开关、
审批和认证界面、版本化 binary/schema 兼容矩阵，以及真实二进制/Electron 验证。
实际 RuntimeHost 与文件租约集成测试已补充但本环境未执行；全仓类型、格式和架构门禁未完成。
本地沙箱不是对外部 MCP/插件副作用的保证；这部分必须在桌面能力门禁中明确。

参见 [路线与验收](../runtime/runtime-roadmap.md)、[适配器说明](../runtime/codex-app-server.md)
和 [RuntimeHost 后端说明](../runtime/codex-host-backend.md)。本决策沿用 ADR-0077 的 Agent/Runtime/Product
所有权划分，不将外部 Agent Loop 再实现一遍。
