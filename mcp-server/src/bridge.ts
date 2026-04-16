import { EventEmitter } from 'events';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Bridge } from './bridge-interface.js';
import type { Duplex } from 'stream';
import { TunnelManager, type RemoteStatus } from './tunnel-manager.js';

interface BridgeMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string };
}

/** Mapping from a broker-assigned global ID back to the originating client. */
interface ProxiedRequest {
  clientWs: WebSocket;
  originalId: number;
}

const DEFAULT_PORT = 18793;

/**
 * Bridge between MCP server and Chrome extension via local WebSocket.
 *
 * The MCP server runs a WebSocket server on localhost. The extension
 * connects from background.js using `new WebSocket('ws://127.0.0.1:PORT')`.
 * Messages are JSON objects.
 *
 * Path-based routing:
 * - `/extension` (or `/` for backward compat) -> single extension connection
 * - `/mcp-client` -> multiple MCP client connections, multiplexed to the extension
 *
 * Why WebSocket instead of native messaging:
 * - MCP server uses stdin/stdout for MCP protocol (talking to Claude Code)
 * - Chrome native messaging also uses stdin/stdout
 * - They can't share the same stdio pipes
 * - WebSocket gives bidirectional streaming on localhost
 */
export class NativeMessagingBridge extends EventEmitter implements Bridge {
  public readonly tunnelManager = new TunnelManager();

  /** Pending requests initiated by the broker itself (via this.request()). */
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  /** Pending requests proxied from MCP clients, keyed by globalId. */
  private proxiedRequests = new Map<number, ProxiedRequest>();

  /** Connected MCP clients, keyed by auto-incrementing clientId. */
  private mcpClients = new Map<number, WebSocket>();

  private nextId = 1;
  private nextGlobalId = 1_000_000;
  private nextClientId = 1;

  private httpServer: HttpServer | null = null;
  private extensionWss: WebSocketServer | null = null;
  private mcpClientWss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private _connected = false;
  private port: number;

  constructor(port?: number) {
    super();
    this.port = port ?? DEFAULT_PORT;

    this.tunnelManager.on('statusChanged', (status: RemoteStatus) => {
      if (this.socket) {
        try {
          this.sendToExtension({ method: 'pkrelay.remote.statusUpdate', params: status as unknown as Record<string, unknown> });
        } catch { /* extension may not be connected */ }
      }
    });
  }

