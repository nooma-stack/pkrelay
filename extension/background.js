// background.js — PKRelay service worker entry point (v3.0 MCP mode)
// Transport: native messaging → MCP server → Claude/ChatGPT/Gemini
import { RelayConnection } from './relay.js';
import { TabManager } from './tabs.js';
import { PermissionManager } from './permissions.js';
import { PerceptionEngine } from './perception.js';
import { ActionExecutor } from './actions.js';

const relay = new RelayConnection();
const tabMgr = new TabManager(relay);
const perms = new PermissionManager();
const perception = new PerceptionEngine();
const actions = new ActionExecutor();

// Expose for debugging
self._relay = relay;
self._tabMgr = tabMgr;

// --- Console and Network buffers ---

class ConsoleBuffer {
  constructor(maxSize = 500) {
    this.messages = [];
    this.maxSize = maxSize;
  }

  add(tabId, entry) {
    this.messages.push({ tabId, timestamp: Date.now(), ...entry });
    if (this.messages.length > this.maxSize) {
      this.messages.shift();
    }
  }

  query(filters = {}) {
    let result = this.messages;
    if (filters.tabId != null) {
      result = result.filter(m => m.tabId === filters.tabId);
    }
    if (filters.level) {
      result = result.filter(m => m.level === filters.level);
    }
    if (filters.since) {
      result = result.filter(m => m.timestamp >= filters.since);
    }
    if (filters.limit) {
      result = result.slice(-filters.limit);
    }
    return result;
  }

  clear(tabId) {
    if (tabId != null) {
      this.messages = this.messages.filter(m => m.tabId !== tabId);
    } else {
      this.messages = [];
    }
  }
}

class NetworkBuffer {
  constructor(maxSize = 300) {
    this.requests = new Map(); // requestId -> request data
    this.completed = [];
    this.maxSize = maxSize;
  }

  onRequestWillBeSent(tabId, params) {
    this.requests.set(params.requestId, {
      tabId,
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      type: params.type || 'Other',
      timestamp: Date.now(),
      status: 'pending',
      headers: params.request.headers,
    });
  }

  onResponseReceived(tabId, params) {
    const req = this.requests.get(params.requestId);
    if (req) {
      req.status = 'complete';
      req.statusCode = params.response.status;
      req.statusText = params.response.statusText;
      req.mimeType = params.response.mimeType;
      req.responseHeaders = params.response.headers;
      req.completedAt = Date.now();
      this.completed.push(req);
      this.requests.delete(params.requestId);
      if (this.completed.length > this.maxSize) {
        this.completed.shift();
      }
    }
  }

  onLoadingFailed(tabId, params) {
    const req = this.requests.get(params.requestId);
    if (req) {
      req.status = 'failed';
      req.errorText = params.errorText;
      req.completedAt = Date.now();
      this.completed.push(req);
      this.requests.delete(params.requestId);
    }
  }

  query(filters = {}) {
    let result = [...this.completed];
    if (filters.tabId != null) {
      result = result.filter(r => r.tabId === filters.tabId);
    }
    if (filters.urlPattern) {
      const regex = new RegExp(filters.urlPattern);
      result = result.filter(r => regex.test(r.url));
    }
    if (filters.method) {
      result = result.filter(r => r.method === filters.method);
    }
    if (filters.since) {
      result = result.filter(r => r.timestamp >= filters.since);
    }
    if (filters.limit) {
      result = result.slice(-filters.limit);
    }
    return result;
  }

  clear(tabId) {
    if (tabId != null) {
      this.completed = this.completed.filter(r => r.tabId !== tabId);
      for (const [id, req] of this.requests) {
        if (req.tabId === tabId) this.requests.delete(id);
      }
    } else {
      this.completed = [];
      this.requests.clear();
    }
  }

  get pendingCount() {
    return this.requests.size;
  }
}

const consoleBuffer = new ConsoleBuffer();
const networkBuffer = new NetworkBuffer();

// --- Badge management ---
const BADGE = {
  on:         { text: 'ON',  bg: '#22C55E' },
  off:        { text: '',    bg: '#000000' },
  connecting: { text: '...', bg: '#F59E0B' },
  error:      { text: '!',   bg: '#B91C1C' },
  ask:        { text: '?',   bg: '#3B82F6' },
};

function setBadge(tabId, state) {
  const cfg = BADGE[state];
  if (!cfg) return;
  const opts = tabId ? { tabId } : {};
  chrome.action.setBadgeText({ ...opts, text: cfg.text });
  chrome.action.setBadgeBackgroundColor({ ...opts, color: cfg.bg });
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {});
}

