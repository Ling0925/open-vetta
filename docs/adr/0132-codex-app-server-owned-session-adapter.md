# Codex App Server 以独占进程与会话适配器接入

## 状态

Proposed（R0.1 实现随 Draft PR 提交；桌面 Backend 尚未装配）

## 背景

Native runtime 的会话竞争与取消修复已通过 PR #1 合入。项目所有者希望优先接入完整 Codex runtime，
并逐步改进 Native 的执行边界。既有 RuntimeHost 有 Backend/Catalog 合同，但必需的历史、配置与模型 Port
不能用空成功实现填满，否则 UI 会显示实际不具备的能力。

## 决策

先在 `runtime-node` 增加实际拥有 Node 子进程的 `codex-app-server` 适配器：版本探测、NDJSON、双向 RPC、
Thread/Turn 映射、终态、审批与关闭。它不实现模型或工具循环，不改通用 Kernel，不拥有 Desktop 配置。
未来的平台组合通过 RuntimeHost Backend 接入；一条会话只由一个 runtime 管理权威历史。

第一阶段只开放开发者公共 API，不改变默认后端或旧会话路由。未知副作用状态使对象进入恢复状态，
禁止自动重放请求；取消回执不等于任务完成。默认保守的沙箱请求及审批路由必须与 Codex 返回的有效设置一致。
审批缺失或失效不默认批准，版本不匹配在进入会话前拒绝，不自动下载或升级二进制。

## 备选方案

- 把 Codex 当作 Native streamFn：拒绝，会形成两套循环、压缩、重试和终态所有权。
- 一次性替换 Native 与会话数据：拒绝，破坏旧会话和多模型兼容，也难以隔离回归。
- 先实现全部 Desktop Port 的空壳：拒绝，违反能力真实性，审批/历史错误后果较高。
- 新建 workspace 包：本阶段没有必要，现有 runtime-node 已拥有 Node 外部运行时资源生命周期。

## 后果与后续门禁

增加一个公共子路径，不引入依赖，不改持久化格式。单会话独占进程更易隔离故障，但有进程启动与内存成本；
多会话共享池需要另行证明身份隔离后再考虑。

协议替身测试不证明任何发布版 Codex 已兼容。桌面可用前需完成 Backend/Catalog、条目投影、能力矩阵、
审批和认证界面、版本化 binary/schema 兼容矩阵以及隔离真实二进制/Electron 验证。
本地沙箱不是对外部 MCP/插件副作用的保证；这部分必须在桌面能力门禁中明确。

参见 [路线与验收](../runtime/runtime-roadmap.md) 和 [适配器说明](../runtime/codex-app-server.md)。
本决策沿用 ADR-0077 的 Agent/Runtime/Product 所有权划分，不将外部 Agent Loop 再实现一遍。
