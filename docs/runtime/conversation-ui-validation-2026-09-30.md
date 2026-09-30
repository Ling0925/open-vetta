# 会话 UI/UX 一致性修复验证

日期：2026-09-30。基线：`ae8e9e81f2e701ad2ef3dedb9e2d1d291764666a`。

## 结论

本批修复会话显示错乱的状态与定位问题，保留原有视觉风格、100 ms 流式批处理、memo 和虚拟列表。
这不是完整产品发布验收，也不代表已经证明所有卡顿或视觉问题消失。

已用可失败回归确认并修复：

1. 上一轮或压缩操作的迟到历史响应覆盖新一轮；现在校验请求代际、输入/队列进度与当前会话归属。
2. 轮末性能补丁只看消息形状、一直保留 live blocks，导致 final-only 或缺失 delta 时正文、思考、工具结果不能补齐；现在依据实际内容与身份对账。
3. 切回运行中的长会话时，完整历史加载只保留“新增 ID”，抹掉已有 ID 的实时更新；现在保留新的文字、工具结果与结束状态，合并文字不跨工具边界。
4. 兼容协议将文字/思考分桶，改变同一批事件的顺序；现在仅合并相邻同类片段。原生 raw assistant 的有序归约保持不变。
5. 旧页面排队的滚动/目录帧污染新会话；返回分叉来源时尾部预览过早消费定位请求。现在绑定会话和目标、取消过期帧，并等待目标与列表就绪。

历史证据说明其中部分问题与性能改动相关：`7b466b79a` 的轮末 live-history patch、`4a4fe5bdb` 的延迟布局读取。
不能据此把所有问题都归咎于某一次性能优化。恢复历史的增量合并问题也有独立生命周期原因。

## 验证结果

- 明确列出的 47 个 Desktop 测试文件：**282/282 通过**，使用 2 个 worker，无新增跳过或放宽超时。
- 真实 event controller → Jotai → MessageList → Virtuoso → 工具卡片夹具：**4/4 通过**。
- 夹具独立类型检查与 Vite 构建通过；构建保留较大语法高亮资源块的体积警告，未修改警告阈值。
- Root、CLI、Desktop、Docs、Mobile 类型检查完成；Root/Desktop 使用独立资源受控运行取得有效通过结果。
- 本次改动 `check:quick` 与全架构/私钥/冲突等 guards 通过，`git diff --check` 通过；另对根配置未默认纳入的 8 个 TSX 文件显式执行同规则检查，格式整理后重跑 17 项相关回归通过。
- 完整 `check` **不是全绿**：全仓 Biome 仍有 **117 errors、1 warning、2 infos**；JSON 诊断与 Git 改动路径对照后，本次修改文件没有这些诊断。未批量格式化无关文件。

首次大并发验收中出现 SIGKILL/137、测试 worker 通信中断及首例超时引起的连锁失败，不计为有效通过结果。
随后使用相同明确文件列表低并发重跑。两处会话切换测试补齐了真实异步边界/释放 API；子代理卡片测试改为按“打开”按钮的可访问名称定位，避免把新增的“停止”按钮当成原来的第一个按钮。

## 复跑

安装锁定依赖并完成所需 workspace 构建后，在仓库根目录执行。使用隔离 HOME，不载入真实模型凭据。
47 个文件的固定列表见 [conversation-ui-test-files.json](./conversation-ui-test-files.json)：

```sh
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = JSON.parse(readFileSync("docs/runtime/conversation-ui-test-files.json", "utf8"));
const result = spawnSync(process.execPath, ["scripts/quality/run-vitest.mjs", "--run", "--config", "apps/desktop/vitest.config.ts", "--maxWorkers=2", "--minWorkers=1", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
'
```

夹具运行、4 个组件检查及浏览器人工步骤见 [README](../../apps/desktop/test/fixtures/conversation-ux/README.md)。
状态约束见 [conversation-ui-consistency.md](./conversation-ui-consistency.md)。

## 尚未验证与限制

- 本轮受管浏览器阻止 loopback 预览（`ERR_BLOCKED_BY_CLIENT`），没有真实浏览器截图、像素布局、滚轮追尾或动画性能结论；没有改安全设置或用替代路线绕过。
- jsdom 中的 600px 测量与 Virtuoso mock 只用于验证实际组件接线和状态，不代表真实布局验收。
- 未运行真实 Provider、用户账户、打包 Electron、Windows/macOS 实机或全仓测试。
- 如果分叉来源消息永久不存在，会保留目标会话私有的待定位请求；不猜测落点，不阻塞发送，也不跳到其他会话。
