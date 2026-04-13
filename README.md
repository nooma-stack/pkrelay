# PKRelay

<!-- badges -->
[![CI](https://github.com/nooma-stack/pkrelay/actions/workflows/ci.yml/badge.svg)](https://github.com/nooma-stack/pkrelay/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@nooma-stack/pkrelay)](https://www.npmjs.com/package/@nooma-stack/pkrelay)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Token-efficient AI browser bridge. MCP server + Chrome extension for structured browser perception and control.

## What it does

- **Token-efficient snapshots** -- Get structured page representations (headings, forms, buttons, links) instead of raw HTML, using 10-50x fewer tokens.
- **Element-targeted screenshots** -- Crop screenshots to specific elements or regions so vision models see only what matters.
- **Full browser control** -- Click, type, navigate, evaluate JS, monitor console/network, and manage tabs through a unified MCP interface.

## Quick install

1. **Install the extension** -- Load `extension/` as an unpacked extension in Chrome/Arc/Edge (developer mode), or install from the Chrome Web Store (coming soon).

2. **Install the MCP server**
   ```bash
   npm install -g @nooma-stack/pkrelay
   pkrelay install   # registers native messaging host
   ```

3. **Add to your MCP config**

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

## Tool reference

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get a token-efficient structured representation of the current page |
| `browser_screenshot` | Capture a screenshot, optionally cropped to an element or region |
| `browser_click` | Click an element by CSS selector, visible text, or snapshot index |
| `browser_type` | Type text into an input field with optional clear/submit |
| `browser_select` | Select an option from a dropdown element |
| `browser_navigate` | Navigate to a URL, or go back/forward/reload |
| `browser_evaluate` | Execute JavaScript in the page context |
| `browser_wait` | Wait for an element, text, or network idle condition |
| `browser_console` | Get recent console messages (errors, warnings, logs) |
| `browser_network` | Get captured network requests filtered by URL/method/status |
| `browser_tabs` | List open browser tabs with attachment status |
| `browser_tab_attach` | Attach the debugger to a tab (required before other tools) |
| `browser_tab_detach` | Detach the debugger from a tab |
| `browser_tab_switch` | Switch to a tab by ID or title match |

See [docs/TOOLS.md](docs/TOOLS.md) for full parameter details and examples.

## How it works

```
AI Tool (Claude, Cursor, etc.)
    |
    | MCP protocol (stdio)
    v
PKRelay MCP Server (Node.js)
    |
    | Chrome Native Messaging (length-prefixed JSON)
    v
PKRelay Extension (service worker)
    |
    | Chrome DevTools Protocol (chrome.debugger API)
    v
Browser Tab
```

1. The AI tool sends MCP tool calls to the PKRelay server over stdio.
2. The server translates them into native messaging requests and sends them to the extension.
3. The extension uses the Chrome `debugger` API to execute commands on attached tabs.
4. Results flow back through the same chain.

## Browser support

| Browser | Status |
|---------|--------|
| Google Chrome | Supported |
| Arc | Supported |
| Microsoft Edge | Supported |
| Brave | Supported (uses Chrome extension paths) |

## Documentation

- [Setup guide](docs/SETUP.md) -- Detailed installation and configuration
- [Tool reference](docs/TOOLS.md) -- Complete parameter docs and examples
- [Architecture](docs/ARCHITECTURE.md) -- System design and security model

## License

[MIT](LICENSE)
