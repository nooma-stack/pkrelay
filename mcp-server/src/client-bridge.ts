// mcp-server/src/client-bridge.ts
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { Bridge } from './bridge-interface.js';

interface BridgeMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string };
}

// Backoff schedule (ms) for reconnect attempts. Chosen to retry fast
// enough that a Chrome service-worker cycle (~30s idle kill) doesn't
// leave the user waiting, but slow enough that a permanently-down
// broker doesn't hammer the machine.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];

// When a request arrives while we're reconnecting, wait up to this long
// for the socket to come back before failing the request. Keeps
// short-lived disconnects transparent to the caller.
const REQUEST_WAIT_FOR_RECONNECT_MS = 5000;

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
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(brokerUrl: string) {
    super();
    this.brokerUrl = brokerUrl;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // First connect: resolve/reject based on the initial attempt so the
    // MCP server startup gets a clear success/failure signal. Subsequent
    // reconnects are handled silently in the background.
    await this.connectOnce(/* rejectOnError */ true);
  }

  private connectOnce(rejectOnError: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.brokerUrl);
      this.ws = ws;

      ws.on('open', () => {
        this._connected = true;
        this.reconnectAttempt = 0;
        this.emit('connected');
        process.stderr.write(`[pkrelay] Connected to broker at ${this.brokerUrl}\n`);
        resolve();
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg: BridgeMessage = JSON.parse(data.toString('utf-8'));
          this.handleMessage(msg);
        } catch { /* skip malformed */ }
      });

      ws.on('close', () => {
        const wasConnected = this._connected;
        this._connected = false;
        this.rejectAllPending('Broker connection closed');
        if (wasConnected) {
          this.emit('disconnected');
          process.stderr.write('[pkrelay] Disconnected from broker — scheduling reconnect\n');
        }
        this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        if (!this._connected) {
          // Initial connect failure OR reconnect attempt failure.
          if (rejectOnError) {
            reject(new Error(`Cannot connect to broker at ${this.brokerUrl}: ${err.message}`));
          } else {
            process.stderr.write(`[pkrelay] Reconnect attempt failed: ${err.message}\n`);
          }
          // 'close' will fire after 'error' and will schedule the next retry.
        } else {
          // Mid-session error; 'close' handler will run next and handle cleanup.
          this._connected = false;
        }
      });
    });
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) return; // already scheduled

    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ];
    this.reconnectAttempt++;
    process.stderr.write(
      `[pkrelay] Reconnect attempt #${this.reconnectAttempt} in ${delay}ms\n`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      // Fire and forget — errors are logged inside connectOnce and will
      // trigger another scheduleReconnect via the 'close' handler.
      this.connectOnce(/* rejectOnError */ false).catch(() => {});
    }, delay);
  }

  private handleMessage(msg: BridgeMessage) {
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    // Short-lived disconnects (service-worker cycles etc.) should be
    // transparent: if we're mid-reconnect, give the socket a brief
    // window to come back before failing the call.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.stopped) {
        throw new Error('Bridge stopped');
      }
      const waited = await this.waitForReconnect(REQUEST_WAIT_FOR_RECONNECT_MS);
      if (!waited) {
        throw new Error('Not connected to broker. Ensure the PKRelay broker is running.');
      }
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

  private waitForReconnect(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this._connected && this.ws?.readyState === WebSocket.OPEN) {
        resolve(true);
        return;
      }
      const onConnected = () => {
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('connected', onConnected);
      };
      this.on('connected', onConnected);
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
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }
}
