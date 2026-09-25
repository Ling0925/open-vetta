# Codex 桌面预览工作区（R0.3 接线切片）

## 当前状态与入口

本次基于已合并的 PR #2，在 R0.1/R0.2 后端上接入实际 Desktop IPC、preload 和 Renderer。
提交前确认主分支为 `3211f356`，本批改动另建桌面预览 PR，不再更新已合并的 PR #2。
这是**可进入的预览入口代码**，不是经过完整构建、真实 Codex 和 Electron 验收的正式后端。
此前文档中“桌面尚未接线”描述的是上一阶段；当前状态以本页和 PR 最新验收清单为准。

入口为 **新建会话 → 右上角「Codex 预览」**。复用 `/new-session?target=runtime:codex`，
在挂载 Native 会话模型和远程项目守卫之前分流到独立工作区。返回「返回 Native 新会话」清除该 target。
不改变 Native 默认、旧会话、团队、远程项目或统一聊天侧栏；预览目前单个主窗口只打开一个 Codex 会话。
这不是所有现有聊天页共用的 runtime 选择器，后续合流必须先通过当前隔离流程验收。

## 配置与实际操作

配置可信的本机 Codex 可执行文件、精确版本、独立且已配置认证的 Codex 目录、本地工作目录，
以及只读或工作区写入权限。文件与目录可通过原生选择器选择；保存需要原生窗口再次确认完整配置。
版本字段不会自动探测后填入“已认证版本”，必须对应后续实际验证的二进制；不会自动下载、安装或登录。
可执行文件来自宿主用户的选择，不来自聊天、项目或插件；不提供任意启动参数和原始 RPC 入口。

确认配置后，显式点击「新建 Codex 会话」才启动进程；进入页面、读取配置和列出会话不会调用模型。
也可从当前工作目录的已保存会话中选择并恢复。文本发送得到接受回执后，界面保持运行状态和停止按钮，
结果由后端终态和完整历史核对决定。重新进入页面可以查看正在运行的会话，不重复启动它。
关闭连接后可以恢复已保存历史，不自动重发之前的任务。

首次设置、进程准备、失败和断线时仍可编辑草稿。草稿按预览会话保存在 Renderer 的 Jotai 内存状态中，
路由切换不会串到 Native 会话；它**不保证跨应用重启保存**。只有任务成功且草稿未被再次编辑时才清空；
停止、失败或不确定的发送回执保留文字。发送 ID 的重复检测限当前控制器和会话，最近最多 128 项，
不是跨进程的持久化 exactly-once 协议，也不宣称实现了 R1 的完整输入提交模型。

## 权限、审批和窗口归属

新接口只接受注册时指定主窗口的主 frame、确切 Renderer URL 和当前页面令牌。
沿用原有 preload host-access 保护，并在主进程再次校验；webview、子 frame、其他窗口和远程浏览器不能调用。
命令使用严格允许字段；不提供 Native 工具、附件、自动重试、密钥共享或任意执行功能。

默认只读；工作区写入也不获得无限授权。命令/文件审批展示完整请求的纯文本，只有「拒绝」和「仅允许这次」。
最多同时 8 项，单请求超过 64 KiB 默认拒绝而不是截断后让人批准；55 秒未处理则拒绝。
批准绑定当前会话和输入身份，停止、关闭、超时、服务端取消或页面离开后失效，迟到的点击不能批准另一轮任务。

**离开预览页面不会自动停止已经开始的任务，但会立即撤销所有待处理审批，并拒绝新审批。**
需要停止时先点停止或关闭连接。Renderer 崩溃、整页重新加载和主 frame 文档导航会关闭所属会话进程；
清理失败成为重开屏障，不允许一边残留旧进程一边创建新所有者。Hash 路由导航不当作整页重载。
应用退出通过既有 quit cleanup 加入清理参与者，并等待同一份 Promise，不能只移除事件监听器。

Codex 目录中的实际账号、远端端点及 MCP/插件配置尚未通过 UI 做完整身份校验或白名单隔离。
本地沙箱不约束所有远端 MCP 副作用，页面明确提示这个限制；不要把只读选项当成整个生态的副作用保证。
固定二进制、实际账号显示、配置/插件能力验证和跨平台退出验收仍是正式启用前的门槛。

## 显示与资源边界

