# PKRelay Broker+Client Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable multiple concurrent Claude Code sessions (local or remote via SSH) to share a single PKRelay Chrome extension through a broker/client architecture with auto-start.

**Architecture:** A single `pkrelay` binary operates in one of three modes: **broker** (binds WS port, accepts extension + MCP clients, multiplexes), **client** (connects outbound to a broker, forwards tool requests), or **daemon** (broker without stdio MCP transport, for standalone background operation). On startup, the binary auto-detects: `PKRELAY_BROKER` env → client mode; `--daemon` flag → daemon mode; else try broker, EADDRINUSE → auto-fallback to client. The Chrome extension auto-starts the broker via native messaging on load.

**Tech Stack:** TypeScript (MCP server), JavaScript (Chrome extension), Node.js native messaging, WebSocket (ws library)

---

## Architecture Diagram

```
Dev laptop (or Mac Studio local):

  Chrome extension ──WS──→ pkrelay broker (daemon, port 18793)
       │                         ↑          ↑
       │ native msg              │          │  WS /mcp-client
       └→ launcher.js            │          │
          (ensures broker)       │      pkrelay client (stdio)
                                 │          ↑
                                 │      Claude Code session A
                                 │
                             pkrelay client (stdio, via SSH tunnel)
                                 ↑
                             Claude Code session B (remote)
```

## Multiplexing Protocol

Broker rewrites request IDs to avoid collisions between clients:

1. Client sends: `{id: 5, method: "snapshot", params: {...}}`
2. Broker assigns globalId (e.g., 100), stores mapping: `{100 → {clientId: 3, originalId: 5}}`
3. Broker forwards to extension: `{id: 100, method: "snapshot", params: {...}}`
4. Extension responds: `{id: 100, result: {...}}`
5. Broker looks up mapping, sends to client 3: `{id: 5, result: {...}}`

---

## Task 1: Extract Bridge Interface

**Files:**
- Create: `mcp-server/src/bridge-interface.ts`

The tools import `NativeMessagingBridge` as a type. We need an interface both BrokerBridge and ClientBridge can satisfy so tools work with either.

**Step 1: Create the interface file**

```typescript
// mcp-server/src/bridge-interface.ts
export interface Bridge {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  readonly isConnected: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

**Step 2: Verify it compiles**

Run: `cd ~/nooma-stack/pkrelay/mcp-server && npx tsc --noEmit`
Expected: No new errors

**Step 3: Commit**

```bash
git add mcp-server/src/bridge-interface.ts
git commit -m "refactor: extract Bridge interface for broker/client polymorphism"
```

---

## Task 2: Refactor BrokerBridge (upgrade existing bridge.ts)

**Files:**
- Modify: `mcp-server/src/bridge.ts`

Add path-based routing (`/extension` vs `/mcp-client`), client tracking, and request ID multiplexing. The existing extension WS connection logic stays; we add a parallel client management layer.

**Step 1: Write the upgraded bridge.ts**

Key changes:
- Import and implement `Bridge` interface
- `WebSocketServer` with `noServer: true` + manual upgrade handling for path routing
- Extension connection on path `/extension` (or root `/` for backward compat)
- MCP client connections on path `/mcp-client`
- Each client gets a unique `clientId`
- `clientRequests` map: `globalId → {clientWs, originalId}`
- `nextGlobalId` counter for rewriting IDs
- When client sends `{id, method, params}`: rewrite id to globalId, forward to extension
- When extension responds `{id, result/error}`: look up mapping, rewrite back, send to client
- On client disconnect: reject that client's pending requests, clean up mappings
- On extension disconnect: reject ALL pending requests (extension gone = everything fails)

The `request()` method is only used when this process is ALSO an MCP server (broker mode, not daemon-only). It works exactly as today — sends to extension, tracks pending.

**Step 2: Verify it compiles**

Run: `cd ~/nooma-stack/pkrelay/mcp-server && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add mcp-server/src/bridge.ts
git commit -m "feat: add mcp-client multiplexing to BrokerBridge"
```

---

## Task 3: Create ClientBridge

**Files:**
- Create: `mcp-server/src/client-bridge.ts`

Outbound WS connection to a broker's `/mcp-client` endpoint. Same `request()` API as BrokerBridge so tools work identically.

**Step 1: Write client-bridge.ts**

```typescript
// mcp-server/src/client-bridge.ts
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { Bridge } from './bridge-interface.js';

export class ClientBridge extends EventEmitter implements Bridge {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private _connected = false;
  private brokerUrl: string;

  constructor(brokerUrl: string) {
    super();
    this.brokerUrl = brokerUrl;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.brokerUrl);