function updateGlobalBadge() {
  const attached = tabMgr.getAttachedTabs();
  if (relay.state !== 'connected') {
    if (relay.state === 'connecting') {
      setBadge(null, 'connecting');
    } else {
      setBadge(null, 'error');
    }
    return;
  }
  if (attached.size > 0) {
    setBadge(null, 'on');
  } else {
    setBadge(null, 'off');
  }
}

function updateTabBadge(tabId) {
  if (perms.hasPendingRequest(tabId)) {
    setBadge(tabId, 'ask');
  } else if (tabMgr.isAttached(tabId)) {
    setBadge(tabId, 'on');
  } else {
    setBadge(tabId, 'off');
  }
}

// --- Alarm handler (relay keepalive & reconnect) ---
chrome.alarms.onAlarm.addListener((alarm) => relay.handleAlarm(alarm));

// --- Permission manager init ---
perms.load();
perms.onPendingChange = (tabId) => updateTabBadge(tabId);

// --- Tab manager init ---
tabMgr.setPermissionManager(perms);
tabMgr.onTabChange = (tabId, attached) => {
  updateTabBadge(tabId);
  updateGlobalBadge();
  notifyPopup();
  // Enable Runtime and Network domains when attaching for console/network monitoring
  if (attached) {
    enableMonitoring(tabId);
  }
};
tabMgr.init();

// --- Enable Runtime + Network domains for console/network monitoring ---
async function enableMonitoring(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
  } catch (err) {
    console.log(`[PKRelay] enableMonitoring failed for tab ${tabId}:`, err.message);
  }
}

// --- Debugger event listener for console/network buffering ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabMgr.isAttached(tabId)) return;

  // Console messages
  if (method === 'Runtime.consoleAPICalled') {
    consoleBuffer.add(tabId, {
      level: params.type, // log, warn, error, info, debug
      text: params.args?.map(a => a.value ?? a.description ?? String(a.type)).join(' ') || '',
      stackTrace: params.stackTrace,
    });
  }
  if (method === 'Runtime.exceptionThrown') {
    consoleBuffer.add(tabId, {
      level: 'error',
      text: params.exceptionDetails?.text || 'Exception thrown',
      exception: params.exceptionDetails?.exception?.description,
      stackTrace: params.exceptionDetails?.stackTrace,
    });
  }
  if (method === 'Log.entryAdded') {
    consoleBuffer.add(tabId, {
      level: params.entry?.level || 'log',
      text: params.entry?.text || '',
      source: params.entry?.source,
      url: params.entry?.url,
    });
  }

  // Network events
  if (method === 'Network.requestWillBeSent') {
    networkBuffer.onRequestWillBeSent(tabId, params);
  }
  if (method === 'Network.responseReceived') {
    networkBuffer.onResponseReceived(tabId, params);
  }
  if (method === 'Network.loadingFailed') {
    networkBuffer.onLoadingFailed(tabId, params);
  }
});

// --- Auto-connect on startup ---
relay.connect();

relay.onStateChange = (state) => {
  updateGlobalBadge();
  notifyPopup();
  if (state === 'connected') {
    tabMgr.clearUserDetached();
    autoAttachActiveTab();
  }
};

async function autoAttachActiveTab() {
  if (tabMgr.getAttachedTabs().size > 0) return;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!activeTab || !activeTab.url || activeTab.url.startsWith('chrome')) return;
    const level = perms.getLevel(activeTab.url);
    if (level !== 'full') return;
    if (tabMgr.isUserDetached(activeTab.id)) return;
    await tabMgr.attachTab(activeTab.id);
    console.log(`[PKRelay] Auto-attached tab ${activeTab.id}: ${activeTab.title}`);
  } catch (err) {
    console.log('[PKRelay] Auto-attach failed:', err.message);
  }
}

// --- Helper to resolve tabTarget to a tabId ---
function resolveTabTarget(tabTarget) {
  if (typeof tabTarget === 'number') return tabTarget;
  // Fallback: first attached tab
  for (const [tabId] of tabMgr.getAttachedTabs()) {
    return tabId;
  }
  return null;
}

// --- MCP tool message handlers ---
// Each handler follows: relay.on('method', async (msg) => { ... })
// and responds with relay.send({ id, result }) or relay.send({ id, error })

