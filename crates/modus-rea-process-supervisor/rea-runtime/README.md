# Locked REA runtime

`modus-rea-process-supervisor` embeds `package.json` and `package-lock.json` from this
directory (`include_str!`). On the first approved REA call it copies them into a private
staging directory under `<userData>/rea/runtime/`, runs

```
npm ci --ignore-scripts --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error
```

(through `cmd.exe /d /s /c` on Windows, because `npm` is a `.cmd` shim there), atomically
renames the result to `rea-agents-<version>-<lock hash>/`, and runs
`node <dir>/node_modules/rea-agents/scripts/rea.mjs mcp`. Later starts reuse that directory.
Downloads go to the private npm cache `<userData>/rea/npm-cache/`.

## Why

`npx -y rea-agents@6.5.0 mcp` pinned only the top-level package. `rea-agents` publishes no
`npm-shrinkwrap.json`, so its ~170 transitive packages were resolved on each user's machine
at first use, with install scripts enabled. A malicious release of any transitive dependency
would have run with the user's permissions. `npm ci` installs exactly this lockfile and fails
with `EINTEGRITY` if any tarball differs from its recorded sha512.

## Install scripts

All install scripts are off. Packages in the tree that declare one:

| Package | Script | Decision |
| --- | --- | --- |
| `frida@17.23.2` (optional dependency of rea-agents) | `node scripts/install.js`: `prebuild-install` downloads `frida_binding.node` from GitHub releases with no integrity check, else runs `make` | Not run. REA loads frida lazily, so only REA's Frida tools fail ("Could not locate the bindings file"); everything else works. |

`@lydell/node-pty` needs no build: it ships prebuilt binaries in per-platform optional
packages (`@lydell/node-pty-{darwin,linux,win32}-{x64,arm64}`), all locked here.
`playwright-core` has no install script (REA does not download browsers on install).

## Bumping rea-agents

1. Edit `package.json` (`"rea-agents": "<new>"`), then from this directory run
   `npm install --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org/`.
2. Check the new top-level integrity against the registry:
   `npm view rea-agents@<new> dist.integrity`, and update `REA_AGENTS_INTEGRITY` in
   `src/lib.rs` and `apps/desktop/src/main/mcp/rea-runtime-lock.test.ts`, plus
   `REA_AGENTS_VERSION` and `REA_SUPPORTED_NODE_RANGE` (rea-prerequisites.ts) if
   `engines.node` changed.
3. Review the lockfile diff. Any new `hasInstallScript` entry fails
   `rea-runtime-lock.test.ts`; decide whether it can stay off and record it above.
4. Run `cargo test -p modus-rea-process-supervisor` and the desktop vitest suite. A new
   lockfile gets a new install directory automatically (the name includes a hash of both
   files); old directories under `<userData>/rea/runtime/` are not deleted.