      this.ws.on('open', () => {
        this._connected = true;
        this.emit('connected');
        process.stderr.write(`[pkrelay] Connected to broker at ${this.brokerUrl}\n`);
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString('utf-8'));
          this.handleMessage(msg);
        } catch { /* skip malformed */ }
      });

      this.ws.on('close', () => {
        this._connected = false;
        this.rejectAllPending('Broker connection closed');
        this.emit('disconnected');
        process.stderr.write('[pkrelay] Disconnected from broker\n');
      });

      this.ws.on('error', (err) => {
        if (!this._connected) {
          reject(new Error(`Cannot connect to broker at ${this.brokerUrl}: ${err.message}`));
        } else {
          this._connected = false;
          this.rejectAllPending('Broker connection error');
          this.emit('disconnected');
        }
      });
    });
  }

  private handleMessage(msg: { id?: number; result?: unknown; error?: { code: string; message: string } }) {
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to broker. Ensure the PKRelay broker is running.');
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Broker request timeout: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  private rejectAllPending(reason: string) {
    for (const [, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  get isConnected() { return this._connected; }

  async stop() {
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }
}
```

**Step 2: Verify it compiles**

Run: `cd ~/nooma-stack/pkrelay/mcp-server && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add mcp-server/src/client-bridge.ts
git commit -m "feat: add ClientBridge for connecting to remote/local broker"
```

---

## Task 4: Update Tool Imports to Use Bridge Interface

**Files:**
- Modify: `mcp-server/src/tools/index.ts`
- Modify: All 11 tool files in `mcp-server/src/tools/`

Change `NativeMessagingBridge` type imports to `Bridge` interface. Tools only call `bridge.request()` so the change is purely a type import swap.

**Step 1: Update index.ts**

```typescript
// Change import from:
import type { NativeMessagingBridge } from '../bridge.js';
// To:
import type { Bridge } from '../bridge-interface.js';

// Change function signature:
export function registerTools(server: McpServer, bridge: Bridge) {
```

**Step 2: Update each tool file**

Same pattern for all 11 tool files (`snapshot.ts`, `screenshot.ts`, `click.ts`, `type.ts`, `select.ts`, `navigate.ts`, `evaluate.ts`, `wait.ts`, `console.ts`, `network.ts`, `tabs.ts`):

```typescript
// Change:
import type { NativeMessagingBridge } from '../bridge.js';
// To:
import type { Bridge } from '../bridge-interface.js';

// Change function signature parameter type from NativeMessagingBridge to Bridge
```

**Step 3: Verify it compiles**

Run: `cd ~/nooma-stack/pkrelay/mcp-server && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add mcp-server/src/tools/
git commit -m "refactor: use Bridge interface in all tool files"
```

---

## Task 5: Rewrite Entry Point (index.ts)

**Files:**
- Modify: `mcp-server/src/index.ts`

Three startup modes: broker (default), client (`PKRELAY_BROKER` env or EADDRINUSE fallback), daemon (`--daemon` flag).

**Step 1: Write the new index.ts**

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NativeMessagingBridge } from './bridge.js';
import { ClientBridge } from './client-bridge.js';
import { registerTools } from './tools/index.js';
import type { Bridge } from './bridge-interface.js';

const BRIDGE_PORT = parseInt(process.env.PKRELAY_PORT || '18793', 10);
const BROKER_URL = process.env.PKRELAY_BROKER || '';
const IS_DAEMON = process.argv.includes('--daemon');

async function startBroker(): Promise<Bridge> {
  const bridge = new NativeMessagingBridge(BRIDGE_PORT);
  await bridge.start();
  process.stderr.write(`[pkrelay] Broker listening on 127.0.0.1:${BRIDGE_PORT}\n`);
  return bridge;
}

async function startClient(url: string): Promise<Bridge> {
  const bridge = new ClientBridge(url);
  await bridge.start();
  return bridge;
}

async function main() {
  let bridge: Bridge;

  if (BROKER_URL) {
    // Explicit client mode (remote broker via SSH tunnel, or explicit local)
    process.stderr.write(`[pkrelay] Client mode: connecting to ${BROKER_URL}\n`);
    bridge = await startClient(BROKER_URL);
  } else {
    // Try broker mode first
    try {
      bridge = await startBroker();
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        if (IS_DAEMON) {
          process.stderr.write(`[pkrelay] Port ${BRIDGE_PORT} in use — broker already running. Exiting.\n`);
          process.exit(0);
        }
        // Auto-fallback to client mode
        const fallbackUrl = `ws://127.0.0.1:${BRIDGE_PORT}/mcp-client`;
        process.stderr.write(`[pkrelay] Port ${BRIDGE_PORT} in use — falling back to client mode (${fallbackUrl})\n`);
        bridge = await startClient(fallbackUrl);
      } else {
        throw err;
      }
    }
  }

  if (IS_DAEMON) {
    // Daemon mode: broker only, no stdio MCP. Stay alive.
    process.stderr.write('[pkrelay] Running as daemon (no MCP stdio)\n');
    process.on('SIGTERM', async () => { await bridge.stop(); process.exit(0); });
    process.on('SIGINT', async () => { await bridge.stop(); process.exit(0); });
    return;
  }

  // Normal mode: MCP server on stdio
  const server = new McpServer({ name: 'pkrelay', version: '3.1.0' });
  registerTools(server, bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`PKRelay MCP server failed to start: ${err}\n`);
  process.exit(1);
});
```

**Step 2: Verify it compiles**

Run: `cd ~/nooma-stack/pkrelay/mcp-server && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add mcp-server/src/index.ts
git commit -m "feat: add broker/client/daemon startup modes"
```

---

## Task 6: Create Native Messaging Launcher

**Files:**
- Create: `native-host/launcher.js`

Thin Node script that speaks Chrome's native messaging protocol (4-byte LE length-prefixed JSON on stdin/stdout). On invocation: probes whether broker is running, spawns `pkrelay --daemon` if not, responds to Chrome, exits.

**Step 1: Write launcher.js**

```javascript
#!/usr/bin/env node
// launcher.js — Ensures PKRelay broker daemon is running.
// Called by Chrome extension via native messaging on startup.
// Protocol: 4-byte little-endian length prefix + JSON on stdin/stdout.

