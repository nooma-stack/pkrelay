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
