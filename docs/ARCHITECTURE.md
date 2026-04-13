# PKRelay Architecture

## System Overview

PKRelay bridges AI tools and the browser through three components connected by two protocols.

```
+------------------------------+
|  AI Tool                     |
|  (Claude Code, Cursor, etc.) |
+---------|--------------------+
          | MCP protocol (stdio, JSON-RPC)
          v
+------------------------------+
|  PKRelay MCP Server          |
|  (Node.js, TypeScript)       |
|  - Registers 14 MCP tools    |
|  - Translates MCP <-> native |
+---------|--------------------+
          | Chrome Native Messaging
          | (length-prefixed JSON over stdio)
          v
+------------------------------+
|  PKRelay Extension           |
|  (Manifest V3 service worker)|
|  - Permission management     |
|  - CDP command execution     |
|  - Snapshot generation       |
+---------|--------------------+
          | Chrome DevTools Protocol
          | (chrome.debugger API)
          v
+------------------------------+
|  Browser Tab                 |
+------------------------------+
```

## Components

### MCP Server (`mcp-server/`)

The MCP server is a Node.js process that communicates with AI tools via the Model Context Protocol (stdio transport). It exposes 14 tools organized into four categories:

- **Perception:** `browser_snapshot`, `browser_screenshot`
- **Actions:** `browser_click`, `browser_type`, `browser_select`, `browser_navigate`, `browser_evaluate`, `browser_wait`
- **Monitoring:** `browser_console`, `browser_network`
- **Tab management:** `browser_tabs`, `browser_tab_attach`, `browser_tab_detach`, `browser_tab_switch`

Each tool call is translated into a native messaging request, sent to the extension, and the response is returned to the AI tool.

### Chrome Extension (`extension/`)

The extension is a Manifest V3 service worker that:

1. Manages per-tab permissions (user must explicitly grant access).
2. Maintains debugger connections via `chrome.debugger`.
3. Executes Chrome DevTools Protocol commands on attached tabs.
4. Generates token-efficient page snapshots by traversing the DOM.
5. Captures and buffers console messages and network requests.

### Native Messaging Bridge

The MCP server and extension communicate over Chrome's Native Messaging protocol:

- Messages are length-prefixed: 4-byte little-endian uint32 length header followed by UTF-8 JSON.
- The extension starts the native host process when the first message is sent.
- Each message is a JSON object with `id`, `method`, `params`, and `result`/`error` fields.

## Data Flow

### Tool call lifecycle

```
1. AI tool sends MCP tool_call (e.g., browser_snapshot)
       |
2. MCP server receives JSON-RPC request via stdio
       |
3. Server creates bridge request: { id: N, method: "snapshot", params: {...} }
       |
4. Bridge serializes to length-prefixed JSON, writes to stdout
       |
5. Chrome delivers message to extension service worker
       |
6. Extension executes CDP commands on the target tab
       |
7. Extension sends response: { id: N, result: {...} }
       |
8. Bridge reads length-prefixed response from stdin
       |
9. Server resolves pending promise, returns MCP tool_result
       |
10. AI tool receives structured response
```

### Snapshot flow (detailed)

The `browser_snapshot` tool generates a lightweight DOM representation:

1. Extension injects a content script (or evaluates via CDP) that walks the DOM.
2. Interactive elements (inputs, buttons, links, selects) are extracted with:
   - Element type and tag name
   - Text content or label
   - CSS selector path
   - Bounding box coordinates
   - Current value (for inputs)
3. Results are formatted as either:
   - **Compact:** One-line-per-element text format (minimal tokens)
   - **Structured:** JSON hierarchy with full metadata

## Security Model

### Per-tab permissions

PKRelay uses an explicit permission model:

1. **No automatic access.** The extension cannot interact with any tab until the user grants permission.
2. **User-initiated grant.** The user clicks the PKRelay icon and explicitly permits debugger access for that specific tab.
3. **Debugger attachment.** The AI tool must call `browser_tab_attach` before any other tool works on that tab. Chrome shows a visible "debugging" banner.
4. **User can revoke.** Clicking the extension icon again or closing the debugger banner detaches the debugger.

### Native messaging isolation

- Only extensions listed in the manifest's `allowed_origins` can communicate with the native host.
- The native host process runs with the user's OS permissions (not elevated).
- Each browser profile gets its own native messaging channel.

### No remote access

- The MCP server communicates only via stdio (local process).
- There is no HTTP server, no open ports, no remote API.
- The extension does not make any external network requests.

## Native Messaging Host Registration

The native messaging host is registered per-browser via a JSON manifest file placed in a browser-specific directory. The manifest specifies:

- `name`: `com.nooma.pkrelay` (the identifier the extension uses to connect)
- `path`: Absolute path to the `pkrelay` binary
- `type`: `stdio` (communication over stdin/stdout)
- `allowed_origins`: Array of extension IDs permitted to connect

On Windows, an additional registry key is required that points to the manifest file location.

See [SETUP.md](SETUP.md) for platform-specific paths.
