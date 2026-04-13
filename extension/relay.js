// relay.js — Native messaging bridge to PKRelay MCP server
const KEEPALIVE_ALARM = 'pkrelay-keepalive';
const RECONNECT_ALARM = 'pkrelay-reconnect';
const KEEPALIVE_INTERVAL_MIN = 0.42;
const NM_HOST_NAME = 'com.nooma.pkrelay';

export class RelayConnection {
  constructor() {
    this.port = null;
    this.reconnectAttempts = 0;
    this.state = 'disconnected';
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
    if (!this.port) throw new Error('Not connected');
    this.port.postMessage(message);
  }

  connect() {
    if (this.port) return;
    this.state = 'connecting';
    this.onStateChange?.(this.state);

    try {
      this.port = chrome.runtime.connectNative(NM_HOST_NAME);
      this.port.onMessage.addListener((msg) => this._onMessage(msg));
      this.port.onDisconnect.addListener(() => this._onDisconnect());
      this.state = 'connected';
      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.onStateChange?.(this.state);
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
    } catch (err) {
      this.state = 'disconnected';
      this.onStateChange?.(this.state);
      this._scheduleReconnect();
    }
  }

  disconnect() {
    chrome.alarms.clear(KEEPALIVE_ALARM);
    chrome.alarms.clear(RECONNECT_ALARM);
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
    this.state = 'disconnected';
    this.onStateChange?.(this.state);
  }

  _onMessage(msg) {
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this.pendingRequests.get(msg.id);
      clearTimeout(timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || msg.error));
      else resolve(msg.result);
      return;
    }
    if (msg.method && this.messageHandlers.has(msg.method)) {
      this.messageHandlers.get(msg.method)(msg);
    }
  }

  _onDisconnect() {
    this.port = null;
    this.state = 'disconnected';
    this.onStateChange?.(this.state);
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('Disconnected'));
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
      if (this.port) this.send({ method: 'ping' });
    } else if (alarm.name === RECONNECT_ALARM) {
      this.connect();
    }
  }
}
