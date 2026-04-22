# @nooma-stack/pkrelay

[![npm](https://img.shields.io/npm/v/@nooma-stack/pkrelay)](https://www.npmjs.com/package/@nooma-stack/pkrelay)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP server for **PKRelay** — a token-efficient AI browser bridge. Pair this package with the [PKRelay Chrome extension](https://github.com/nooma-stack/pkrelay) to give any MCP-compatible AI tool (Claude, Cursor, Windsurf, local models) structured browser perception and full page control.

## What you get

- **Token-efficient snapshots** — structured page representations (headings, forms, buttons, links) instead of raw HTML, 10–50× fewer tokens.
- **Element-targeted screenshots** — crop screenshots to specific elements or regions so vision models see only what matters.
- **Full browser control** — click, type, navigate, evaluate JS, monitor console/network, manage tabs.

## Install

```bash
npm install -g @nooma-stack/pkrelay
pkrelay install   # registers the native-messaging launcher with your browser(s)
```

You also need the companion Chrome extension. See the [main repo](https://github.com/nooma-stack/pkrelay) for extension install steps (unpacked or Chrome Web Store when available).

## Configure your AI tool

**Claude Code** (`~/.claude.json`):

```json
{
  "mcpServers": {
    "pkrelay": {
      "command": "pkrelay"
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "pkrelay": {
      "command": "npx",
      "args": ["-y", "@nooma-stack/pkrelay"]
    }
  }
}
```

## Tools exposed over MCP

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Token-efficient structured representation of the current page |
| `browser_screenshot` | Screenshot, optionally cropped to an element or region |
| `browser_click` | Click by CSS selector, visible text, or snapshot index |
| `browser_type` | Type into an input, optionally clear/submit |
| `browser_select` | Pick an option from a `<select>` |
| `browser_navigate` | Navigate to a URL, or go back/forward/reload |
| `browser_evaluate` | Execute JavaScript in the page |
| `browser_wait` | Wait for an element, text, or network idle |
| `browser_console` | Recent console messages (errors, warnings, logs) |
| `browser_network` | Captured network requests, filterable by URL/method/status |
| `browser_tabs` | List open tabs with attachment status |
| `browser_tab_attach` | Attach the debugger to a tab (required before other tools) |
| `browser_tab_detach` | Detach the debugger from a tab |
| `browser_tab_switch` | Switch to a tab by id or title |

See [`docs/TOOLS.md`](https://github.com/nooma-stack/pkrelay/blob/main/docs/TOOLS.md) for full parameter reference.

## Requirements

- Node.js **20+**
- A Chromium-based browser (Chrome, Arc, Edge, Brave)
- The [PKRelay Chrome extension](https://github.com/nooma-stack/pkrelay)

## Architecture

```
AI Tool (Claude, Cursor, etc.)
    ↓ MCP (stdio)
pkrelay MCP server (this package)
    ↓ WebSocket
pkrelay broker daemon
    ↓ Chrome Native Messaging
PKRelay Chrome extension
    ↓ chrome.debugger (CDP)
Browser tab
```

Full design in [`docs/ARCHITECTURE.md`](https://github.com/nooma-stack/pkrelay/blob/main/docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
