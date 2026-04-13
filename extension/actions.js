// actions.js — High-level action primitives

const KEY_CODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32
};

export class ActionExecutor {
  constructor() {
    this.perception = null; // Set after init
  }

  setPerception(perception) {
    this.perception = perception;
  }

  async execute(tabId, action) {
    const { command, args } = this.parseAction(action);

    switch (command) {
      case 'click':      return this.click(tabId, args);
      case 'dblclick':   return this.dblclick(tabId, args);
      case 'rightclick': return this.rightclick(tabId, args);
      case 'hover':      return this.hover(tabId, args);
      case 'type':       return this.type(tabId, args);
      case 'clear':      return this.clear(tabId, args);
      case 'select':     return this.select(tabId, args);
      case 'check':      return this.check(tabId, args);
      case 'uncheck':    return this.uncheck(tabId, args);
      case 'focus':      return this.focus(tabId, args);
      case 'scroll':     return this.scroll(tabId, args);
      case 'drag':       return this.drag(tabId, args);
      case 'fill-form':  return this.fillForm(tabId, args);
      case 'upload':     return this.upload(tabId, args);
      case 'wait-for':   return this.waitFor(tabId, args);
      case 'navigate':   return this.navigate(tabId, args);
      case 'back':       return this.navigateHistory(tabId, -1);
      case 'forward':    return this.navigateHistory(tabId, 1);
      case 'reload':     return this.reload(tabId);
      case 'press-key':  return this.pressKey(tabId, args);
      case 'new-tab':    return this.newTab(args);
      case 'close-tab':  return this.closeTab(tabId);
      default:
        throw new Error(`Unknown action: ${command}`);
    }
  }

  parseAction(action) {
    // action is { command: "click", params: { elementIndex: 5, ... } }
    return { command: action.command, args: action.params || {} };
  }

  // Resolve element index to center coordinates
  async resolveCoords(tabId, elementIndex) {
    const elem = this.perception.getElement(elementIndex);
    if (!elem) throw new Error(`Element #${elementIndex} not found`);

    const box = await chrome.debugger.sendCommand({ tabId }, 'DOM.getBoxModel', {
      backendNodeId: elem.backendNodeId
    });

    if (!box?.model) throw new Error(`Element #${elementIndex} not rendered`);

    const q = box.model.content;
    return {
      x: Math.round((q[0] + q[2] + q[4] + q[6]) / 4),
      y: Math.round((q[1] + q[3] + q[5] + q[7]) / 4)
    };
  }

  // Resolve element index to a Runtime object reference
  async resolveObject(tabId, elementIndex) {
    const elem = this.perception.getElement(elementIndex);
    if (!elem) throw new Error(`Element #${elementIndex} not found`);

    const resolved = await chrome.debugger.sendCommand({ tabId }, 'DOM.resolveNode', {
      backendNodeId: elem.backendNodeId
    });
    if (!resolved?.object?.objectId) {
      throw new Error(`Element #${elementIndex} could not be resolved to JS object`);
    }
    return resolved.object.objectId;
  }

  async click(tabId, { elementIndex }) {
    const { x, y } = await this.resolveCoords(tabId, elementIndex);
    await this.mouseClick(tabId, x, y);
    return { ok: true, action: `click #${elementIndex}` };
  }

  async dblclick(tabId, { elementIndex }) {
    const { x, y } = await this.resolveCoords(tabId, elementIndex);
    await this.mouseClick(tabId, x, y, { clickCount: 1 });
    await this.mouseClick(tabId, x, y, { clickCount: 2 });
    return { ok: true, action: `dblclick #${elementIndex}` };
  }

  async rightclick(tabId, { elementIndex }) {
    const { x, y } = await this.resolveCoords(tabId, elementIndex);
    await this.mouseClick(tabId, x, y, { button: 'right' });
    return { ok: true, action: `rightclick #${elementIndex}` };
  }

  async hover(tabId, { elementIndex }) {
    const { x, y } = await this.resolveCoords(tabId, elementIndex);
    await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return { ok: true, action: `hover #${elementIndex}` };
  }

