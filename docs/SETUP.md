# PKRelay Setup Guide

## Prerequisites

- Node.js 20 or later
- A Chromium-based browser (Chrome, Arc, Edge, or Brave)
- An MCP-compatible AI tool (Claude Code, Cursor, etc.)

## 1. Install the Chrome Extension

### Option A: Chrome Web Store (coming soon)

The extension will be published to the Chrome Web Store. Install link TBD.

### Option B: Unpacked (development)

1. Clone or download this repository.
2. Open your browser and go to `chrome://extensions` (or `arc://extensions`, `edge://extensions`).
3. Enable **Developer mode** (toggle in the top-right).
4. Click **Load unpacked** and select the `extension/` directory from this repo.
5. Note the **Extension ID** shown on the card -- you will need it for the native host manifest.

## 2. Install the MCP Server

### Global install (recommended)

```bash
npm install -g @nooma-stack/pkrelay
```

### Or run via npx (no install)

```bash
npx @nooma-stack/pkrelay
```

### Or from source

```bash
git clone https://github.com/nooma-stack/pkrelay.git
cd pkrelay
npm install
npm run build
```

## 3. Register the Native Messaging Host

The native messaging host registration tells the browser how to find the PKRelay binary.

### macOS / Linux

```bash
# If installed globally:
pkrelay install

# Or run the script directly:
./native-host/install.sh
```

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File native-host\install.ps1
```

### What the installer does

1. Finds the `pkrelay` binary (global npm bin or local node_modules).
2. Detects which supported browsers are installed.
3. Writes `com.nooma.pkrelay.json` to each browser's `NativeMessagingHosts/` directory.
4. On Windows, also creates the required registry keys.

### Update the Extension ID

After installing, edit the manifest files to include your extension ID:

```json
{
  "allowed_origins": [
    "chrome-extension://YOUR_ACTUAL_EXTENSION_ID/"
  ]
}
```

Manifest locations:
- **macOS Chrome:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- **macOS Arc:** `~/Library/Application Support/Arc/User Data/NativeMessagingHosts/`
- **macOS Edge:** `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`
- **Linux Chrome:** `~/.config/google-chrome/NativeMessagingHosts/`
- **Linux Edge:** `~/.config/microsoft-edge/NativeMessagingHosts/`
- **Windows Chrome:** `%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\`
- **Windows Edge:** `%LOCALAPPDATA%\Microsoft\Edge\User Data\NativeMessagingHosts\`

## 4. Configure Your AI Tool

### Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "pkrelay": {
      "command": "pkrelay"
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

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

## 5. Verify the Installation

1. Open your browser and navigate to any page.
2. Click the PKRelay extension icon and grant permission for the current tab.
3. In your AI tool, try calling `browser_tabs` -- you should see a list of open tabs.
4. Call `browser_tab_attach` with a tab ID, then `browser_snapshot` to get the page structure.

## Troubleshooting

### "Native messaging host not found"

- Verify the manifest file exists in the correct browser directory (see locations above).
- Check that `"path"` in the manifest points to the actual `pkrelay` binary.
- Confirm `"allowed_origins"` contains your extension ID.

### Extension shows "Disconnected"

- The MCP server may not be running. Your AI tool should start it automatically.
- Check that `pkrelay` is in your PATH: `which pkrelay`

### "Permission denied" on tab operations

- Click the PKRelay extension icon on the tab you want to control and grant permission.
- Then call `browser_tab_attach` with the tab ID.

### Tools return timeout errors

- Ensure the browser tab is still open and the page has loaded.
- Check the extension popup for connection status.
- Try detaching and re-attaching the tab.

### Build from source fails

```bash
cd mcp-server
npm install
npm run build
```

Check that TypeScript compiles without errors. Requires Node.js 20+.
