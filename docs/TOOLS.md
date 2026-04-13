# PKRelay Tool Reference

All tools are exposed via the MCP protocol. Parameters are passed as JSON objects.

---

## Perception

### browser_snapshot

Get a token-efficient structured representation of the current page. Returns headings, forms, buttons, links, and text with element indices and bounding boxes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format` | `"compact" \| "structured"` | No | Output format. `compact` for minimal tokens (default), `structured` for detailed hierarchy. |
| `selector` | `string` | No | CSS selector to scope snapshot to a subtree. |
| `tabId` | `number` | No | Target tab ID. Defaults to active attached tab. |

**Example usage:**
```json
{ "format": "compact" }
```

**Example response (compact):**
```
[h1] Welcome to Example
[form#login]
  [input#email] Email (text)
  [input#password] Password (password)
  [button#submit] Sign In
[a href="/about"] About Us
```

---

### browser_screenshot

Capture a screenshot of the current page. Can crop to a specific element or region for token efficiency.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | `string` | No | CSS selector to crop screenshot to element bounds. |
| `region` | `object` | No | Arbitrary crop region: `{ x, y, width, height }` in pixels. |
| `fullPage` | `boolean` | No | Capture full scrollable page (default: false, viewport only). |
| `tabId` | `number` | No | Target tab ID. |

**Example usage:**
```json
{ "selector": "#main-content" }
```

**Response:** Base64-encoded PNG image.

---

## Actions

### browser_click

Click an element on the page by CSS selector, visible text, or element index from a snapshot.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | `string` | No | CSS selector of element to click. |
| `text` | `string` | No | Match element by visible text. |
| `index` | `number` | No | Element index from a previous snapshot. |
| `tabId` | `number` | No | Target tab ID. |

**Example usage:**
```json
{ "selector": "#submit-button" }
```

---

### browser_type

Type text into an input field. Optionally clear the field first or submit after typing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | `string` | No | CSS selector of target input. |
| `text` | `string` | Yes | Text to type. |
| `clear` | `boolean` | No | Clear field before typing. |
| `submit` | `boolean` | No | Press Enter after typing. |
| `tabId` | `number` | No | Target tab ID. |

**Example usage:**
```json
{ "selector": "#search", "text": "hello world", "submit": true }
```

---

### browser_select

Select an option from a dropdown or select element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | `string` | Yes | CSS selector of target select element. |
| `value` | `string` | No | Option value to select. |
| `label` | `string` | No | Option visible text to select. |
| `tabId` | `number` | No | Target tab ID. |

**Example usage:**
```json
{ "selector": "#country", "label": "United States" }
```

---

### browser_navigate

Navigate to a URL, or go back/forward/reload.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | `string` | No | URL to navigate to. |
| `back` | `boolean` | No | Go back in history. |
| `forward` | `boolean` | No | Go forward in history. |
| `reload` | `boolean` | No | Reload the current page. |
| `tabId` | `number` | No | Target tab ID. |

**Example usage:**
```json
{ "url": "https://example.com" }
```

---

### browser_evaluate

Execute JavaScript in the page context and return the result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `expression` | `string` | Yes | JavaScript expression to evaluate. |
| `tabId` | `number` | No | Target tab ID. |

**Example usage:**
```json
{ "expression": "document.title" }
```

**Example response:**
```json
{ "result": "Example Domain" }
```

---

### browser_wait

Wait for a condition on the page -- element to appear, text to be visible, or network to be idle.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | `string` | No | Wait for element matching CSS selector. |
| `text` | `string` | No | Wait for visible text on page. |
| `networkIdle` | `boolean` | No | Wait for no pending network requests. |
| `timeout` | `number` | No | Max wait time in ms (default: 10000). |
| `tabId` | `number` | No | Target tab ID. |

**Example usage:**
```json
{ "selector": ".results-loaded", "timeout": 5000 }
```

---

## Monitoring

### browser_console

Get recent browser console messages (errors, warnings, logs). Useful for debugging JavaScript errors and API failures.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `level` | `"error" \| "warn" \| "all"` | No | Filter by message level (default: all). |
| `limit` | `number` | No | Max messages to return (default: 50). |
| `clear` | `boolean` | No | Clear console buffer after reading. |
| `tabId` | `number` | No | Target tab ID. |

**Example usage:**
```json
{ "level": "error", "limit": 10 }
```

**Example response:**
```json
[
  { "level": "error", "text": "Uncaught TypeError: Cannot read property 'x' of null", "url": "app.js", "line": 42 }
]
```

---

### browser_network

Get captured network requests and responses. Filter by URL pattern, HTTP method, or status code.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | `string` | No | URL pattern to match (substring or glob). |
| `method` | `string` | No | HTTP method filter (e.g., `"GET"`, `"POST"`). |
| `status` | `string` | No | Status code filter (e.g., `"4xx"`, `"500"`). |
| `limit` | `number` | No | Max requests to return (default: 50). |
| `clear` | `boolean` | No | Clear network buffer after reading. |
| `tabId` | `number` | No | Target tab ID. |

**Example usage:**
```json
{ "filter": "/api/", "method": "POST" }
```

---

## Tab Management

### browser_tabs

List open browser tabs with their titles, URLs, and debugger attachment status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `attached` | `boolean` | No | Filter to only attached tabs. |

**Example usage:**
```json
{}
```

**Example response:**
```json
[
  { "tabId": 123, "title": "Example", "url": "https://example.com", "attached": true },
  { "tabId": 456, "title": "Google", "url": "https://google.com", "attached": false }
]
```

---

### browser_tab_attach

Attach the debugger to a browser tab. Required before using any other browser tools on that tab. The tab must have been granted permission by the user via the PKRelay extension icon.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tabId` | `number` | Yes | Tab ID to attach the debugger to. |

**Example usage:**
```json
{ "tabId": 123 }
```

---

### browser_tab_detach

Detach the debugger from a browser tab.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tabId` | `number` | Yes | Tab ID to detach the debugger from. |

**Example usage:**
```json
{ "tabId": 123 }
```

---

### browser_tab_switch

Switch to a browser tab by ID or title match.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tabId` | `number` | No | Tab ID to switch to. |
| `title` | `string` | No | Partial match on tab title. |

**Example usage:**
```json
{ "title": "GitHub" }
```
