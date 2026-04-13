// options.js — PKRelay settings page logic (v2.0 CDP Server mode)

const $ = (sel) => document.querySelector(sel);

async function load() {
  const stored = await chrome.storage.local.get([
    'browserName', 'cdpServerPort', 'relayPort', 'isDefault', 'knownBrowsers'
  ]);
  $('#browserName').value = stored.browserName || '';
  // Migrate from old relayPort key → cdpServerPort
  $('#cdpServerPort').value = stored.cdpServerPort || stored.relayPort || 18792;
  $('#isDefault').checked = !!stored.isDefault;
  $('#knownBrowsers').value = (stored.knownBrowsers || []).join(', ');
}

async function save() {
  const browserName = $('#browserName').value.trim();
  const cdpServerPort = parseInt($('#cdpServerPort').value, 10);
  const isDefault = $('#isDefault').checked;
  const knownBrowsers = $('#knownBrowsers').value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!cdpServerPort || cdpServerPort < 1 || cdpServerPort > 65535) {
    showStatus('error', 'Port must be 1-65535');
    return;
  }

  await chrome.storage.local.set({
    browserName: browserName || 'Browser',
    cdpServerPort,
    // Also write relayPort for backward compat with old options.js reads
    relayPort: cdpServerPort,
    isDefault,
    knownBrowsers
  });

  showToast('Saved');
}

async function testConnection() {
  const port = parseInt($('#cdpServerPort').value, 10) || 18792;
  showStatus('checking', 'Checking...');

  try {
    // CDP bridge responds at /json/version
    const url = `http://127.0.0.1:${port}/json/version`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(2000)
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const version = data.Browser || 'OK';
      showStatus('ok', `CDP server running (${version}) — port ${port}`);
    } else {
      showStatus('error', `Server error: ${resp.status}`);
    }
  } catch (err) {
    showStatus('error', `CDP server not reachable on port ${port} — run ./install.sh`);
  }
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
  await testConnection();
});

$('#testBtn').addEventListener('click', testConnection);

load();

// Test native messaging host availability (CDP bridge)
try {
  chrome.runtime.sendNativeMessage('com.pkrelay.cdp_server', { type: 'ping' }, (resp) => {
    const el = $('#nmStatus');
    if (chrome.runtime.lastError) {
      el.textContent = 'CDP bridge not installed. Run ./install.sh to set up.';
      el.style.color = '#EF4444';
    } else if (resp) {
      el.textContent = 'CDP bridge native host active ✓';
      el.style.color = '#22C55E';
    }
  });
} catch {}
