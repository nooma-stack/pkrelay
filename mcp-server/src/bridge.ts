import { EventEmitter } from 'events';

interface BridgeMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string };
}

export class NativeMessagingBridge extends EventEmitter {
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private connected = false;

  constructor() {
    super();
    this.setupStdio();
  }

  private setupStdio() {
    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });
    process.stdin.on('end', () => {
      this.connected = false;
      this.emit('disconnected');
    });
    this.connected = true;
  }

  private processBuffer() {
    while (this.buffer.length >= 4) {
      const msgLen = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + msgLen) break;
      const msgBytes = this.buffer.subarray(4, 4 + msgLen);
      this.buffer = this.buffer.subarray(4 + msgLen);
      try {
        const msg: BridgeMessage = JSON.parse(msgBytes.toString('utf-8'));
        this.handleMessage(msg);
      } catch { /* skip malformed */ }
    }
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
    const json = JSON.stringify(msg);
    const buf = Buffer.alloc(4 + Buffer.byteLength(json));
    buf.writeUInt32LE(Buffer.byteLength(json), 0);
    buf.write(json, 4);
    process.stdout.write(buf);
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
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

  get isConnected() { return this.connected; }
}
