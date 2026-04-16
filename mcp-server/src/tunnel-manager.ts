import { Client as SSHClient } from 'ssh2';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateKeys, getKeyPair, deleteKeyPair } from './key-manager.js';

const CONFIG_DIR = path.join(os.homedir(), '.pkrelay');
const REMOTES_FILE = path.join(CONFIG_DIR, 'remotes.json');

export interface RemoteConfig {
  alias: string;
  host: string;
  username: string;
  remotePort: number;
  localPort: number;
  keyInstalled: boolean;
}

export interface RemoteStatus {
  alias: string;
  config: RemoteConfig;
  tunnelState: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
  pid?: number;
}

export class TunnelManager extends EventEmitter {
  private remotes = new Map<string, RemoteConfig>();
  private tunnels = new Map<string, ChildProcess>();
  private tunnelStates = new Map<string, RemoteStatus>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    super();
    this.loadConfig();
  }

  private loadConfig() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      if (fs.existsSync(REMOTES_FILE)) {
        const data = JSON.parse(fs.readFileSync(REMOTES_FILE, 'utf-8'));
        for (const remote of data.remotes || []) {
          this.remotes.set(remote.alias, remote);
        }
      }
    } catch { /* fresh start */ }
  }

  private saveConfig() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      REMOTES_FILE,
      JSON.stringify({ remotes: [...this.remotes.values()] }, null, 2),
      { mode: 0o600 },
    );
  }

  async setupKeys(
    alias: string,
    host: string,
    username: string,
    password: string,
    remotePort: number,
    localPort = 18793,
  ): Promise<{ success: boolean; error?: string }> {
    const keyPair = generateKeys(alias);
    process.stderr.write(`[pkrelay] Generated key pair for ${alias}\n`);

    try {
      await this.installPublicKey(host, username, password, keyPair.publicKey);
    } catch (err: unknown) {
      deleteKeyPair(alias);
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Key installation failed: ${message}` };
    }

    try {
      await this.testKeyAuth(host, username, keyPair.privatePath);
    } catch (err: unknown) {
      deleteKeyPair(alias);
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Key verification failed: ${message}` };
    }

    const config: RemoteConfig = { alias, host, username, remotePort, localPort, keyInstalled: true };
    this.remotes.set(alias, config);
    this.saveConfig();

    process.stderr.write(`[pkrelay] Key setup complete for ${alias}\n`);
    return { success: true };
  }

  private installPublicKey(host: string, username: string, password: string, publicKey: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      conn.on('ready', () => {
        const escapedKey = publicKey.replace(/'/g, "'\\''");
        const cmd = [
          'mkdir -p ~/.ssh',
          'chmod 700 ~/.ssh',
          'touch ~/.ssh/authorized_keys',
          'chmod 600 ~/.ssh/authorized_keys',
          `grep -qF '${escapedKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${escapedKey}' >> ~/.ssh/authorized_keys`,
        ].join(' && ');

        conn.exec(cmd, (err, stream) => {
          if (err) { conn.end(); reject(err); return; }
          let stderr = '';
          stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          stream.on('close', (code: number) => {
            conn.end();
            if (code === 0) resolve();
            else reject(new Error(`Key install failed (exit ${code}): ${stderr}`));
          });
        });
      });
      conn.on('error', reject);
      conn.connect({ host, port: 22, username, password, readyTimeout: 10000 });
    });
  }

  private testKeyAuth(host: string, username: string, privatePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      conn.on('ready', () => { conn.end(); resolve(); });
      conn.on('error', reject);
      conn.connect({ host, port: 22, username, privateKey: fs.readFileSync(privatePath), readyTimeout: 10000 });
    });
  }

  startTunnel(alias: string): boolean {
    const config = this.remotes.get(alias);
    if (!config) return false;
    const keyPair = getKeyPair(alias);
    if (!keyPair) return false;

    this.stopTunnel(alias);

    const args = [
      '-i', keyPair.privatePath,
      '-R', `${config.remotePort}:127.0.0.1:${config.localPort}`,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-N',
      `${config.username}@${config.host}`,
    ];

    const child = spawn('ssh', args, { stdio: 'ignore', detached: false });
    this.tunnels.set(alias, child);
    this.setStatus(alias, 'connecting');

    setTimeout(() => {
      if (child.exitCode === null) {
        this.setStatus(alias, 'connected', undefined, child.pid);
      }
    }, 2000);

    child.on('exit', (code) => {
      this.tunnels.delete(alias);
      if (code !== 0 && code !== null) {
        this.setStatus(alias, 'error', `SSH exited with code ${code}`);
        this.scheduleReconnect(alias);
      } else {
        this.setStatus(alias, 'disconnected');
      }
    });

    child.on('error', (err) => {
      this.tunnels.delete(alias);
      this.setStatus(alias, 'error', err.message);
      this.scheduleReconnect(alias);
    });

    return true;
  }

  stopTunnel(alias: string) {
    const timer = this.reconnectTimers.get(alias);
    if (timer) { clearTimeout(timer); this.reconnectTimers.delete(alias); }
    const child = this.tunnels.get(alias);
    if (child) { child.kill('SIGTERM'); this.tunnels.delete(alias); }
    this.setStatus(alias, 'disconnected');
  }

  private scheduleReconnect(alias: string) {
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(alias);
      if (this.remotes.has(alias)) {
        process.stderr.write(`[pkrelay] Reconnecting tunnel: ${alias}\n`);
        this.startTunnel(alias);
      }
    }, 10000);
    this.reconnectTimers.set(alias, timer);
  }

  private setStatus(alias: string, state: RemoteStatus['tunnelState'], error?: string, pid?: number) {
    const config = this.remotes.get(alias);
    if (!config) return;
    const status: RemoteStatus = { alias, config, tunnelState: state, error, pid };
    this.tunnelStates.set(alias, status);
    this.emit('statusChanged', status);
  }

  removeRemote(alias: string) {
    this.stopTunnel(alias);
    deleteKeyPair(alias);
    this.remotes.delete(alias);
    this.tunnelStates.delete(alias);
    this.saveConfig();
  }

  getRemotes(): RemoteStatus[] {
    return [...this.remotes.keys()].map(alias => {
      return this.tunnelStates.get(alias) || {
        alias,
        config: this.remotes.get(alias)!,
        tunnelState: 'disconnected' as const,
      };
    });
  }

  startAllTunnels() {
    for (const [alias, config] of this.remotes) {
      if (config.keyInstalled) this.startTunnel(alias);
    }
  }

  stopAllTunnels() {
    for (const alias of this.tunnels.keys()) {
      this.stopTunnel(alias);
    }
  }
}
