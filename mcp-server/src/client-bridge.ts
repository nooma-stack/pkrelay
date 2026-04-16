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
          const msg: BridgeMessage = JSON.parse(data.toString('utf-8'));
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