// snapshot — get accessibility tree snapshot of active tab
relay.on('snapshot', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = resolveTabTarget(params?.tabId);
    if (tabId == null) throw new Error('No attached tab');
    await tabMgr.enforcePermission(tabId);
    const result = await perception.snapshot(tabId, {
      diff: params?.diff,
      elementId: params?.elementId,
      depth: params?.depth,
      selector: params?.selector,
    });
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: { code: 'SNAPSHOT_ERROR', message: err.message } });
  }
});

// screenshot — capture page or element screenshot
relay.on('screenshot', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = resolveTabTarget(params?.tabId);
    if (tabId == null) throw new Error('No attached tab');
    await tabMgr.enforcePermission(tabId);

    const screenshotParams = {};
    if (params?.format) screenshotParams.format = params.format;
    if (params?.quality) screenshotParams.quality = params.quality;

    // Support selector-based clipping
    if (params?.selector) {
      const boxResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `JSON.stringify((() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })())`,
        returnByValue: true,
      });
      const rect = JSON.parse(boxResult?.result?.value || 'null');
      if (rect) {
        screenshotParams.clip = { ...rect, scale: 1 };
      }
    }

    // Support region-based clipping
    if (params?.clip) {
      screenshotParams.clip = { ...params.clip, scale: params.clip.scale || 1 };
    }

    // Support element index clipping
    if (params?.elementIndex) {
      screenshotParams.elementIndex = params.elementIndex;
    }

    const result = await perception.takeScreenshot(tabId, screenshotParams);
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: { code: 'SCREENSHOT_ERROR', message: err.message } });
  }
});

// click — click on an element by index
relay.on('click', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = resolveTabTarget(params?.tabId);
    if (tabId == null) throw new Error('No attached tab');
    await tabMgr.enforcePermission(tabId);

    // Resolve element by index, selector, or text
    if (params?.index != null || params?.elementIndex != null) {
      const result = await actions.execute(tabId, {
        command: 'click',
        params: { elementIndex: params.index ?? params.elementIndex },
      });
      relay.send({ id, result });
    } else if (params?.selector || params?.text) {
      const jsExpr = params.selector
        ? `(() => {
            const el = document.querySelector(${JSON.stringify(params.selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: el.textContent?.substring(0, 40) };
          })()`
        : `(() => {
            const target = ${JSON.stringify(params.text)}.toLowerCase();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let node;
            while (node = walker.nextNode()) {
              if (node.children.length > 3) continue;
              const text = node.textContent?.trim().toLowerCase() || '';
              const ariaLabel = (node.getAttribute('aria-label') || '').toLowerCase();
              const title = (node.getAttribute('title') || '').toLowerCase();
              const match = text.includes(target) || ariaLabel.includes(target) || title.includes(target);
              if (match && node.offsetWidth > 0) {
                const r = node.getBoundingClientRect();
                const label = node.textContent?.trim() || node.getAttribute('aria-label') || node.getAttribute('title') || '';
                return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: label.substring(0, 40) };
              }
            }
            return null;
          })()`;

      const evalResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: jsExpr,
        returnByValue: true,
      });
      const coords = evalResult?.result?.value;
      if (!coords) throw new Error(`Element not found: ${params.selector || params.text}`);

      await actions.mouseClick(tabId, coords.x, coords.y);
      relay.send({ id, result: { ok: true, action: `click "${coords.text?.trim()}"` } });
    } else {
      throw new Error('click requires index, selector, or text');
    }
  } catch (err) {
    relay.send({ id, error: { code: 'CLICK_ERROR', message: err.message } });
  }
});