import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';

const PORT = parseInt(process.env.PKRELAY_PORT || '18793', 10);

function readNativeMessage() {
  const header = Buffer.alloc(4);
  try {
    fs.readSync(0, header, 0, 4);
  } catch {
    return null;
  }
  const len = header.readUInt32LE(0);
  if (len === 0 || len > 1024 * 1024) return null;
  const body = Buffer.alloc(len);
  fs.readSync(0, body, 0, len);
  return JSON.parse(body.toString('utf-8'));
}

function writeNativeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

function isBrokerRunning() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port: PORT, host: '127.0.0.1' });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
  });
}

function findPkrelayBinary() {
  // Check common locations
  const candidates = [
    '/opt/homebrew/bin/pkrelay',
    '/usr/local/bin/pkrelay',
    path.join(process.env.HOME || '', '.npm-global/bin/pkrelay'),
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  // Fall back to PATH
  return 'pkrelay';
}

async function main() {
  readNativeMessage(); // consume Chrome's request (content doesn't matter)

  const running = await isBrokerRunning();

  if (!running) {
    const bin = findPkrelayBinary();
    const child = spawn(bin, ['--daemon'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PKRELAY_PORT: String(PORT) },
    });
    child.unref();
    // Wait for it to bind
    let ready = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 300));
      ready = await isBrokerRunning();
      if (ready) break;
    }
    writeNativeMessage({ status: ready ? 'started' : 'start_failed', port: PORT });
  } else {
    writeNativeMessage({ status: 'already_running', port: PORT });
  }
}

main().catch((err) => {
  writeNativeMessage({ status: 'error', message: err.message });
}).finally(() => {
  process.exit(0);
});
```

**Step 2: Make it executable**

```bash
chmod +x ~/nooma-stack/pkrelay/native-host/launcher.js
```

**Step 3: Commit**

```bash
git add native-host/launcher.js
git commit -m "feat: add native messaging launcher for broker auto-start"
```

---

## Task 7: Update Native Host Manifest and Install Script

**Files:**
- Modify: `native-host/manifest.json`
- Modify: `native-host/install.sh`

Point the native messaging host at `launcher.js` instead of the MCP binary. The launcher is a separate entry point that only speaks Chrome's protocol.

**Step 1: Update manifest.json template**

Change description to reflect launcher role. Path still uses PLACEHOLDER (filled by install.sh).

**Step 2: Update install.sh**

Instead of finding the `pkrelay` binary for the manifest path, find the `launcher.js` script. The `pkrelay` binary is still needed (launcher spawns it), but the manifest points at the launcher.

Key changes:
- Find `launcher.js` relative to the install script's own directory
- Manifest path points to: `node <path-to-launcher.js>` — but native messaging manifests need a direct executable path, so we create a small wrapper shell script OR make launcher.js self-executable with `#!/usr/bin/env node`
- Since launcher.js has the shebang and is `chmod +x`, it can be the manifest path directly

**Step 3: Verify install script works**

Run: `cd ~/nooma-stack/pkrelay && bash native-host/install.sh`

**Step 4: Commit**

```bash
git add native-host/manifest.json native-host/install.sh
git commit -m "feat: native host manifest points to launcher for auto-start"
```

---

## Task 8: Extension Changes (manifest.json + background.js)

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/background.js`

Add `nativeMessaging` permission. On service worker startup, send a native message to ensure broker is running before connecting the WebSocket relay.

**Step 1: Update manifest.json**

Add `"nativeMessaging"` to the permissions array.

**Step 2: Update background.js**

Replace the direct `relay.connect()` call (line 271) with a native-message-first flow:

```javascript
// --- Auto-start broker and connect ---
function ensureBrokerAndConnect() {
  chrome.runtime.sendNativeMessage('com.nooma.pkrelay', { action: 'ensure-broker' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('[PKRelay] Native messaging unavailable:', chrome.runtime.lastError.message);
      // Broker may already be running — try connecting anyway
    } else {
      console.log('[PKRelay] Broker status:', response?.status);
    }
    relay.connect();
  });
}

ensureBrokerAndConnect();
```

**Step 3: Commit**

```bash
git add extension/manifest.json extension/background.js
git commit -m "feat: auto-start broker via native messaging on extension load"
```

---

## Task 9: Build, Install, and Test

**Step 1: Build TypeScript**

```bash
cd ~/nooma-stack/pkrelay/mcp-server
npx tsc
```

**Step 2: Kill orphan pkrelay**

```bash
pkill -f "node.*pkrelay" || true
```

**Step 3: Reinstall npm link**

```bash
cd ~/nooma-stack/pkrelay/mcp-server
npm link
```

**Step 4: Reinstall native host**

```bash
cd ~/nooma-stack/pkrelay
bash native-host/install.sh
```

**Step 5: Reload extension in Chrome**

Navigate to `chrome://extensions`, find PKRelay, click reload.

