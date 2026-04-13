// relay.js — WebSocket bridge to PKRelay MCP server
//
// The MCP server runs a WebSocket server on localhost:18793.
// The extension connects to it for bidirectional tool communication.
// This replaces native messaging because the MCP server needs
// stdin/stdout for the MCP protocol (talking to Claude Code).

const KEEPALIVE_ALARM = 'pkrelay-keepalive';
const RECONNECT_ALARM = 'pkrelay-reconnect';
const KEEPALIVE_INTERVAL_MIN = 0.42; // ~25 seconds
const DEFAULT_PORT = 18793;

export class RelayConnection {
  constructor() {
    this.ws = null;
    this.serverPort = DEFAULT_PORT;
    this.reconnectAttempts = 0;
    this.state = 'disconnected'; // disconnected | connecting | connected | reconnecting
    this.messageHandlers = new Map();
    this.pendingRequests = new Map();
    this.nextId = 1;
    this.onStateChange = null;
    this.connectedAt = 0;
  }

  on(method, handler) {
    this.messageHandlers.set(method, handler);
  }

  async request(method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to MCP server');
    }
    this.ws.send(JSON.stringify(message));
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    // Load port from storage
    const stored = await chrome.storage.local.get(['mcpServerPort']);
    this.serverPort = stored.mcpServerPort || DEFAULT_PORT;

    this.state = 'connecting';
    this.onStateChange?.(this.state);

    try {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.serverPort}`);

      this.ws.onopen = () => {
        this.state = 'connected';
        this.connectedAt = Date.now();
        this.reconnectAttempts = 0;
        this.onStateChange?.(this.state);
        chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._onMessage(msg);
        } catch { /* skip malformed */ }
      };

      this.ws.onclose = () => {
        this._onDisconnect();
      };

      this.ws.onerror = () => {
        // onerror is always followed by onclose, so cleanup happens there
      };
    } catch (err) {
      this.state = 'disconnected';
      this.onStateChange?.(this.state);
      this._scheduleReconnect();
    }
  }

  disconnect() {
    chrome.alarms.clear(KEEPALIVE_ALARM);
    chrome.alarms.clear(RECONNECT_ALARM);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.state = 'disconnected';
    this.onStateChange?.(this.state);
  }

  _onMessage(msg) {
    // Response to a pending request
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this.pendingRequests.get(msg.id);
      clearTimeout(timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || msg.error));
      else resolve(msg.result);
      return;
    }

    // Incoming request from MCP server (tool call)
    if (msg.method && this.messageHandlers.has(msg.method)) {
      const handler = this.messageHandlers.get(msg.method);
      handler(msg);
      return;
    }
  }

  _onDisconnect() {
    this.ws = null;
    this.state = 'disconnected';
    this.onStateChange?.(this.state);

    // Reject all pending requests
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('Disconnected from MCP server'));
    }
    this.pendingRequests.clear();

    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + delay });
  }

  handleAlarm(alarm) {
    if (alarm.name === KEEPALIVE_ALARM) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ method: 'ping' });
      }
    } else if (alarm.name === RECONNECT_ALARM) {
      this.connect();
    }
  }
}
