# 快速开始

<p align="center"><a href="QUICKSTART.md">English</a> · <b>简体中文</b></p>

两条路：安装现成构建，或从本仓库跑桌面应用。

## 直接使用

macOS、Windows、Linux 安装包：

**→ [www.openvetta.com/download](https://www.openvetta.com/download)**

官方安装包发布在官网 CDN。本仓库提供源码。安装后引导会带你配置模型（BYOK）和权限。产品文档：[docs.openvetta.com](https://docs.openvetta.com)。

从源码检出得到的是 **lite** 构建：无 Vetta 登录、无订阅，密钥留在本机。官方安装包可能是 **full** 构建。两种形态见[构建模式](docs/desktop/build-modes.md)。

## 从源码开发

需要 **Bun 1.3+** 和 **Node 20+**。支持 macOS、Windows、Linux。

```bash
git clone https://github.com/openvetta/open-vetta.git
cd open-vetta
git checkout dev
bun install
```

### 桌面应用

```bash
cd apps/desktop
bun run dev
```

会同时启动 Vite renderer、主题开发服务器和 Electron。默认与已安装应用共用 `~/.vetta` 数据，启动前先退出正式版；开发操作可能改写真实数据。需要隔离数据时使用 `dev:isolated`。

| 命令 | 数据根 | 什么时候用 |
|---|---|---|
| `bun run dev` | `~/.vetta` | 默认：使用本机真实用户数据调试 |
| `bun run dev:isolated` | `~/.vetta-dev` | 需要与正式版数据隔离 |
| `bun run dev:home` | `~/.vetta` | 与默认入口相同，保留兼容 |

仓库**根目录**的 `bun run dev` 只监视核心库，不会启动应用。

### 文档站

```bash
bun run --cwd apps/docs-site dev
```

默认 `http://127.0.0.1:4321`。公开文档在 `apps/docs-site/content/docs/`。

### 实际会跑的检查

```bash
bun run check:quick        # 对改动文件跑 Biome + 架构守卫
bun run check              # 开 PR 前：lint + 类型 + 守卫
bun run test:pkg ai        # 单包；`bun run test:pkg --list` 查看包名
```

不要直接跑 `bun test`。Windows 上会用错 runner；请用 `bun scripts/quality/run-vitest.mjs --run <file>` 或 `bun run test:pkg`。

打包、环境变量和 lite/full 开关：[构建模式](docs/desktop/build-modes.md)。贡献地图和 PR 门槛：[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。
