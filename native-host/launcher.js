#!/usr/bin/env node
// launcher.js — Ensures PKRelay broker daemon is running.
// Called by Chrome extension via native messaging on startup.
// Protocol: 4-byte little-endian length prefix + JSON on stdin/stdout.

import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';

const PORT = parseInt(process.env.PKRELAY_PORT || '18793', 10);

function readNativeMessage() {
  const header = Buffer.alloc(4);
  try {
    fs.readSync(0, header, 0, 4);
  } catch {
    return null;
  }
  const len = header.readUInt32LE(0);
  if (len === 0 || len > 1024 * 1024) return null;
  const body = Buffer.alloc(len);
  fs.readSync(0, body, 0, len);
  return JSON.parse(body.toString('utf-8'));
}

function writeNativeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

function isBrokerRunning() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port: PORT, host: '127.0.0.1' });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
  });
}

function findPkrelayBinary() {
  const candidates = [
    '/opt/homebrew/bin/pkrelay',
    '/usr/local/bin/pkrelay',
    path.join(process.env.HOME || '', '.npm-global/bin/pkrelay'),
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return 'pkrelay';
}

async function main() {
  readNativeMessage(); // consume Chrome's request

  const running = await isBrokerRunning();

  if (!running) {
    const bin = findPkrelayBinary();
    const child = spawn(bin, ['--daemon'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PKRELAY_PORT: String(PORT) },
    });
    child.unref();
    let ready = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 300));
      ready = await isBrokerRunning();
      if (ready) break;
    }
    writeNativeMessage({ status: ready ? 'started' : 'start_failed', port: PORT });
  } else {
    writeNativeMessage({ status: 'already_running', port: PORT });
  }
}

main().catch((err) => {
  writeNativeMessage({ status: 'error', message: err.message });
}).finally(() => {
  process.exit(0);
});