  /** Start listening for extension and MCP client connections. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });

      // Both WSS instances use noServer mode — we route upgrades manually.
      this.extensionWss = new WebSocketServer({ noServer: true });
      this.mcpClientWss = new WebSocketServer({ noServer: true });

      this.extensionWss.on('connection', (ws) => this.handleExtensionConnection(ws));
      this.mcpClientWss.on('connection', (ws) => this.handleMcpClientConnection(ws));

      this.httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : '/';

        if (pathname === '/extension' || pathname === '/') {
          this.extensionWss!.handleUpgrade(req, socket, head, (ws) => {
            this.extensionWss!.emit('connection', ws, req);
          });
        } else if (pathname === '/mcp-client') {
          this.mcpClientWss!.handleUpgrade(req, socket, head, (ws) => {
            this.mcpClientWss!.emit('connection', ws, req);
          });
        } else {
          socket.destroy();
        }
      });

      this.httpServer.on('error', reject);
      this.httpServer.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  // ── Extension connection handling ──────────────────────────────────

  private handleExtensionConnection(ws: WebSocket) {
    // Only allow one extension connection at a time
    if (this.socket) {
      ws.close(4000, 'Only one extension connection allowed');
      return;
    }
    this.socket = ws;
    this._connected = true;
    this.emit('connected');
    process.stderr.write('[pkrelay] Extension connected\n');

    ws.on('message', (data: Buffer) => {
      try {
        const msg: BridgeMessage = JSON.parse(data.toString('utf-8'));
        this.handleExtensionMessage(msg);
      } catch { /* skip malformed */ }
    });

    ws.on('close', () => {
      this.socket = null;
      this._connected = false;
      this.rejectAllPending('Extension disconnected');
      this.rejectAllProxied('Extension disconnected');
      this.emit('disconnected');
      process.stderr.write('[pkrelay] Extension disconnected\n');
    });

    ws.on('error', () => {
      this.socket = null;
      this._connected = false;
      this.rejectAllPending('Extension connection error');
      this.rejectAllProxied('Extension connection error');
      this.emit('disconnected');
    });
  }

  private handleExtensionMessage(msg: BridgeMessage) {
    // Handle remote management commands from extension
    if (msg.method?.startsWith('pkrelay.remote.')) {
      this.handleRemoteCommand(msg);
      return;
    }

    // Check if this is a response to a proxied MCP-client request
    if (msg.id && this.proxiedRequests.has(msg.id)) {
      const { clientWs, originalId } = this.proxiedRequests.get(msg.id)!;
      this.proxiedRequests.delete(msg.id);

      // Rewrite the ID back to the client's original and forward
      const response: BridgeMessage = { id: originalId };
      if (msg.error) response.error = msg.error;
      else response.result = msg.result;

      try {
        clientWs.send(JSON.stringify(response));
      } catch { /* client may have disconnected */ }
      return;
    }

    // Check if this is a response to a local broker request
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }

    // Otherwise it's an unsolicited event from the extension
    if (msg.method) this.emit(msg.method, msg);
  }

  private async handleRemoteCommand(msg: BridgeMessage) {
    const { id, method, params } = msg;
    try {
      let result: unknown;
      switch (method) {
        case 'pkrelay.remote.setup': {
          const p = params as { alias: string; host: string; username: string; password: string; remotePort: number };
          result = await this.tunnelManager.setupKeys(p.alias, p.host, p.username, p.password, p.remotePort, this.port);
          if ((result as { success: boolean }).success) {
            this.tunnelManager.startTunnel(p.alias);
          }
          break;
        }
        case 'pkrelay.remote.connect': {
          const p = params as { alias: string };
          result = { started: this.tunnelManager.startTunnel(p.alias) };
          break;
        }
        case 'pkrelay.remote.disconnect': {
          const p = params as { alias: string };
          this.tunnelManager.stopTunnel(p.alias);
          result = { stopped: true };
          break;
        }
        case 'pkrelay.remote.remove': {
          const p = params as { alias: string };
          this.tunnelManager.removeRemote(p.alias);
          result = { removed: true };
          break;
        }
        case 'pkrelay.remote.list': {
          result = this.tunnelManager.getRemotes();
          break;
        }
        default:
          throw new Error(`Unknown remote command: ${method}`);
      }
      if (id != null) {
        this.sendToExtension({ id, result });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (id != null) {
        this.sendToExtension({ id, error: { code: 'REMOTE_ERROR', message } });
      }
    }
  }

  // ── MCP client connection handling ─────────────────────────────────

  private handleMcpClientConnection(ws: WebSocket) {
    const clientId = this.nextClientId++;
    this.mcpClients.set(clientId, ws);
    process.stderr.write(`[pkrelay] MCP client ${clientId} connected\n`);

    ws.on('message', (data: Buffer) => {
      try {
        const msg: BridgeMessage = JSON.parse(data.toString('utf-8'));
        this.handleMcpClientMessage(clientId, ws, msg);
      } catch { /* skip malformed */ }
    });

    ws.on('close', () => {
      this.mcpClients.delete(clientId);
      this.rejectProxiedForClient(ws, 'MCP client disconnected');
      process.stderr.write(`[pkrelay] MCP client ${clientId} disconnected\n`);
    });

    ws.on('error', () => {
      this.mcpClients.delete(clientId);
      this.rejectProxiedForClient(ws, 'MCP client connection error');
    });
  }

  private handleMcpClientMessage(clientId: number, clientWs: WebSocket, msg: BridgeMessage) {
    if (msg.id == null || !msg.method) {
      // Not a valid request — ignore
      return;
    }

    if (!this.socket) {
      // Extension not connected — send error back to client immediately
      const errorResponse: BridgeMessage = {
        id: msg.id,
        error: { code: 'EXTENSION_NOT_CONNECTED', message: 'Extension not connected' },
      };
      try {
        clientWs.send(JSON.stringify(errorResponse));
      } catch { /* client may have disconnected */ }
      return;
    }

    // Assign a global ID and proxy to extension
    const globalId = this.nextGlobalId++;
    this.proxiedRequests.set(globalId, { clientWs, originalId: msg.id });

    const forwarded: BridgeMessage = { id: globalId, method: msg.method };
    if (msg.params) forwarded.params = msg.params;
    this.socket.send(JSON.stringify(forwarded));
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Send a raw message to the extension. */
  send(msg: BridgeMessage) {
    if (!this.socket) throw new Error('Extension not connected');
    this.socket.send(JSON.stringify(msg));
  }

  /**
   * Send an unsolicited message to the extension.
   * Useful for pushing status updates, tunnel notifications, etc.
   */
  sendToExtension(msg: Record<string, unknown>) {
    if (!this.socket) throw new Error('Extension not connected');
    this.socket.send(JSON.stringify(msg));
  }

  /**
   * Send a request from the broker process itself to the extension and
   * wait for the response. This is the "local direct" path used when
   * the broker is also acting as an MCP server.
   */
  async request(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    if (!this.socket) {
      throw new Error('Extension not connected. Make sure PKRelay is loaded in Chrome and has connected to the MCP server.');
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Bridge request timeout: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  get isConnected() { return this._connected; }

  async stop() {
    this.socket?.close();

    // Close all MCP client connections
    for (const [, ws] of this.mcpClients) {
      ws.close();
    }
    this.mcpClients.clear();

    this.extensionWss?.close();
    this.mcpClientWss?.close();

    await new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
    this.httpServer = null;
  }

  // ── Cleanup helpers ────────────────────────────────────────────────

  private rejectAllPending(reason: string) {
    for (const [, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private rejectAllProxied(reason: string) {
    for (const [globalId, { clientWs, originalId }] of this.proxiedRequests) {
      const errorResponse: BridgeMessage = {
        id: originalId,
        error: { code: 'EXTENSION_DISCONNECTED', message: reason },
      };
      try {
        clientWs.send(JSON.stringify(errorResponse));
      } catch { /* client may have disconnected too */ }
      this.proxiedRequests.delete(globalId);
    }
  }

  private rejectProxiedForClient(clientWs: WebSocket, reason: string) {
    for (const [globalId, entry] of this.proxiedRequests) {
      if (entry.clientWs === clientWs) {
        // The client is gone — just clean up the mapping.
        // No point sending an error back since they disconnected.
        this.proxiedRequests.delete(globalId);
      }
    }
  }
}
