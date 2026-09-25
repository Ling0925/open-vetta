# Codex 原生集成验证入口

本轮基于 `Ling0925/open-vetta@ab9f6f1`，补齐此前一直缺少的可重复验证链路。
本页说明的是已提交的检查与本轮实际执行情况，不是宣布完整验收通过。

## 两条独立检查

`.github/workflows/codex-runtime-validation.yml` 仅允许本 fork 的代码运行，无发布、合并、推送或生产权限，
使用 `contents: read` 和不保留凭据的 checkout。既有 quality 工作流及其检查标准没有被删除或放宽。

### Native 合同与桌面回归

复用仓库固定 Bun 版本、冻结依赖安装 action、`test:pkg` 与 `run-vitest.mjs`，不转换成 node:test。
先执行 runtime-node 全包（含真实 RuntimeHost/文件租约测试），再执行 Codex Desktop 的控制器、
React/DOM、IPC、preload 和退出清理测试，最后执行原有 `bun run check`。依赖安装成功时，
即使行为测试失败，质量检查也会运行；任一检查失败都保留失败状态。

补充两个 Vitest 配置的 `@vetta/runtime-node/codex-app-server` 源码映射，避免依赖旧 dist 或让包级通配
映射错误吞掉新入口。runtime-node 同时固定包内 root，从根目录指定它的 config 不再扩散收集整个仓库。
没有删除测试、缩小覆盖率分母或启用 passWithNoTests。

### 真正 Codex 程序的合同

独立作业固定安装 OpenAI 发布的 `@openai/codex@0.157.0`，放在 runner 临时目录，不修改 workspace
依赖或用户机器上的 Codex 安装。这是本轮选定的兼容性候选，不代表已经验证的支持版本，更不是自动追随 latest。

执行路径：真实 RuntimeHost → 真实 CodexRuntimeHostBackend → 真实 Codex 子进程 → 本机 Responses
测试服务。只替换模型服务，Host、文件锁、stdio、Agent Loop、shell 工具和历史恢复都不使用替身。
固定测试指令只输出 `VETTA_CODEX_TOOL_OK`，不修改工作文件；所有项目、home、历史和令牌都是独立临时数据。
测试不使用 ChatGPT 登录或用户的网关密钥，不访问付费模型。

连续场景为：新建会话 → 流式工具调用 → 实际执行只读 shell 指令 → 工具结果回传 → 最终答复 →
关闭会话 → 按原路径恢复权威历史 → 追问 → 暂停测试服务回复 → 停止并确认终态和 HTTP 断开。
协议、沙箱、工具 schema、终态或恢复不兼容时必须失败，不通过替换成 mock 或扩大权限使之通过。

此作业使用 Linux network namespace，仅开启 loopback，随后降权到 runner 用户并清空继承环境，
才运行仓库测试代码。测试还检查系统网络接口，发现非 loopback 接口会拒绝执行。
隔离不可用时直接失败，绝不改成联网运行。Codex home 与系统 HOME 均为新建临时目录。

普通包测试默认跳过 real-binary 用例；专门作业设置 `VETTA_CODEX_TEST_REQUIRED=1`，缺少程序路径时
直接失败，不能以 skip 充当真实程序通过。安装和依赖构建发生在隔离前，模型/工具验证发生在隔离内。
工作流只上传 JUnit 测试报告，不上传认证目录、完整协议 dump 或 Codex 历史。

## 本轮实际完成的验证

本地容器无法解析 GitHub/npm 域名，没有完整工作区依赖或 Bun；当前连接的可执行工作区是另一个 WMS 项目，
未对它执行命令或改动文件。因此，本轮没有在本地运行原生 Vitest、真实 Codex 或 Electron。

实际运行：测试服务自身的 6 项行为测试通过，验证了流式终态、工具请求/回传、认证拒绝、
不支持工具拒绝、断流和额外重试拒绝。运行实际 TypeScript 转译代码，仅将该测试文件的 Vitest 注册替换为
node:test；它验证测试设施，不是 Codex 运行时通过。测试服务模块定向严格 TypeScript 检查通过，
新 TS 文件语法转译、工作流 YAML 解析和 shell 步骤语法检查通过。

两份旧 Vitest 配置已按远端 Git blob SHA 核对，修改只有新入口映射和 runtime-node 的 collection root。
本轮不累计之前 54 项测试的历史通过数。工作流是否已执行、原生/真实程序是否通过，以本提交的 Actions
实际记录为准；没有运行记录不能算通过，也不能据此断定具体权限或仓库设置。

## 合并门槛

必须分别取得 Native 合同、真实 binary 合同和原有 quality 检查的真实结果。任意失败先修复并重跑，
不能以这次增加 CI 文件代替检查通过。该 workflow 不会自动合并 PR，也不改变默认 Native 引擎。
Windows/macOS 的真实进程清理、Electron 跨窗口/打包/视觉验收、用户实际网关兼容性，以及 R1–R6
尚未完成的功能仍需独立验证。本轮没有新增生产运行时功能或改变权限。