  async type(tabId, { elementIndex, text }) {
    if (elementIndex) {
      await this.click(tabId, { elementIndex });
      await this.delay(50);
    }
    await this.cdp(tabId, 'Input.insertText', { text });
    return { ok: true, action: `type #${elementIndex} "${text}"` };
  }

  async clear(tabId, { elementIndex }) {
    await this.click(tabId, { elementIndex });
    await this.delay(50);
    // Select all (Cmd+A on Mac, Ctrl+A elsewhere — use Meta for both)
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, modifiers: 4 // Meta
    });
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, modifiers: 4
    });
    // Delete
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8
    });
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8
    });
    return { ok: true, action: `clear #${elementIndex}` };
  }

  async select(tabId, { elementIndex, value }) {
    // Use DOM.resolveNode to get a JS reference, then set value via callFunctionOn
    const objectId = await this.resolveObject(tabId, elementIndex);
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(val) {
          this.value = val;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value }],
        returnByValue: true
      });
    } finally {
      await this.releaseObject(tabId, objectId);
    }
    return { ok: true, action: `select #${elementIndex} "${value}"` };
  }

  async check(tabId, { elementIndex }) {
    // Click only if not already checked
    const objectId = await this.resolveObject(tabId, elementIndex);
    let isChecked = false;
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { return this.checked || this.getAttribute("aria-checked") === "true"; }',
        returnByValue: true
      });
      isChecked = result?.result?.value;
    } finally {
      await this.releaseObject(tabId, objectId);
    }

    if (!isChecked) {
      await this.click(tabId, { elementIndex });
    }
    return { ok: true, action: `check #${elementIndex}` };
  }

  async uncheck(tabId, { elementIndex }) {
    // Click only if currently checked
    const objectId = await this.resolveObject(tabId, elementIndex);
    let isChecked = false;
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { return this.checked || this.getAttribute("aria-checked") === "true"; }',
        returnByValue: true
      });
      isChecked = result?.result?.value;
    } finally {
      await this.releaseObject(tabId, objectId);
    }

    if (isChecked) {
      await this.click(tabId, { elementIndex });
    }
    return { ok: true, action: `uncheck #${elementIndex}` };
  }

  async focus(tabId, { elementIndex }) {
    const elem = this.perception.getElement(elementIndex);
    if (!elem) throw new Error(`Element #${elementIndex} not found`);

    await chrome.debugger.sendCommand({ tabId }, 'DOM.focus', {
      backendNodeId: elem.backendNodeId
    });
    return { ok: true, action: `focus #${elementIndex}` };
  }

  async scroll(tabId, { elementIndex, direction, amount }) {
    const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
    const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;

    let x = 400, y = 400; // Default viewport center
    if (elementIndex) {
      const coords = await this.resolveCoords(tabId, elementIndex);
      x = coords.x; y = coords.y;
    }

    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX, deltaY
    });
    return { ok: true, action: `scroll ${elementIndex ? '#' + elementIndex : 'page'} ${direction} ${amount}` };
  }

  async drag(tabId, { fromIndex, toIndex, afterIndex }) {
    const from = await this.resolveCoords(tabId, fromIndex);
    let to;

    if (toIndex) {
      to = await this.resolveCoords(tabId, toIndex);
    } else if (afterIndex) {
      const afterCoords = await this.resolveCoords(tabId, afterIndex);
      // Position just below the target element
      to = { x: afterCoords.x, y: afterCoords.y + 20 };
    } else {
      throw new Error('drag requires toIndex or afterIndex');
    }

    // Mouse-based drag (works with most UI libraries)
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x, y: from.y
    });
    await this.delay(50);
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: from.x, y: from.y,
      button: 'left', clickCount: 1
    });
    await this.delay(100);

    // Intermediate moves for smooth drag
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const mx = from.x + (to.x - from.x) * progress;
      const my = from.y + (to.y - from.y) * progress;
      await this.cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: Math.round(mx), y: Math.round(my), buttons: 1
      });
      await this.delay(30);
    }

    await this.delay(50);
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: to.x, y: to.y,
      button: 'left', clickCount: 1
    });

    const desc = afterIndex
      ? `drag #${fromIndex} to position after #${afterIndex}`
      : `drag #${fromIndex} to #${toIndex}`;
    return { ok: true, action: desc };
  }

  async fillForm(tabId, { fields }) {
    // fields: { elementIndex: value, ... }
    const results = [];
    for (const [indexStr, value] of Object.entries(fields)) {
      const elementIndex = Number(indexStr);
      await this.click(tabId, { elementIndex });
      await this.delay(50);
      await this.clear(tabId, { elementIndex });
      await this.delay(50);
      await this.cdp(tabId, 'Input.insertText', { text: value });
      results.push(`#${elementIndex}="${value}"`);
      await this.delay(100);
    }
    return { ok: true, action: `fill-form { ${results.join(', ')} }` };
  }

  async upload(tabId, { elementIndex, filePath }) {
    const elem = this.perception.getElement(elementIndex);
    if (!elem) throw new Error(`Element #${elementIndex} not found`);

    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
      files: [filePath],
      backendNodeId: elem.backendNodeId
    });
    return { ok: true, action: `upload #${elementIndex} "${filePath}"` };
  }

  async waitFor(tabId, { text, elementIndex, state, timeout = 10000 }) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (text) {
        const snapshot = await this.perception.snapshot(tabId);
        const found = snapshot.content.lines.some(l => l.includes(text));
        if (found) return { ok: true, action: `wait-for "${text}"` };
      }
      if (elementIndex && state) {
        const snapshot = await this.perception.snapshot(tabId);
        const elem = snapshot.content.indexed.find(e => e.idx === elementIndex);
        if (elem) {
          if (state === 'visible' && elem.box) return { ok: true, action: `wait-for #${elementIndex} visible` };
          if (state === 'hidden' && !elem.box) return { ok: true, action: `wait-for #${elementIndex} hidden` };
        }
      }
      await this.delay(500);
    }
    throw new Error(`Timeout waiting for "${text || state}"`);
  }

  async navigate(tabId, { url }) {
    await this.cdp(tabId, 'Page.navigate', { url });
    return { ok: true, action: `navigate "${url}"` };
  }

  async navigateHistory(tabId, delta) {
    const history = await this.cdp(tabId, 'Page.getNavigationHistory');
    const idx = history.currentIndex + delta;
    if (idx >= 0 && idx < history.entries.length) {
      await this.cdp(tabId, 'Page.navigateToHistoryEntry', {
        entryId: history.entries[idx].id
      });
    }
    return { ok: true, action: delta > 0 ? 'forward' : 'back' };
  }

  async reload(tabId) {
    await this.cdp(tabId, 'Page.reload');
    return { ok: true, action: 'reload' };
  }

  async newTab({ url }) {
    const tab = await chrome.tabs.create({ url: url || 'about:blank', active: false });
    return { ok: true, action: `new-tab "${url || 'about:blank'}"`, tabId: tab.id };
  }

  async closeTab(tabId) {
    await chrome.tabs.remove(tabId);
    return { ok: true, action: 'close-tab' };
  }

  async pressKey(tabId, { key, modifiers = 0 }) {
    const vkCode = KEY_CODES[key] || 0;
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key, code: key,
      windowsVirtualKeyCode: vkCode, modifiers
    });
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key, code: key,
      windowsVirtualKeyCode: vkCode, modifiers
    });
    return { ok: true, action: `press-key "${key}"` };
  }

  // --- Helpers ---

  async mouseClick(tabId, x, y, opts = {}) {
    const button = opts.button || 'left';
    const clickCount = opts.clickCount || 1;
    await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, clickCount
    });
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, clickCount
    });
  }

  cdp(tabId, method, params = {}) {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  async releaseObject(tabId, objectId) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObject', { objectId });
    } catch {}
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