**Step 6: Verify broker auto-started**

```bash
lsof -iTCP:18793 -sTCP:LISTEN
```

Expected: `node ... TCP localhost:18793 (LISTEN)`

**Step 7: Test MCP connection**

Restart Claude Code. Run a PKRelay tool (e.g., `browser_tabs`). Should see tabs from the user's Chrome.

**Step 8: Test second session**

Open a second Claude Code session. Both should be able to use PKRelay tools simultaneously — the second session auto-falls back to client mode.

---

## Task 10: Update Claude Code MCP Config for Remote Dev

**Files:**
- Document only (no code change needed for basic setup)

For remote SSH developers on Mac Studio, each dev's `.claude.json` on Mac Studio needs:

```json
"pkrelay": {
  "type": "stdio",
  "command": "pkrelay",
  "env": { "PKRELAY_BROKER": "ws://localhost:<DEV_PORT>/mcp-client" }
}
```

And their SSH config:

```
Host mac-studio
  RemoteForward <DEV_PORT> localhost:18793
```

Where `<DEV_PORT>` is unique per dev (18793, 18794, 18795, ...).

---

## Task 11: Key Manager + Tunnel Manager

**Files:**
- Create: `mcp-server/src/key-manager.ts`
- Create: `mcp-server/src/tunnel-manager.ts`
- Modify: `mcp-server/package.json` (add `ssh2` dependency)

**New dependency:** `ssh2` (pure-JS SSH2 client, ~20M weekly downloads, zero native deps)

### Step 1: Install ssh2

```bash
cd ~/nooma-stack/pkrelay/mcp-server
npm install ssh2
npm install -D @types/ssh2
```

### Step 2: Write key-manager.ts

Manages PKRelay-scoped SSH key pairs in `~/.pkrelay/keys/`. Each remote gets its own key pair named after the remote's alias (e.g., `mac-studio`, `mac-studio.pub`).

```typescript
// mcp-server/src/key-manager.ts
import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PKRELAY_DIR = path.join(os.homedir(), '.pkrelay');
const KEYS_DIR = path.join(PKRELAY_DIR, 'keys');

export interface KeyPair {
  privatePath: string;
  publicPath: string;
  publicKey: string;
}

function ensureDirs() {
  fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
}

export function generateKeyPair(alias: string): KeyPair {
  ensureDirs();
  const privatePath = path.join(KEYS_DIR, alias);
  const publicPath = `${privatePath}.pub`;

  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Convert PEM to OpenSSH format for authorized_keys
  const pubKeyObj = require('crypto').createPublicKey(publicKey);
  const sshPub = pubKeyObj.export({ type: 'spki', format: 'der' });
  const opensshPub = toOpenSSHPublicKey(sshPub, `pkrelay-${alias}`);

  fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
  fs.writeFileSync(publicPath, opensshPub + '\n', { mode: 0o644 });

  return { privatePath, publicPath, publicKey: opensshPub };
}

function toOpenSSHPublicKey(derBuffer: Buffer, comment: string): string {
  // Ed25519 DER SPKI → OpenSSH format
  // The raw 32-byte key starts at offset 12 in the DER
  const raw = derBuffer.subarray(12);
  const keyType = Buffer.from('ssh-ed25519');
  const buf = Buffer.alloc(4 + keyType.length + 4 + raw.length);
  let offset = 0;
  buf.writeUInt32BE(keyType.length, offset); offset += 4;
  keyType.copy(buf, offset); offset += keyType.length;
  buf.writeUInt32BE(raw.length, offset); offset += 4;
  raw.copy(buf, offset);
  return `ssh-ed25519 ${buf.toString('base64')} ${comment}`;
}

export function getKeyPair(alias: string): KeyPair | null {
  const privatePath = path.join(KEYS_DIR, alias);
  const publicPath = `${privatePath}.pub`;
  if (!fs.existsSync(privatePath)) return null;
  const publicKey = fs.existsSync(publicPath)
    ? fs.readFileSync(publicPath, 'utf-8').trim()
    : '';
  return { privatePath, publicPath, publicKey };
}

export function deleteKeyPair(alias: string): boolean {
  const privatePath = path.join(KEYS_DIR, alias);
  const publicPath = `${privatePath}.pub`;
  let deleted = false;
  if (fs.existsSync(privatePath)) { fs.unlinkSync(privatePath); deleted = true; }
  if (fs.existsSync(publicPath)) { fs.unlinkSync(publicPath); deleted = true; }
  return deleted;
}

export function listKeyPairs(): string[] {
  ensureDirs();
  return fs.readdirSync(KEYS_DIR)
    .filter(f => !f.endsWith('.pub'))
    .sort();
}
```

### Step 3: Write tunnel-manager.ts

Manages SSH tunnel lifecycle: key setup via `ssh2`, tunnel spawning via system SSH, health monitoring, and auto-reconnect.

