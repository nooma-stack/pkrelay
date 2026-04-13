import { EventEmitter } from 'events';
import { WebSocketServer, type WebSocket } from 'ws';

interface BridgeMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string };
}

const DEFAULT_PORT = 18793;

/**
 * Bridge between MCP server and Chrome extension via local WebSocket.
 *
 * The MCP server runs a WebSocket server on localhost. The extension
 * connects from background.js using `new WebSocket('ws://127.0.0.1:PORT')`.
 * Messages are JSON objects.
 *
 * Why WebSocket instead of native messaging:
 * - MCP server uses stdin/stdout for MCP protocol (talking to Claude Code)
 * - Chrome native messaging also uses stdin/stdout
 * - They can't share the same stdio pipes
 * - WebSocket gives bidirectional streaming on localhost
 */
export class NativeMessagingBridge extends EventEmitter {
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private _connected = false;
  private port: number;

  constructor(port?: number) {
    super();
    this.port = port ?? DEFAULT_PORT;
  }

  /** Start listening for extension connections. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port: this.port,
        host: '127.0.0.1',
      });

      this.wss.on('connection', (ws) => {
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
            this.handleMessage(msg);
          } catch { /* skip malformed */ }
        });

        ws.on('close', () => {
          this.socket = null;
          this._connected = false;
          this.rejectAllPending('Extension disconnected');
          this.emit('disconnected');
          process.stderr.write('[pkrelay] Extension disconnected\n');
        });

        ws.on('error', () => {
          this.socket = null;
          this._connected = false;
          this.rejectAllPending('Extension connection error');
          this.emit('disconnected');
        });
      });

      this.wss.on('error', reject);
      this.wss.on('listening', () => resolve());
    });
  }

  private handleMessage(msg: BridgeMessage) {
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) this.emit(msg.method, msg);
  }

  send(msg: BridgeMessage) {
    if (!this.socket) throw new Error('Extension not connected');
    this.socket.send(JSON.stringify(msg));
  }

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

  private rejectAllPending(reason: string) {
    for (const [, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  get isConnected() { return this._connected; }

  async stop() {
    this.socket?.close();
    this.wss?.close();
  }
}
