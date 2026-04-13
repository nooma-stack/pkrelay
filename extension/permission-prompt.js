// permission-prompt.js — Handles the Allow/Deny permission prompt window

const params = new URLSearchParams(window.location.search);
const tabId = parseInt(params.get('tabId'), 10);
const title = params.get('title') || 'Untitled';
const url = params.get('url') || '';

document.getElementById('title').textContent = title;
document.getElementById('url').textContent = url;

document.getElementById('allowBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'respondPermission',
    tabId,
    granted: true,
    duration: 'session'
  }, () => window.close());
});

document.getElementById('denyBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'respondPermission',
    tabId,
    granted: false
  }, () => window.close());
});
