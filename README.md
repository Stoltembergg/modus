<p align="center">
  English · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./docs/media/modus-logo.png" alt="Modus logo" width="80" height="80">
</p>

<h1 align="center">Modus</h1>

<p align="center">
  A minimal desktop workspace for AI-assisted development.<br>
  Your projects. Your models. One place to work.
</p>

<p align="center">
  <a href="https://github.com/Stoltembergg/modus/releases/latest"><img src="https://img.shields.io/github/v/release/Stoltembergg/modus?style=flat-square&amp;color=8b5cf6" alt="Latest release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-8b5cf6?style=flat-square" alt="Apache 2.0 license"></a>
</p>

<p align="center">
  <a href="#download">Download</a> ·
  <a href="#what-you-can-do">Features</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="./CONTRIBUTING.md">Contribute</a>
</p>

![Modus desktop workspace with project navigation and the prompt composer](./docs/media/modus-ui.png)

Open a project, choose your model, and describe the result you want. Modus brings the conversation, agent tools, code, terminal, browser, and Git into one desktop workspace, with activity available when you need to inspect it.

## Download

**[Get the latest stable release →](https://github.com/Stoltembergg/modus/releases/latest)**

Choose the installer for your system from the release assets:

| Platform | Architecture | Package |
| --- | --- | --- |
| Windows | x64 | `.exe` installer |
| macOS | Apple Silicon or Intel | `.dmg` for your architecture |
| Linux | x64 | `.AppImage` or `.deb` |

Windows installers are unsigned; macOS builds are ad-hoc signed and not notarized. Your OS may require confirmation on first launch. See [signing and update details](./docs/releasing.md#unsigned-builds).

## What you can do

- **Choose your models.** Connect supported providers, configure custom compatible endpoints, or use account-backed Modus models when signed in. You control the model, provider, and available reasoning settings.
- **Plan, then build.** Develop a reviewable plan, answer structured questions, and move into implementation. The built-in `define-goal` skill can keep an objective, completion criteria, and evidence attached to a session.
- **Work with agents.** Reuse agents with animated avatars, delegate to specialized subagents, review their worktrees, or collaborate in Agent Groups with a coordinator and shared conversation.
- **Keep the project in context.** Attach files, folders, images, documents, diffs, terminal output, browser state, and selected page elements. Fast Codebase provides a local code map; project memory and context compaction help carry work across turns.
- **Review and act in one window.** Browse files, inspect changes and commit history, switch branches, commit or push, use a PTY terminal, and open the integrated browser with tabs and DevTools. Workspace checkpoints support restoration from the timeline.
- **Extend your workflow.** Configure MCP servers and connected apps, invoke skills with `/`, and apply project instructions from supported AGENTS, Claude, and Cursor rule files. REA adds reverse-engineering tools when its runtime and analysis providers are available.
- **Keep the interface yours.** Use light, dark, or system appearance, configurable transparency, and an English or Brazilian Portuguese interface with a live language selector.

The Harness coordinates context, task state, verification evidence, and recovery behind the conversation. Session data is stored locally. Model requests go to the provider you select, and enabled integrations can communicate with their respective services.

## Start working

1. Open a local project or start a standalone chat.
2. Select your model and connect its provider in **Settings → Model & Provider**. Modus account features are in **Settings → Account**.
3. Send your prompt in **Build**, or switch to **Plan** first. Review changes and activity as the agent works.

Approval settings are available globally and per project in **Settings → General**.

## Local models and integrations

### Local tool filter

RERANK-03 uses ONNX Runtime on CPU in a separate model process to rank the tools a request is likely to need. Core tools stay available, and the agent can expand the selection. If the model is unavailable, busy, or too slow, Modus sends the full allowed tool set.

The filter is **enabled by default on supported machines** and prepares in the background. Its first setup downloads approximately **415 MB** of model, tokenizer, and license files, checked against pinned SHA-256 hashes. Inference runs locally after setup. Turn it off or cancel the download in **Settings → General → Local tool filter**.

Local tool filtering is unavailable on Intel Macs. Windows requires the Microsoft Visual C++ Redistributable (2015–2022). The coding model and provider remain the ones you choose.

### REA

REA is enabled by default and starts on the first REA tool call. It requires Node.js and npm on the app's `PATH`; the pinned runtime supports Node **22.19+ in the 22.x series**, **24.11+ in the 24.x series**, or **26+**. Analysis engines such as Ghidra, IDA, and JADX have their own setup requirements.

On first use, Modus installs REA's pinned npm dependency tree with install scripts disabled. REA runs with your normal user permissions, without a separate approval prompt for each call; its session process is not a sandbox. You can disable it in **Settings → MCP & Integrations**.

### MCP, connected apps, and skills

Configure integrations in **Settings → MCP & Integrations**. Modus reads its MCP server configuration from:

```text
~/.modus/mcp.json
<workspace>/.modus/mcp.json
```

MCP configuration from other apps is not imported automatically. Connected-app authentication uses Composio when configured. Manage skills and project rules in their respective Settings sections.

See the [desktop security baseline](./docs/architecture/desktop-security.md) and [security policy](./SECURITY.md) for the current boundaries and reporting process.

## Build from source

You need **Node.js 24 LTS** (recommended; repository minimum `22.22.3`), npm, Git, and a recent stable Rust/Cargo toolchain with edition 2024 support. Native builds also require your OS's C/C++ build tools.

```bash
git clone https://github.com/Stoltembergg/modus.git
cd modus
npm ci
npm --workspace @modus/desktop run prepare:fast-codebase
npm --workspace @modus/desktop run build
npm run dev
```

The initial build creates the native PTY and supervisor binaries. For subsequent application changes, use `npm run dev`; rebuild the relevant native component after Rust changes.

<details>
<summary><strong>Development commands and installer builds</strong></summary>

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the desktop development app |
| `npm run check` | Run Biome and workspace TypeScript checks |
| `npm --workspace @modus/desktop run build` | Build desktop assets and native components |
| `npm --workspace @modus/desktop run build:pty` | Rebuild the PTY host |
| `npm --workspace @modus/desktop run build:rea-supervisor` | Rebuild the REA supervisor |

Run targeted tests for the code you change. See [Contributing](./CONTRIBUTING.md) and the [CI configuration](./.github/workflows/ci.yml) for the existing checks. Security probes and adversarial workflows retain their manual authorization gates.

Build the app, then run **one** package command on its matching operating system:

```bash
npm --workspace @modus/desktop run build

# Windows
npm --workspace @modus/desktop run package:win -- --publish never

# macOS
npm --workspace @modus/desktop run package:mac -- --publish never

# Linux
npm --workspace @modus/desktop run package:linux -- --publish never
```

Installers are written to `apps/desktop/dist/`. Release automation, update channels, and signing limitations are documented in [Releasing Modus](./docs/releasing.md).

</details>

## Repository

| Path | Contents |
| --- | --- |
| `apps/desktop/` | Electron app: main process, preload bridge, React UI, and shared contracts |
| `apps/site/` | Website and billing pages |
| `crates/` | Rust PTY host, REA supervisor, and plugin isolation components |
| `catalog/` | Generated model and provider catalog |
| [`docs/db/`](./docs/db/README.md) | Account and billing backend, migrations, functions, and tests |
| `scripts/` | Catalog generation and development utilities |
| `docs/` | Architecture, security and release notes, and media |

Built with Electron, React, TypeScript, the Pi SDK, Rust, SQLite, ONNX Runtime, Tailwind CSS, Monaco, xterm.js, and the MCP SDK.

## Contribute

Read [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and PR expectations. Use [issues](https://github.com/Stoltembergg/modus/issues) for bugs and feature requests, and follow [SECURITY.md](./SECURITY.md) for private vulnerability reports.

## License

Modus is licensed under [Apache-2.0](./LICENSE). Bundled components and built-in skills retain their own licenses; see [Third-party notices](./THIRD_PARTY_NOTICES.md).
