// perception.js — Structured page perception via accessibility tree

// Properties to extract for visual metadata via Runtime.evaluate
const VISUAL_PROPS = ['backgroundColor', 'color', 'opacity', 'visibility', 'display'];

// AX roles that are interactive and should always be included
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'treeitem', 'textField'
]);

// AX roles that provide structural context
const STRUCTURAL_ROLES = new Set([
  'heading', 'navigation', 'main', 'complementary', 'banner',
  'contentinfo', 'region', 'article', 'dialog', 'alertdialog',
  'form', 'table', 'row', 'cell', 'columnheader', 'rowheader',
  'list', 'listitem', 'tablist', 'tabpanel', 'toolbar',
  'treegrid', 'tree', 'grid', 'menu', 'menubar', 'group'
]);

export class PerceptionEngine {
  constructor() {
    this.lastSnapshot = new Map();  // tabId -> snapshot
    this.tabElements = new Map();   // tabId -> Map(index -> { backendNodeId, tabId, axNodeId })
    this.tabNextIndex = new Map();  // tabId -> next index counter
  }

  // Take a full snapshot of a tab
  async snapshot(tabId, options = {}) {
    const { diff = false, elementId = null, depth } = options;

    // Ensure Accessibility domain is enabled
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Accessibility.enable');
    } catch {}

    // 1. Get accessibility tree
    const axParams = {};
    if (depth != null) axParams.depth = depth;
    const axTree = await chrome.debugger.sendCommand(
      { tabId }, 'Accessibility.getFullAXTree', axParams
    );

    // 2. Filter and process nodes
    const nodes = this.processAXTree(axTree.nodes);

    // 3. Get box models for visible elements (parallel)
    const boxModels = await this.getBoxModels(tabId, nodes);

    // 4. Get visual metadata for interactive elements
    const visualMeta = await this.getVisualMetadata(tabId, nodes);

    // 5. Get page info
    const pageInfo = await this.getPageInfo(tabId);

    // 6. Build indexed snapshot (per-tab element indices)
    this.tabNextIndex.set(tabId, 1);
    this.tabElements.set(tabId, new Map());
    const snapshot = this.formatSnapshot(tabId, nodes, boxModels, visualMeta, pageInfo);

    // 7. Compute diff if requested
    if (diff && this.lastSnapshot.has(tabId)) {
      const diffResult = this.computeDiff(this.lastSnapshot.get(tabId), snapshot);
      this.lastSnapshot.set(tabId, snapshot);
      return { type: 'diff', content: diffResult };
    }