从 R0.2 的 ID 化历史投影取得快照，通知只携带实例和修订号，不在每个 Token 上推送整份历史。
Renderer 每次最多一个快照读取，更新通知合并为约 100 ms 的刷新；旧修订不能覆盖新状态，旧实例不能混入当前视图。
目前快照显示最近最多 200 项，每项最多 16000 字符，正文总量最多 256000 字符；截断和更早内容都有明确提示。
这些是预览显示限制，不修改 Codex 的权威会话文件。完整历史分页仍未提供。

消息、工具和审批都作为纯文本显示，不执行 HTML、Markdown 中的代码或工具输出中的链接。
状态以“准备中、运行中、正在停止、需重新连接”等明确文案呈现。错误只传有界的分类代码，
不把原始 Provider 响应、凭证或请求正文写入 IPC 异常/遥测。

## 实现边界

- `main/codex-workspace/`：配置、审批、命令准入、快照转换和 Electron 生命周期；复用现有版本化配置存储。
- `main/ipc/codex-workspace.ts`：薄桥接，不拥有业务规则。
- `preload/apis/codex-workspace.ts` 和共享 DTO：有限且类型化的桌面 API，不暴露底层 Codex RPC。
- `renderer/domains/codex-workspace/`：连接 Hook、异步视图客户端、配置和聊天 Recipe；使用现有按钮、输入和文本域。
- Jotai drafts 和 `codex` 中英文 namespace：状态和文案独立，接入现有导出及 i18n 合同。
- `NewSessionPage`：保留原 Native 结构，在入口选择阶段识别预览 target。

按“状态/行为在连接层、纯文本显示在视图”的边界实现，没有增加公共 Compound API、任意 ReactNode 插槽、
新的动画或 UI 依赖。新增 DOM 测试覆盖加载顺序、发送/停止、错误保留输入和审批显示，但尚未运行；
不以源码自审替代视觉、可访问性或 Electron 结果。

## 本轮真实验证记录

新增 52 项用例，其中 **46 项已离线执行通过，0 失败；6 项原生 Vitest/DOM/IPC 用例未执行**。
已执行的是实际新源码的 TypeScript 转译结果，仅将 Vitest 的测试注册替换为 Node 的 node:test：

| 范围 | 用例 | 本轮执行 |
| --- | ---: | --- |
| 桌面命令控制器 | 18 | 通过 |
| 审批生命周期 | 6 | 通过 |
| 输入和窗口/导航校验 | 6 | 通过 |
| 历史显示与大小限制 | 3 | 通过 |
| Renderer 视图客户端时序 | 8 | 通过 |
| preload 传输合同 | 2 | 通过 |
| 应用退出参与者 | 3 | 通过 |
| 真实 React 页面/Hook 与 jsdom | 4 | 未执行 |
| Electron IPC 注册边界 | 2 | 未执行 |

定向严格 TypeScript 检查覆盖控制器、校验/审批、Sender 策略、退出清理、Renderer 客户端、preload API
及其共享 DTO 依赖，通过；不包含 Electron 适配、React UI、真实后端包、构建和完整仓库类型。
全部本地目标 TS/TSX 已做语法转译检查；格式按 TypeScript 编辑器格式化，不等价于 Biome 门禁通过。
本轮没有重跑之前的 R0.1/R0.2 测试，不能把历史通过数相加成当前分支的通过数。

环境没有 Bun、完整 workspace 依赖、React/jsdom 和真实 Codex；GitHub 对上一提交查询未返回 Actions run。
因此原生包测试、原有 RuntimeHost/文件锁的两项集成、Biome/架构/全仓类型、打包构建、
真实二进制协议/认证、Electron E2E、macOS/Windows 进程退出和当前版本发布说明门禁均未完成。
PR 必须保持 Draft，不能将预览入口误报为生产可用。

完整检出环境应先运行：

```bash
bun run test:pkg runtime-node
bun scripts/quality/run-vitest.mjs --run --config apps/desktop/vitest.config.ts \
  apps/desktop/src/main/codex-workspace \
  apps/desktop/src/main/ipc/codex-workspace.test.ts \
  apps/desktop/src/main/quit-cleanup-participants.test.ts \
  apps/desktop/src/preload/apis/codex-workspace.test.ts \
  apps/desktop/src/renderer/domains/codex-workspace
bun run check
```

后续顺序：先补齐真实后端与桌面门禁、二进制/账号能力诊断，再评估合入共用聊天流程；
完成 Codex 可控可用后，再推进 R1–R6。暂不处理 Issues，不自动合并或改默认引擎。
