# Contributing to Modus

Thanks for taking the time to improve Modus. Bug reports, focused fixes, and practical feature proposals are welcome.

## Before opening an issue

- Search existing [issues](https://github.com/Stoltembergg/modus/issues) and [discussions](https://github.com/Stoltembergg/modus/discussions) to avoid duplicates.
- For a bug report, include your operating system, Modus version, steps to reproduce, expected behavior, actual behavior, and relevant logs or screenshots. Remove API keys, tokens, and private project data before sharing logs.
- For a feature request, explain the user problem and the workflow you want to improve. A proposed implementation is optional.

## Development setup

Requirements:

- Node.js `>= 22.19.0`
- npm
- Recent stable Rust + Cargo (edition 2024)
- Git

```bash
git clone https://github.com/Stoltembergg/modus.git
cd modus
npm install
npm run dev
```

Open a workspace and configure a model provider in Settings to try the app.

## Checks before a pull request

Run the checks relevant to your changes:

```bash
npm run check
npm run test
npm --workspace @modus/desktop run build
```

If you modify release packaging or the Rust PTY host, also run the package command for your OS:

```bash
npm --workspace @modus/desktop run package:win -- --publish never
npm --workspace @modus/desktop run package:mac -- --publish never
npm --workspace @modus/desktop run package:linux -- --publish never
```

Packaging is platform-specific. Note in your PR which commands you ran and any checks you could not run.

## Pull request expectations

- Keep each PR focused and small enough to review.
- Explain the user-visible problem and the change.
- Add or update tests when behavior changes.
- Include screenshots or a short recording for UI changes when useful.
- Document security-sensitive behavior, permission changes, and new external network calls.
- Do not include API keys, access tokens, personal project data, or generated build artifacts.
- Follow Conventional Commits for commit messages.

## Security reports

Do not post exploitable vulnerabilities or secrets in public issues. Follow [SECURITY.md](./SECURITY.md) for private reporting instructions.