// type — type text into an element
relay.on('type', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = resolveTabTarget(params?.tabId);
    if (tabId == null) throw new Error('No attached tab');
    await tabMgr.enforcePermission(tabId);
    // Focus element by selector or elementIndex before typing
    if (params?.selector) {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (el) { el.focus(); return 'focused'; } return 'not found'; })()`,
        returnByValue: true
      });
      await new Promise(r => setTimeout(r, 50));
    }

    // Clear field if requested
    if (params?.clear) {
      // Select all + delete via keyboard (works regardless of how element was focused)
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, modifiers: 4 // Meta (Cmd on Mac)
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, modifiers: 4
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
        windowsVirtualKeyCode: 8
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Backspace', code: 'Backspace',
        windowsVirtualKeyCode: 8
      });
      await new Promise(r => setTimeout(r, 50));
    }

    const result = await actions.execute(tabId, {
      command: 'type',
      params: { elementIndex: params?.elementIndex, text: params?.text },
    });

    // Submit (press Enter) if requested
    if (params?.submit) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13
      });
    }

    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: { code: 'TYPE_ERROR', message: err.message } });
  }
});

// select — select a value in a dropdown
relay.on('select', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = resolveTabTarget(params?.tabId);
    if (tabId == null) throw new Error('No attached tab');
    await tabMgr.enforcePermission(tabId);
    const result = await actions.execute(tabId, {
      command: 'select',
      params: { elementIndex: params?.elementIndex, value: params?.value },
    });
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: { code: 'SELECT_ERROR', message: err.message } });
  }
});

// navigate — navigate to a URL
relay.on('navigate', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = resolveTabTarget(params?.tabId);
    if (tabId == null) throw new Error('No attached tab');
    await tabMgr.enforcePermission(tabId);
    const result = await actions.execute(tabId, {
      command: 'navigate',
      params: { url: params?.url },
    });
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: { code: 'NAVIGATE_ERROR', message: err.message } });
  }
});

// evaluate — execute JavaScript in the page context
relay.on('evaluate', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = resolveTabTarget(params?.tabId);
    if (tabId == null) throw new Error('No attached tab');
    await tabMgr.enforcePermission(tabId);
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: params?.expression,
      returnByValue: params?.returnByValue !== false,
      awaitPromise: params?.awaitPromise || false,
    });
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: { code: 'EVALUATE_ERROR', message: err.message } });
  }
});

// wait — poll for a condition (selector exists, text visible, network idle)
relay.on('wait', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = resolveTabTarget(params?.tabId);
    if (tabId == null) throw new Error('No attached tab');
    await tabMgr.enforcePermission(tabId);

    const timeout = params?.timeout || 10000;
    const interval = params?.interval || 500;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      // Wait for selector
      if (params?.selector) {
        const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(params.selector)})`,
          returnByValue: true,
        });
        if (result?.result?.value === true) {
          relay.send({ id, result: { ok: true, condition: 'selector', selector: params.selector } });
          return;
        }
      }

      // Wait for text
      if (params?.text) {
        const snapshot = await perception.snapshot(tabId);
        const found = snapshot.content.lines.some(l => l.includes(params.text));
        if (found) {
          relay.send({ id, result: { ok: true, condition: 'text', text: params.text } });
          return;
        }
      }

      // Wait for network idle
      if (params?.networkIdle) {
        if (networkBuffer.pendingCount === 0) {
          relay.send({ id, result: { ok: true, condition: 'networkIdle' } });
          return;
        }
      }

      await new Promise(r => setTimeout(r, interval));
    }

    relay.send({ id, error: { code: 'WAIT_TIMEOUT', message: `Timeout after ${timeout}ms` } });
  } catch (err) {
    relay.send({ id, error: { code: 'WAIT_ERROR', message: err.message } });
  }
});

// console.query — return buffered console messages
relay.on('console.query', async (msg) => {
  const { id, params } = msg;
  try {
    const result = consoleBuffer.query({
      tabId: params?.tabId,
      level: params?.level,
      since: params?.since,
      limit: params?.limit,
    });
    relay.send({ id, result: { messages: result, count: result.length } });
  } catch (err) {
    relay.send({ id, error: { code: 'CONSOLE_QUERY_ERROR', message: err.message } });
  }
});

// console.clear — clear console buffer
relay.on('console.clear', async (msg) => {
  const { id, params } = msg;
  try {
    consoleBuffer.clear(params?.tabId);
    relay.send({ id, result: { ok: true } });
  } catch (err) {
    relay.send({ id, error: { code: 'CONSOLE_CLEAR_ERROR', message: err.message } });
  }
});

// network.query — return buffered network requests
relay.on('network.query', async (msg) => {
  const { id, params } = msg;
  try {
    const result = networkBuffer.query({
      tabId: params?.tabId,
      urlPattern: params?.urlPattern,
      method: params?.method,
      since: params?.since,
      limit: params?.limit,
    });
    relay.send({ id, result: { requests: result, count: result.length, pending: networkBuffer.pendingCount } });
  } catch (err) {
    relay.send({ id, error: { code: 'NETWORK_QUERY_ERROR', message: err.message } });
  }
});

// network.clear — clear network buffer
relay.on('network.clear', async (msg) => {
  const { id, params } = msg;
  try {
    networkBuffer.clear(params?.tabId);
    relay.send({ id, result: { ok: true } });
  } catch (err) {
    relay.send({ id, error: { code: 'NETWORK_CLEAR_ERROR', message: err.message } });
  }
});