    this.lastSnapshot.set(tabId, snapshot);
    return { type: 'full', content: snapshot };
  }

  processAXTree(rawNodes) {
    // Filter: keep interactive, structural, and content-bearing nodes
    return rawNodes.filter(node => {
      if (node.ignored) return false;
      const role = node.role?.value;
      if (!role) return false;

      if (INTERACTIVE_ROLES.has(role)) return true;
      if (STRUCTURAL_ROLES.has(role)) return true;

      // Keep text nodes that have meaningful content
      if (role === 'StaticText' || role === 'text') {
        const name = node.name?.value;
        return name && name.trim().length > 0;
      }

      // Keep images with labels
      if (role === 'image' || role === 'img') {
        return !!(node.name?.value);
      }

      // Keep the root document/page node
      if (role === 'WebArea' || role === 'RootWebArea') return true;

      return false;
    });
  }

  async getBoxModels(tabId, nodes) {
    const results = new Map();
    const BATCH_SIZE = 50;

    // Process in batches to avoid overwhelming the debugger
    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
      const batch = nodes.slice(i, i + BATCH_SIZE);
      const promises = [];

      for (const node of batch) {
        if (!node.backendDOMNodeId) continue;
        promises.push(
          chrome.debugger.sendCommand({ tabId }, 'DOM.getBoxModel', {
            backendNodeId: node.backendDOMNodeId
          })
          .then(result => {
            if (result?.model) {
              const q = result.model.content;
              results.set(node.backendDOMNodeId, {
                x: Math.round(Math.min(q[0], q[2], q[4], q[6])),
                y: Math.round(Math.min(q[1], q[3], q[5], q[7])),
                w: result.model.width,
                h: result.model.height
              });
            }
          })
          .catch(() => {}) // Element not rendered
        );
      }

      await Promise.all(promises);
    }

    return results;
  }

  async getVisualMetadata(tabId, nodes) {
    // Only get visual metadata for interactive elements
    const interactiveNodes = nodes.filter(n =>
      INTERACTIVE_ROLES.has(n.role?.value) && n.backendDOMNodeId
    );

    if (interactiveNodes.length === 0) return new Map();

    // Use DOM.resolveNode + Runtime.callFunctionOn to get styles per element
    // This avoids content script injection and works with backendNodeId
    const results = new Map();
    const BATCH_SIZE = 20;

    for (let i = 0; i < interactiveNodes.length; i += BATCH_SIZE) {
      const batch = interactiveNodes.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (node) => {
        try {
          // Resolve backendNodeId to a JS object reference
          const resolved = await chrome.debugger.sendCommand({ tabId }, 'DOM.resolveNode', {
            backendNodeId: node.backendDOMNodeId
          });
          if (!resolved?.object?.objectId) return;

          // Call getComputedStyle on the resolved element
          const styleResult = await chrome.debugger.sendCommand(
            { tabId }, 'Runtime.callFunctionOn', {
              objectId: resolved.object.objectId,
              functionDeclaration: `function() {
                const s = window.getComputedStyle(this);
                const bg = s.backgroundColor;
                const color = s.color;
                const r = {};
                if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') r.bg = bg;
                if (color) r.color = color;
                if (s.opacity !== '1') r.opacity = s.opacity;
                return r;
              }`,
              returnByValue: true
            }
          );

          if (styleResult?.result?.value) {
            results.set(node.backendDOMNodeId, styleResult.result.value);
          }

          // Release the object to prevent memory leaks
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObject', {
            objectId: resolved.object.objectId
          }).catch(() => {});
        } catch {}
      });

      await Promise.all(promises);
    }

    return results;
  }

  async getPageInfo(tabId) {
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'JSON.stringify({ title: document.title, url: location.href, viewport: { w: window.innerWidth, h: window.innerHeight } })',
        returnByValue: true
      });
      return JSON.parse(result?.result?.value || '{}');
    } catch {
      return {};
    }
  }

  formatSnapshot(tabId, nodes, boxModels, visualMeta, pageInfo) {
    const lines = [];
    const indexed = [];

    // Page header
    if (pageInfo.url) {
      lines.push(`[Page] ${pageInfo.url}`);
      if (pageInfo.title) lines.push(`  Title: "${pageInfo.title}"`);
      if (pageInfo.viewport) lines.push(`  Viewport: ${pageInfo.viewport.w}x${pageInfo.viewport.h}`);
      lines.push('');
    }

    // Build parent-child depth map for indentation
    const parentMap = new Map();
    const depthMap = new Map();
    for (const node of nodes) {
      if (node.parentId) parentMap.set(node.nodeId, node.parentId);
    }

    for (const node of nodes) {
      const role = node.role?.value || 'unknown';
      if (role === 'WebArea' || role === 'RootWebArea') continue; // Skip root

      const name = node.name?.value || '';
      const box = node.backendDOMNodeId ? boxModels.get(node.backendDOMNodeId) : null;
      const visual = node.backendDOMNodeId ? visualMeta.get(node.backendDOMNodeId) : null;

      // Assign per-tab index
      const idx = this.tabNextIndex.get(tabId);
      this.tabNextIndex.set(tabId, idx + 1);
      const tabElems = this.tabElements.get(tabId);
      tabElems.set(idx, {
        backendNodeId: node.backendDOMNodeId,
        tabId,
        axNodeId: node.nodeId
      });

      // Build compact representation
      let line = `[#${idx}] ${role}`;

      // Add heading level
      const level = this.getProperty(node, 'level');
      if (level) line = `[#${idx}] ${role}[${level}]`;

      if (name) line += ` "${name}"`;

      // Add position
      if (box) line += ` (${box.x},${box.y} ${box.w}x${box.h})`;

      // Add visual metadata
      if (visual) {
        const parts = [];
        if (visual.bg) parts.push(`bg:${this.compactColor(visual.bg)}`);
        if (visual.color) parts.push(`color:${this.compactColor(visual.color)}`);
        if (visual.opacity) parts.push(`opacity:${visual.opacity}`);
        if (parts.length > 0) line += ` ${parts.join(' ')}`;
      }

      // Add states
      const states = this.extractStates(node);
      if (states.length > 0) line += ` ${states.join(' ')}`;

      // Add value for inputs
      const value = node.value?.value;
      if (value !== undefined && value !== '') line += ` value:"${value}"`;

      indexed.push({ idx, line, role, name, box, node });
      lines.push(line);
    }

    return {
      lines,
      indexed,
      elementCount: indexed.length,
      interactiveCount: indexed.filter(e => INTERACTIVE_ROLES.has(e.role)).length,
      timestamp: Date.now()
    };
  }

  getProperty(node, propName) {
    if (!node.properties) return null;
    const prop = node.properties.find(p => p.name === propName);
    return prop?.value?.value ?? null;
  }

  extractStates(node) {
    const states = [];
    if (!node.properties) return states;

    for (const prop of node.properties) {
      const name = prop.name;
      const val = prop.value?.value;

      if (name === 'disabled' && val) states.push('disabled');
      if (name === 'checked' && val) states.push('checked');
      if (name === 'expanded' && val === true) states.push('expanded');
      if (name === 'expanded' && val === false) states.push('collapsed');
      if (name === 'selected' && val) states.push('selected');
      if (name === 'focused' && val) states.push('focused');
      if (name === 'required' && val) states.push('required');
      if (name === 'readonly' && val) states.push('readonly');
      if (name === 'pressed' && val) states.push('pressed');
      if (name === 'modal' && val) states.push('modal');
    }

    return states;
  }

  // Convert verbose CSS color to compact hex
  compactColor(cssColor) {
    if (!cssColor) return cssColor;
    const match = cssColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      const hex = '#' + [match[1], match[2], match[3]]
        .map(n => Number(n).toString(16).padStart(2, '0'))
        .join('');
      return hex;
    }
    const matchA = cssColor.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    if (matchA && matchA[4] !== '0') {
      return '#' + [matchA[1], matchA[2], matchA[3]]
        .map(n => Number(n).toString(16).padStart(2, '0'))
        .join('');
    }
    return cssColor;
  }

  computeDiff(oldSnapshot, newSnapshot) {
    // Build maps keyed by role+name for semantic matching (not index-based)
    const oldByKey = new Map();
    for (const elem of oldSnapshot.indexed) {
      const key = `${elem.role}:${elem.name}`;
      oldByKey.set(key, elem);
    }

    const newByKey = new Map();
    for (const elem of newSnapshot.indexed) {
      const key = `${elem.role}:${elem.name}`;
      newByKey.set(key, elem);
    }

    const changes = [];

    // Added elements
    for (const [key, elem] of newByKey) {
      if (!oldByKey.has(key)) {
        changes.push(`[ADDED] ${elem.line}`);
      }
    }

    // Removed elements
    for (const [key, elem] of oldByKey) {
      if (!newByKey.has(key)) {
        changes.push(`[REMOVED] ${elem.line}`);
      }
    }

    // Changed elements
    for (const [key, newElem] of newByKey) {
      const oldElem = oldByKey.get(key);
      if (oldElem && oldElem.line !== newElem.line) {
        changes.push(`[CHANGED] ${newElem.line}`);
      }
    }

    return {
      changes,
      changeCount: changes.length,
      timestamp: Date.now()
    };
  }

  // Get element info by index — searches the tab that owns it
  getElement(index, tabId) {
    // If tabId provided, search that tab first
    if (tabId != null) {
      const tabElems = this.tabElements.get(tabId);
      if (tabElems?.has(index)) return tabElems.get(index);
    }
    // Fallback: search all tabs
    for (const [, elems] of this.tabElements) {
      if (elems.has(index)) return elems.get(index);
    }
    return undefined;
  }

  // Screenshot (on-demand, expensive)
  async takeScreenshot(tabId, options = {}) {
    const params = {};
    if (options.format) params.format = options.format;
    if (options.quality) params.quality = options.quality;

    // Element-level screenshot via clip
    if (options.elementIndex) {
      const elem = this.getElement(options.elementIndex, tabId);
      if (elem?.backendNodeId) {
        const box = await chrome.debugger.sendCommand({ tabId }, 'DOM.getBoxModel', {
          backendNodeId: elem.backendNodeId
        });
        if (box?.model) {
          const q = box.model.content;
          params.clip = {
            x: Math.min(q[0], q[2], q[4], q[6]),
            y: Math.min(q[1], q[3], q[5], q[7]),
            width: box.model.width,
            height: box.model.height,
            scale: 1
          };
        }
      }
    }

    return await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params);
  }
}
