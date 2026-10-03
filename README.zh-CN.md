<p align="center">
  <a href="./README.md">English</a> | 简体中文
</p>

<p align="center">
  <img alt="Modus logo" src="./docs/media/modus-logo.png" width="96" height="96">
</p>

<h1 align="center">Modus</h1>

<p align="center">
  面向 AI coding agent 的本地优先桌面工作区。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#功能">功能</a> ·
  <a href="./docs/architecture/desktop-security.md">安全</a>
</p>

![Modus desktop UI](./docs/media/modus-ui.png)

## 简介

Modus 是一个开源桌面应用，用于在真实的本地项目中运行 AI coding agent。

打开 workspace，连接你自己的模型 provider，进行 plan 或 build，检查改动，审批高风险操作，并把完整工作流留在同一个窗口里。

Modus 仍处于早期阶段，目前最适合从源码运行。

## 功能

- **Workspaces 与 sessions** - 打开本地项目，切换最近 workspace，固定项目，并按仓库保留独立 agent session。
- **自带模型** - 配置内置或自定义 PI 兼容 provider、默认模型、reasoning effort、thinking 变体和模型限制。
- **Git 工作流** - 查看工作区改动、文件 diff、分支、提交历史、commit、push，以及 session 变更统计。
- **终端、浏览器和文件** - 使用真实 PTY 终端、带标签页和 DevTools 的应用内浏览器，以及 workspace 文件浏览器。
- **Fast Codebase** - 让 agent 先构建紧凑的本地代码地图，再读文件，减少广撒网式的 grep/read。
- **Subagents** - 创建专项 subagent，跟踪其活动，并 apply 或清理它们的 worktree。
- **Plan 与 build 模式** - 先产出可审阅计划，回答结构化问题，再进入实现。
- **上下文与图片** - 附加文件、文件夹、文档、Git diff、终端输出、浏览器状态、页面选中元素、规则和图片。
- **MCP、skills 和 rules** - 加载 Modus MCP server，用 `/` 调用本地 skill，并应用来自 AGENTS/Claude/Cursor 风格文件的项目规则。
- **权限化执行** - 将 shell、Git、浏览器、MCP、文件和外部操作汇入统一审批流。
- **Checkpoints 与回滚** - 在 agent 运行前快照 workspace，并在需要时从时间线恢复。

## 仓库结构

```text
apps/desktop/     Electron 产品（main / preload / renderer）
crates/pty-host/  Rust PTY sidecar（modus-pty-host）
catalog/          生成的模型 provider 目录
docs/             架构说明与媒体资源
scripts/          模型目录生成脚本
```

桌面应用自包含在 `apps/desktop` 下。共享类型与工具位于 `apps/desktop/src/shared`，不在独立 workspace 包中。

## 快速开始

需要：

- Node.js `>= 22.19.0`
- npm
- Rust + Cargo（较新的 stable；crate 使用 edition 2024）
- Git

```bash
git clone https://github.com/Stoltembergg/modus.git
cd modus
npm install
npm run dev
```

然后打开一个 workspace 文件夹，并在 Settings 里配置模型 provider。

## 开发

```bash
npm run dev
npm run test
npm --workspace @modus/desktop run typecheck
npm --workspace @modus/desktop run build:pty
npm --workspace @modus/desktop run build
```

`npm run check` 会运行 Biome 与 workspace typecheck。Biome 格式/lint 在部分分支上仍可能报告既有问题；在格式清理合入前，本地以 `typecheck` + `test` 作为门禁更稳妥。

本地打包：

```bash
npm --workspace @modus/desktop run package:win -- --publish never
npm --workspace @modus/desktop run package:mac -- --publish never
npm --workspace @modus/desktop run package:linux -- --publish never
```

在对应操作系统上运行匹配的打包命令。

## MCP 配置

Modus 只会自动读取自己的 MCP 配置：

```text
~/.modus/mcp.json
<workspace>/.modus/mcp.json
```

它不会静默导入 Cursor、Claude、Warp 或其它 Agent 工具的配置。

## 技术栈

Electron、React、TypeScript、Tailwind CSS、Base UI、Motion、Monaco、xterm.js、Streamdown、Node SQLite、Rust `portable-pty`、`@earendil-works/pi-coding-agent` 和 MCP SDK。

## 贡献

欢迎贡献。请保持 PR 小而清晰，使用 Conventional Commits，并在提交前运行 `npm run test` 和 `npm --workspace @modus/desktop run typecheck`。

## License

Apache-2.0。见 [LICENSE](./LICENSE)。
