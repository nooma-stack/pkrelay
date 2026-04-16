// options.js — PKRelay settings page logic (v3.0 MCP-native mode)

const $ = (sel) => document.querySelector(sel);
const DEFAULT_WS_PORT = 18793;

async function load() {
  const stored = await chrome.storage.local.get([
    'browserName', 'isDefault', 'knownBrowsers'
  ]);
  $('#browserName').value = stored.browserName || '';
  $('#isDefault').checked = !!stored.isDefault;
  $('#knownBrowsers').value = (stored.knownBrowsers || []).join(', ');
}

async function save() {
  const browserName = $('#browserName').value.trim();
  const isDefault = $('#isDefault').checked;
  const knownBrowsers = $('#knownBrowsers').value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  await chrome.storage.local.set({
    browserName: browserName || 'Browser',
    isDefault,
    knownBrowsers
  });

  showToast('Saved');
}

async function testConnection() {
  showStatus('checking', 'Checking...');

  // Ask the background service worker for relay state
  chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
    if (chrome.runtime.lastError) {
      showStatus('error', `Could not reach background: ${chrome.runtime.lastError.message}`);
      return;
    }
    if (resp && resp.connectionState === 'connected') {
      showStatus('ok', `MCP relay connected (port ${DEFAULT_WS_PORT})`);
    } else {
      const state = resp?.connectionState || 'unknown';
      showStatus('error', `MCP relay ${state} — is the MCP server running?`);
    }
  });
}

function checkRelayStatus() {
  const el = $('#nmStatus');
  chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
    if (chrome.runtime.lastError) {
      el.textContent = 'Could not reach background service worker.';
      el.style.color = '#EF4444';
      return;
    }
    if (resp && resp.connectionState === 'connected') {
      el.textContent = 'MCP relay connected';
      el.style.color = '#22C55E';
    } else {
      const state = resp?.connectionState || 'disconnected';
      el.textContent = `MCP relay ${state}`;
      el.style.color = state === 'connecting' || state === 'reconnecting' ? '#F59E0B' : '#EF4444';
    }
  });
}

function showStatus(type, text) {
  const el = $('#healthStatus');
  el.className = `status ${type}`;
  el.innerHTML = `<span class="status-dot"></span>${text}`;
}

function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

$('#saveBtn').addEventListener('click', async () => {
  await save();
});

$('#testBtn').addEventListener('click', testConnection);

load();
checkRelayStatus();

// --- Remote Sessions ---

function renderRemoteList(remotes) {
  const container = $('#remoteList');
  if (!remotes || remotes.length === 0) {
    container.innerHTML = '<p class="help">No remote sessions configured.</p>';
    return;
  }
  container.innerHTML = remotes.map(r => `
    <div class="remote-card" data-alias="${r.alias}">
      <div class="remote-info">
        <span class="remote-alias">${r.alias}</span>
        <span class="remote-detail">${r.config.username}@${r.config.host} → port ${r.config.remotePort}</span>
      </div>
      <div class="remote-status">
        <span class="dot ${r.tunnelState}"></span>
        <span>${r.tunnelState}${r.error ? ': ' + r.error : ''}</span>
      </div>
      <div class="remote-actions">
        ${r.tunnelState === 'connected'
          ? '<button class="btn-secondary remote-disconnect">Disconnect</button>'
          : '<button class="btn-secondary remote-connect">Connect</button>'}
        <button class="btn-danger remote-remove">Remove</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.remote-connect').forEach(btn => {
    btn.addEventListener('click', () => {
      const alias = btn.closest('.remote-card').dataset.alias;
      sendRelayCommand('pkrelay.remote.connect', { alias });
    });
  });
  container.querySelectorAll('.remote-disconnect').forEach(btn => {
    btn.addEventListener('click', () => {
      const alias = btn.closest('.remote-card').dataset.alias;
      sendRelayCommand('pkrelay.remote.disconnect', { alias });
    });
  });
  container.querySelectorAll('.remote-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const alias = btn.closest('.remote-card').dataset.alias;
      if (confirm(`Remove remote "${alias}"? This deletes the key pair and tunnel config.`)) {
        sendRelayCommand('pkrelay.remote.remove', { alias });
      }
    });
  });
}

function sendRelayCommand(method, params) {
  chrome.runtime.sendMessage({ type: 'relayCommand', method, params }, (resp) => {
    if (chrome.runtime.lastError) {
      showToast('Error: ' + chrome.runtime.lastError.message);
      return;
    }
    if (resp?.error) {
      showToast('Error: ' + resp.error);
    }
    setTimeout(loadRemotes, 500);
  });
}

function loadRemotes() {
  chrome.runtime.sendMessage({ type: 'relayCommand', method: 'pkrelay.remote.list', params: {} }, (resp) => {
    if (chrome.runtime.lastError) return;
    renderRemoteList(resp?.result || []);
  });
}

function showSetupStatus(type, text) {
  const el = $('#setupStatus');
  el.className = `status ${type}`;
  el.innerHTML = `<span class="status-dot"></span>${text}`;
}

$('#setupRemoteBtn').addEventListener('click', () => {
  const alias = $('#remoteAlias').value.trim();
  const host = $('#remoteHost').value.trim();
  const username = $('#remoteUser').value.trim();
  const password = $('#remotePassword').value;
  const remotePort = parseInt($('#remotePort').value) || 18794;

  if (!alias || !host || !username || !password) {
    showSetupStatus('error', 'All fields are required');
    return;
  }

  showSetupStatus('checking', 'Setting up keys and connecting...');

  chrome.runtime.sendMessage({
    type: 'relayCommand',
    method: 'pkrelay.remote.setup',
    params: { alias, host, username, password, remotePort },
  }, (resp) => {
    if (chrome.runtime.lastError) {
      showSetupStatus('error', chrome.runtime.lastError.message);
      return;
    }
    if (resp?.result?.success) {
      showSetupStatus('ok', 'Connected! Key-based auth configured.');
      $('#remotePassword').value = '';
      loadRemotes();
    } else {
      showSetupStatus('error', resp?.result?.error || resp?.error || 'Setup failed');
    }
  });
});

// Listen for status updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'remoteStatusUpdate') {
    loadRemotes();
  }
});

loadRemotes();
