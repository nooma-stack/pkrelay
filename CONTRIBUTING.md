# Contributing to PKRelay

Thanks for your interest in contributing! PKRelay is an open-source AI browser bridge — issues, pull requests, and ideas are all welcome.

## Ways to contribute

- **Report bugs** — open an issue with reproduction steps, browser version, OS, and relevant logs.
- **Suggest features** — open an issue describing the use case and what problem it solves.
- **Fix bugs / add features** — see "Development setup" below and open a pull request.
- **Improve docs** — README, setup guides, tool reference, architecture doc.

## Development setup

### Prerequisites

- Node.js **20+**
- A Chromium-based browser (Chrome, Arc, Edge, or Brave)

### Clone and install

```bash
git clone https://github.com/nooma-stack/pkrelay.git
cd pkrelay/mcp-server
npm install
npm run build
```

### Link the local build globally

```bash
cd mcp-server
npm link            # symlinks /usr/local/bin/pkrelay → your local dist/index.js
pkrelay install     # registers the native-messaging host with your browser(s)
```

After linking, any rebuild (`npm run build` or `npm run dev` for watch mode) takes effect immediately — no reinstall needed.

### Load the extension

1. Open `chrome://extensions` (or `arc://extensions`, `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `extension/`.
4. Copy the extension ID shown on the card.
5. Edit the native-messaging manifest in your browser's `NativeMessagingHosts/` directory to add your extension ID to `allowed_origins`.

See [`docs/SETUP.md`](docs/SETUP.md) for full install details.

## Project layout

```
pkrelay/
├── extension/        Chrome MV3 extension (service worker, options page, popup)
├── mcp-server/       TypeScript MCP server (published as @nooma-stack/pkrelay)
│   ├── src/          TS sources
│   └── dist/         Build output (published to npm)
├── native-host/      Launcher that Chrome native-messaging invokes;
│                     ensures the broker daemon is running
└── docs/             Setup, tools, architecture, and planning docs
```

The **broker daemon** (a running `pkrelay --daemon` process) is the central piece. The extension connects via native messaging; MCP clients (Claude Code, Cursor, etc.) connect via WebSocket. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full picture.

## Development workflow

1. **Fork** the repo and create a feature branch from `main`.
2. **Make your changes** — keep commits focused; one logical change per commit.
3. **Type-check** with `npx tsc --noEmit` in `mcp-server/` — CI runs this on every PR.
4. **Test manually** — load the extension, attach to a tab, and exercise the tools you touched via your MCP client or with `curl`-style WebSocket requests to the broker.
5. **Open a pull request** — explain what changed and why. Link any related issues.

## Commit message style

We loosely follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Use for |
|--------|---------|
| `feat:` | New user-facing feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `chore:` | Housekeeping (deps, tooling, meta) |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `test:` | Adding or updating tests |
| `ci:` | CI/CD changes |

Scope is optional but useful — e.g. `fix(mcp): ...`, `feat(extension): ...`.

## Code style

- **TypeScript strict mode** — no `any` unless you can justify it in a comment.
- **Explicit error handling** — surface errors to callers with actionable messages; don't swallow them silently.
- **No new runtime dependencies without discussion** — the package is deliberately small.
- **Comments explain *why*, not *what*** — the code shows what it does; the comment should capture intent or a non-obvious constraint.

## Testing

PKRelay is primarily tested through manual browser flows, since the core functionality exercises the browser, native messaging, and WebSocket layers end-to-end. When adding a tool:

- Verify it works against a real page (not just a unit test).
- Confirm error paths (tab not attached, element not found, timeout) produce clear messages.
- Check that the snapshot/screenshot output stays token-efficient.

Unit tests for pure logic (tunnel-manager key generation, snapshot token counting, etc.) are welcome — drop them under `mcp-server/src/__tests__/` using any lightweight runner (Node's built-in `node:test` is fine).

## Reporting security issues

**Do not open a public issue for security vulnerabilities.** Instead, email the maintainers (contact listed on the [GitHub org page](https://github.com/nooma-stack)) or open a private security advisory via GitHub's "Security" tab on the repo.

## Code of conduct

Be kind, be constructive, assume good faith. Harassment, discrimination, or bad-faith behavior in issues, PRs, or discussions will result in removal.

## License

By contributing, you agree that your contributions will be licensed under the repository's [MIT License](LICENSE).