```typescript
// mcp-server/src/tunnel-manager.ts
import { Client as SSHClient } from 'ssh2';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateKeyPair, getKeyPair, deleteKeyPair } from './key-manager.js';

const CONFIG_DIR = path.join(os.homedir(), '.pkrelay');
const REMOTES_FILE = path.join(CONFIG_DIR, 'remotes.json');

export interface RemoteConfig {
  alias: string;
  host: string;
  username: string;
  remotePort: number;    // port on the remote machine for the tunnel
  localPort: number;     // local broker port to forward (default 18793)
  keyInstalled: boolean;
}

export interface RemoteStatus {
  alias: string;
  config: RemoteConfig;
  tunnelState: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
  pid?: number;
}

export class TunnelManager extends EventEmitter {
  private remotes = new Map<string, RemoteConfig>();
  private tunnels = new Map<string, ChildProcess>();
  private tunnelStates = new Map<string, RemoteStatus>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    super();
    this.loadConfig();
  }

  // --- Config persistence ---

  private loadConfig() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      if (fs.existsSync(REMOTES_FILE)) {
        const data = JSON.parse(fs.readFileSync(REMOTES_FILE, 'utf-8'));
        for (const remote of data.remotes || []) {
          this.remotes.set(remote.alias, remote);
        }
      }
    } catch { /* fresh start */ }
  }

  private saveConfig() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      REMOTES_FILE,
      JSON.stringify({ remotes: [...this.remotes.values()] }, null, 2),
      { mode: 0o600 },
    );
  }

  // --- One-click key setup via ssh2 ---

  async setupKeys(
    alias: string,
    host: string,
    username: string,
    password: string,
    remotePort: number,
    localPort = 18793,
  ): Promise<{ success: boolean; error?: string; hostFingerprint?: string }> {
    // 1. Generate key pair
    const keyPair = generateKeyPair(alias);
    process.stderr.write(`[pkrelay] Generated key pair for ${alias}\n`);

    // 2. Connect with password and install public key
    try {
      await this.installPublicKey(host, username, password, keyPair.publicKey);
    } catch (err: unknown) {
      deleteKeyPair(alias);
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Key installation failed: ${message}` };
    }

    // 3. Verify key-based auth works
    try {
      await this.testKeyAuth(host, username, keyPair.privatePath);
    } catch (err: unknown) {
      deleteKeyPair(alias);
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Key verification failed: ${message}` };
    }

    // 4. Save config
    const config: RemoteConfig = {
      alias,
      host,
      username,
      remotePort,
      localPort,
      keyInstalled: true,
    };
    this.remotes.set(alias, config);
    this.saveConfig();

    process.stderr.write(`[pkrelay] Key setup complete for ${alias}\n`);
    return { success: true };
  }

  private installPublicKey(
    host: string,
    username: string,
    password: string,
    publicKey: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();

      conn.on('ready', () => {
        const escapedKey = publicKey.replace(/'/g, "'\\''");
        const cmd = [
          'mkdir -p ~/.ssh',
          'chmod 700 ~/.ssh',
          'touch ~/.ssh/authorized_keys',
          'chmod 600 ~/.ssh/authorized_keys',
          // Only append if not already present
          `grep -qF '${escapedKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${escapedKey}' >> ~/.ssh/authorized_keys`,
        ].join(' && ');

        conn.exec(cmd, (err, stream) => {
          if (err) { conn.end(); reject(err); return; }
          let stderr = '';
          stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          stream.on('close', (code: number) => {
            conn.end();
            if (code === 0) resolve();
            else reject(new Error(`Key install command failed (exit ${code}): ${stderr}`));
          });
        });
      });

      conn.on('error', reject);

      conn.connect({
        host,
        port: 22,
        username,
        password,
        readyTimeout: 10000,
        // Accept unknown host keys for first connection (user initiated this)
        // In production, we'd verify the fingerprint
        hostVerifier: () => true,
      });
    });
  }

  private testKeyAuth(host: string, username: string, privatePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      conn.on('ready', () => { conn.end(); resolve(); });
      conn.on('error', reject);
      conn.connect({
        host,
        port: 22,
        username,
        privateKey: fs.readFileSync(privatePath),
        readyTimeout: 10000,
        hostVerifier: () => true,
      });
    });
  }

  // --- Tunnel management ---

  startTunnel(alias: string): boolean {
    const config = this.remotes.get(alias);
    if (!config) return false;

    const keyPair = getKeyPair(alias);
    if (!keyPair) return false;

    // Kill existing tunnel if any
    this.stopTunnel(alias);

    const args = [
      '-i', keyPair.privatePath,
      '-R', `${config.remotePort}:127.0.0.1:${config.localPort}`,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-N',  // no command, tunnel only
      `${config.username}@${config.host}`,
    ];

    const child = spawn('ssh', args, {
      stdio: 'ignore',
      detached: false,
    });

    this.tunnels.set(alias, child);
    this.setStatus(alias, 'connecting');

    // SSH doesn't give us a clean "tunnel ready" signal, so we wait a moment
    setTimeout(() => {
      if (child.exitCode === null) {
        this.setStatus(alias, 'connected', undefined, child.pid);
      }
    }, 2000);

    child.on('exit', (code) => {
      this.tunnels.delete(alias);
      if (code !== 0 && code !== null) {
        this.setStatus(alias, 'error', `SSH exited with code ${code}`);
        this.scheduleReconnect(alias);
      } else {
        this.setStatus(alias, 'disconnected');
      }
    });

    child.on('error', (err) => {
      this.tunnels.delete(alias);
      this.setStatus(alias, 'error', err.message);
      this.scheduleReconnect(alias);
    });

    return true;
  }

  stopTunnel(alias: string) {
    const timer = this.reconnectTimers.get(alias);
    if (timer) { clearTimeout(timer); this.reconnectTimers.delete(alias); }

    const child = this.tunnels.get(alias);
    if (child) {
      child.kill('SIGTERM');
      this.tunnels.delete(alias);
    }
    this.setStatus(alias, 'disconnected');
  }

  private scheduleReconnect(alias: string) {
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(alias);
      if (this.remotes.has(alias)) {
        process.stderr.write(`[pkrelay] Reconnecting tunnel: ${alias}\n`);
        this.startTunnel(alias);
      }
    }, 10000);
    this.reconnectTimers.set(alias, timer);
  }

  private setStatus(alias: string, state: RemoteStatus['tunnelState'], error?: string, pid?: number) {
    const config = this.remotes.get(alias);
    if (!config) return;
    const status: RemoteStatus = { alias, config, tunnelState: state, error, pid };
    this.tunnelStates.set(alias, status);
    this.emit('statusChanged', status);
  }

  // --- CRUD ---

  removeRemote(alias: string) {
    this.stopTunnel(alias);
    deleteKeyPair(alias);
    this.remotes.delete(alias);
    this.tunnelStates.delete(alias);
    this.saveConfig();
  }

  getRemotes(): RemoteStatus[] {
    return [...this.remotes.keys()].map(alias => {
      return this.tunnelStates.get(alias) || {
        alias,
        config: this.remotes.get(alias)!,
        tunnelState: 'disconnected' as const,
      };
    });
  }

  // --- Lifecycle ---

  startAllTunnels() {
    for (const alias of this.remotes.keys()) {
      const config = this.remotes.get(alias)!;
      if (config.keyInstalled) {
        this.startTunnel(alias);
      }
    }
  }

  stopAllTunnels() {
    for (const alias of this.tunnels.keys()) {
      this.stopTunnel(alias);
    }
  }
}
```

### Step 4: Verify it compiles

Run: `cd ~/nooma-stack/pkrelay/mcp-server && npx tsc --noEmit`

### Step 5: Commit

```bash
git add mcp-server/src/key-manager.ts mcp-server/src/tunnel-manager.ts mcp-server/package.json mcp-server/package-lock.json
git commit -m "feat: add KeyManager and TunnelManager for remote session SSH tunnels"
```

---

## Task 12: Broker WS Handlers for Remote Management

**Files:**
- Modify: `mcp-server/src/bridge.ts`
- Modify: `mcp-server/src/index.ts`

Wire up TunnelManager to the broker so the extension can send remote management commands over the existing WebSocket connection. The broker handles these messages from the extension (not from MCP clients).

### Step 1: Add remote management message handlers to BrokerBridge

New WS message types from extension:

| Method | Params | Description |
|--------|--------|-------------|
| `pkrelay.remote.setup` | `{alias, host, username, password, remotePort}` | One-click key setup + tunnel start |
| `pkrelay.remote.connect` | `{alias}` | Start tunnel for existing remote |
| `pkrelay.remote.disconnect` | `{alias}` | Stop tunnel |
| `pkrelay.remote.remove` | `{alias}` | Remove remote + keys + tunnel |
| `pkrelay.remote.list` | `{}` | List all remotes with status |

In `bridge.ts`, the BrokerBridge holds a reference to TunnelManager. When it receives a message from the extension socket with `method: "pkrelay.remote.*"`, it handles it directly (these are NOT forwarded to MCP clients — they're broker-internal commands).

```typescript
// In BrokerBridge, add to constructor:
private tunnelManager: TunnelManager;

// In handleExtensionMessage, before forwarding to pending requests:
if (msg.method?.startsWith('pkrelay.remote.')) {
  this.handleRemoteCommand(msg);
  return;
}
```

Handle methods:
- `pkrelay.remote.setup`: call `tunnelManager.setupKeys(...)`, respond with result, if success call `tunnelManager.startTunnel(alias)`
- `pkrelay.remote.connect`: call `tunnelManager.startTunnel(alias)`
- `pkrelay.remote.disconnect`: call `tunnelManager.stopTunnel(alias)`
- `pkrelay.remote.remove`: call `tunnelManager.removeRemote(alias)`
- `pkrelay.remote.list`: call `tunnelManager.getRemotes()`

TunnelManager emits `statusChanged` events. BrokerBridge listens and pushes status updates to the extension:

```typescript
tunnelManager.on('statusChanged', (status) => {
  this.sendToExtension({ method: 'pkrelay.remote.statusUpdate', params: status });
});
```

### Step 2: Wire TunnelManager into index.ts daemon startup

In daemon mode (and broker+MCP mode), create TunnelManager and pass to BrokerBridge. On daemon startup, call `tunnelManager.startAllTunnels()` to restore previously configured tunnels.

```typescript
// In index.ts, after broker starts:
if (bridge instanceof NativeMessagingBridge) {
  bridge.tunnelManager.startAllTunnels();
}
```

On shutdown (SIGTERM/SIGINT), call `tunnelManager.stopAllTunnels()`.

### Step 3: Verify it compiles

Run: `cd ~/nooma-stack/pkrelay/mcp-server && npx tsc --noEmit`

### Step 4: Commit

```bash
git add mcp-server/src/bridge.ts mcp-server/src/index.ts
git commit -m "feat: wire TunnelManager to broker for remote session commands"
```

---

## Task 13: Extension Settings UI for Remote Sessions

**Files:**
- Modify: `extension/options.html`
- Modify: `extension/options.js`
- Modify: `extension/background.js`

Add a "Remote Sessions" section to the extension settings page. Users can add, connect, disconnect, and remove remote machines. The setup flow collects one-time credentials and triggers the broker's key-setup + tunnel-start sequence.

### Step 1: Add Remote Sessions section to options.html

Insert after the existing "Getting Started" guide div, before the GitHub link. Uses the same dark theme styling.

```html
<!-- Remote Sessions -->
<div class="section" id="remoteSection" style="margin-top: 32px;">
  <h2 style="font-size: 18px; margin-bottom: 16px; color: #fff;">Remote Sessions</h2>
  <p class="help" style="margin-bottom: 16px;">
    Connect Claude Code sessions on remote machines to this browser.
    Each remote gets its own SSH tunnel and PKRelay-scoped key pair.
  </p>

  <!-- Existing remotes list -->
  <div id="remoteList"></div>

  <!-- Add new remote form -->
  <div class="guide" id="addRemoteForm" style="margin-top: 16px;">
    <h2 style="font-size: 14px; margin-bottom: 12px;">Add Remote Machine</h2>
    <div class="form-group">
      <label for="remoteAlias">Alias</label>
      <input type="text" id="remoteAlias" placeholder="mac-studio">
      <p class="help">Friendly name for this remote</p>
    </div>
    <div class="form-group">
      <label for="remoteHost">Hostname / IP</label>
      <input type="text" id="remoteHost" placeholder="192.168.1.100 or mac-studio.local">
    </div>
    <div class="form-group">
      <label for="remoteUser">Username</label>
      <input type="text" id="remoteUser" placeholder="username">
    </div>
    <div class="form-group">
      <label for="remotePassword">Password (one-time)</label>
      <input type="password" id="remotePassword" placeholder="Used once for key setup, never stored">
      <p class="help">Your SSH password. Used only to install the key pair, then discarded.</p>
    </div>
    <div class="form-group">
      <label for="remotePort">Remote Tunnel Port</label>
      <input type="text" id="remotePort" placeholder="18794" value="18794">
      <p class="help">Port on the remote machine. Each remote needs a unique port. Remote Claude Code uses PKRELAY_BROKER=ws://localhost:PORT/mcp-client</p>
    </div>
    <div class="btn-row" style="margin-top: 16px;">
      <button class="btn-primary" id="setupRemoteBtn">Setup & Connect</button>
      <span id="setupStatus"></span>
    </div>
  </div>
</div>
```

### Step 2: Add CSS for remote session cards

```css
/* Remote session cards */
.remote-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  margin-bottom: 8px;
}

.remote-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.remote-alias {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.remote-detail {
  font-size: 12px;
  color: #8a8a9a;
}

.remote-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.remote-status .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.remote-status .dot.connected { background: #22C55E; }
.remote-status .dot.connecting { background: #F59E0B; }
.remote-status .dot.disconnected { background: #6B7280; }
.remote-status .dot.error { background: #EF4444; }

.remote-actions {
  display: flex;
  gap: 8px;
}

.remote-actions button {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-danger {
  background: #7F1D1D;
  color: #FCA5A5;
  border: 1px solid #991B1B;
}

.btn-danger:hover {
  background: #991B1B;
}
```

### Step 3: Add remote session logic to options.js

```javascript
// --- Remote Sessions ---

function renderRemoteList(remotes) {
  const container = $('#remoteList');
  if (!remotes || remotes.length === 0) {
    container.innerHTML = '<p class="help">No remote sessions configured.</p>';
    return;
  }
  container.innerHTML = remotes.map(r => `
    <div class="remote-card" data-alias="${r.alias}">
      <div class="remote-info">
        <span class="remote-alias">${r.alias}</span>
        <span class="remote-detail">${r.config.username}@${r.config.host} → port ${r.config.remotePort}</span>
      </div>
      <div class="remote-status">
        <span class="dot ${r.tunnelState}"></span>
        <span>${r.tunnelState}${r.error ? ': ' + r.error : ''}</span>
      </div>
      <div class="remote-actions">
        ${r.tunnelState === 'connected'
          ? '<button class="btn-secondary remote-disconnect">Disconnect</button>'
          : '<button class="btn-secondary remote-connect">Connect</button>'}
        <button class="btn-danger remote-remove">Remove</button>
      </div>
    </div>
  `).join('');

  // Bind action buttons
  container.querySelectorAll('.remote-connect').forEach(btn => {
    btn.addEventListener('click', () => {
      const alias = btn.closest('.remote-card').dataset.alias;
      sendRelayCommand('pkrelay.remote.connect', { alias });
    });
  });
  container.querySelectorAll('.remote-disconnect').forEach(btn => {
    btn.addEventListener('click', () => {
      const alias = btn.closest('.remote-card').dataset.alias;
      sendRelayCommand('pkrelay.remote.disconnect', { alias });
    });
  });
  container.querySelectorAll('.remote-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const alias = btn.closest('.remote-card').dataset.alias;
      if (confirm(`Remove remote "${alias}"? This deletes the key pair and tunnel config.`)) {
        sendRelayCommand('pkrelay.remote.remove', { alias });
      }
    });
  });
}

function sendRelayCommand(method, params) {
  // Route through background.js which forwards to broker
  chrome.runtime.sendMessage({ type: 'relayCommand', method, params }, (resp) => {
    if (chrome.runtime.lastError) {
      showToast('Error: ' + chrome.runtime.lastError.message);
      return;
    }
    if (resp?.error) {
      showToast('Error: ' + resp.error);
    }
    // Refresh list after action
    setTimeout(loadRemotes, 500);
  });
}

async function loadRemotes() {
  chrome.runtime.sendMessage({ type: 'relayCommand', method: 'pkrelay.remote.list', params: {} }, (resp) => {
    if (chrome.runtime.lastError) return;
    renderRemoteList(resp?.result || []);
  });
}

// Setup & Connect button
$('#setupRemoteBtn').addEventListener('click', async () => {
  const alias = $('#remoteAlias').value.trim();
  const host = $('#remoteHost').value.trim();
  const username = $('#remoteUser').value.trim();
  const password = $('#remotePassword').value;
  const remotePort = parseInt($('#remotePort').value) || 18794;

  if (!alias || !host || !username || !password) {
    showSetupStatus('error', 'All fields are required');
    return;
  }

  showSetupStatus('checking', 'Setting up keys and connecting...');

  chrome.runtime.sendMessage({
    type: 'relayCommand',
    method: 'pkrelay.remote.setup',
    params: { alias, host, username, password, remotePort },
  }, (resp) => {
    if (chrome.runtime.lastError) {
      showSetupStatus('error', chrome.runtime.lastError.message);
      return;
    }
    if (resp?.result?.success) {
      showSetupStatus('ok', 'Connected! Key-based auth configured.');
      // Clear password field — never store it
      $('#remotePassword').value = '';
      loadRemotes();
    } else {
      showSetupStatus('error', resp?.result?.error || resp?.error || 'Setup failed');
    }
  });
});

function showSetupStatus(type, text) {
  const el = $('#setupStatus');
  el.className = `status ${type}`;
  el.innerHTML = `<span class="status-dot"></span>${text}`;
}

// Load remotes on page load
loadRemotes();
```

### Step 4: Add relay command forwarding in background.js

Add a new handler in the `chrome.runtime.onMessage` listener in background.js:

```javascript
if (msg.type === 'relayCommand') {
  // Forward to broker via relay WebSocket
  relay.request(msg.method, msg.params, 30000)
    .then(result => sendResponse({ result }))
    .catch(err => sendResponse({ error: err.message }));
  return true; // async response
}
```

### Step 5: Listen for broker status updates in background.js

When the broker pushes `pkrelay.remote.statusUpdate` events, relay them to any open options page:

```javascript
relay.on('pkrelay.remote.statusUpdate', (msg) => {
  // Forward to options page if open
  chrome.runtime.sendMessage({
    type: 'remoteStatusUpdate',
    status: msg.params,
  }).catch(() => {}); // options page may not be open
});
```

And in options.js, listen for these updates:

```javascript
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'remoteStatusUpdate') {
    loadRemotes(); // Refresh the list
  }
});
```

### Step 6: Commit

```bash
git add extension/options.html extension/options.js extension/background.js
git commit -m "feat: add Remote Sessions UI for one-click SSH tunnel setup"
```

---

## Summary of New Startup Modes

| Condition | Mode | Behavior |
|-----------|------|----------|
| `--daemon` flag | Daemon | Broker only, no stdio MCP. Stays alive. Restores tunnels from `~/.pkrelay/remotes.json`. |
| `PKRELAY_BROKER` env set | Client | Connects to specified broker URL (local or remote via SSH tunnel). |
| Port available | Broker+MCP | Binds port, accepts extension + clients, serves MCP on stdio. |
| Port in use (EADDRINUSE) | Client (auto) | Connects to `ws://localhost:PORT/mcp-client`. |

## Remote Dev Onboarding Flow

```
1. Dev installs PKRelay extension in Chrome on their laptop
2. Extension auto-starts broker daemon via native messaging
3. Dev opens PKRelay Settings → Remote Sessions → "Add Remote Machine"
4. Enters: alias (mac-studio), host, username, SSH password, port (18794)
5. Clicks "Setup & Connect"
6. Broker generates ed25519 key pair → ~/.pkrelay/keys/mac-studio
7. Broker connects via ssh2 with password, installs public key
8. Broker verifies key-based auth works
9. Broker spawns: ssh -i ~/.pkrelay/keys/mac-studio -R 18794:localhost:18793 ...
10. On Mac Studio, dev's Claude Code .claude.json has:
    PKRELAY_BROKER=ws://localhost:18794/mcp-client
11. Claude Code launches pkrelay in client mode → connects through tunnel → uses dev's Chrome
12. Password was never stored. Key pair lives in ~/.pkrelay/keys/. Tunnel auto-reconnects.
```