// tabs.list — return all tabs with permission/attach status
relay.on('tabs.list', async (msg) => {
  const { id } = msg;
  try {
    const tabPerms = await perms.getTabPermissions();
    const attachedTabs = tabMgr.getAttachedTabs();
    const result = tabPerms
      .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
      .map(t => ({
        tabId: t.tabId,
        url: t.url,
        title: t.title,
        level: t.level,
        attached: attachedTabs.has(t.tabId),
        hasPendingRequest: t.hasPendingRequest,
      }));
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: { code: 'TABS_LIST_ERROR', message: err.message } });
  }
});

// tabs.attach — attach debugger to a tab
relay.on('tabs.attach', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = params?.tabId;
    if (typeof tabId !== 'number') throw new Error('Missing or invalid tabId');
    await tabMgr.enforcePermission(tabId);
    const tabState = await tabMgr.attachTab(tabId);
    relay.send({ id, result: { tabId, sessionId: tabState.sessionId, targetId: tabState.targetId } });
  } catch (err) {
    relay.send({ id, error: { code: 'TABS_ATTACH_ERROR', message: err.message } });
  }
});

// tabs.detach — detach debugger from a tab
relay.on('tabs.detach', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = params?.tabId;
    if (typeof tabId !== 'number') throw new Error('Missing or invalid tabId');
    await tabMgr.detachTab(tabId, 'agent');
    relay.send({ id, result: { tabId, detached: true } });
  } catch (err) {
    relay.send({ id, error: { code: 'TABS_DETACH_ERROR', message: err.message } });
  }
});

// tabs.switch — activate (focus) a tab
relay.on('tabs.switch', async (msg) => {
  const { id, params } = msg;
  try {
    const tabId = params?.tabId;
    if (typeof tabId !== 'number') throw new Error('Missing or invalid tabId');
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    relay.send({ id, result: { tabId, activated: true } });
  } catch (err) {
    relay.send({ id, error: { code: 'TABS_SWITCH_ERROR', message: err.message } });
  }
});

// --- Permission relay handlers ---
relay.on('pkrelay.permission.grant', (msg) => {
  const { tabId, duration } = msg.params || {};
  perms.resolvePermissionRequest(tabId, true, duration);
  updateTabBadge(tabId);
});

relay.on('pkrelay.permission.deny', (msg) => {
  const { tabId } = msg.params || {};
  perms.resolvePermissionRequest(tabId, false);
  updateTabBadge(tabId);
});

// --- Extension reload (callable by agent) ---
relay.on('pkrelay.reload', async (msg) => {
  const { id } = msg;
  relay.send({ id, result: { reloading: true } });
  await new Promise(r => setTimeout(r, 200));
  chrome.runtime.reload();
});

// --- Perception engine setup ---
actions.setPerception(perception);

// --- Popup / internal message passing ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getState') {
    (async () => {
      const stored = await chrome.storage.local.get(['browserName']);
      const tabPerms = await perms.getTabPermissions();
      const attachedTabs = tabMgr.getAttachedTabs();
      const tabs = tabPerms.map(t => ({
        ...t,
        attached: attachedTabs.has(t.tabId),
      }));
      sendResponse({
        connectionState: relay.state,
        browserName: stored.browserName || 'Browser',
        browserLevel: perms.browserLevel,
        tabs,
      });
    })();
    return true;
  }
  if (msg.type === 'setPermission') {
    perms.setRule(msg.pattern, msg.level);
    if (msg.level === 'full' || msg.level === 'none') {
      (async () => {
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
          if (!tab.url || tab.url.startsWith('chrome')) continue;
          if (!perms.matchPattern(msg.pattern, tab.url)) continue;
          if (msg.level === 'full' && !tabMgr.isAttached(tab.id) && relay.state === 'connected') {
            tabMgr.attachTab(tab.id).catch(() => {});
          } else if (msg.level === 'none' && tabMgr.isAttached(tab.id)) {
            tabMgr.detachTab(tab.id, 'permission').catch(() => {});
          }
        }
      })();
    }
    sendResponse({ ok: true });
  }
  if (msg.type === 'setBrowserLevel') {
    perms.setBrowserLevel(msg.level);
    sendResponse({ ok: true });
  }
  if (msg.type === 'toggleTab') {
    tabMgr.toggleTab(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'connect') {
    relay.connect();
    sendResponse({ ok: true });
  }
  if (msg.type === 'respondPermission') {
    perms.resolvePermissionRequest(msg.tabId, msg.granted, msg.duration);
    updateTabBadge(msg.tabId);
    sendResponse({ ok: true });
  }
});
