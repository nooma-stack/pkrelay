import { generateKeyPairSync, createPublicKey } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PKRELAY_DIR = path.join(os.homedir(), '.pkrelay');
const KEYS_DIR = path.join(PKRELAY_DIR, 'keys');

export interface KeyPair {
  privatePath: string;
  publicPath: string;
  publicKey: string;
}

function ensureDirs() {
  fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
}

function toOpenSSHPublicKey(derBuffer: Buffer, comment: string): string {
  // Ed25519 DER SPKI has the raw 32-byte key at offset 12
  const raw = derBuffer.subarray(12);
  const keyType = Buffer.from('ssh-ed25519');
  const buf = Buffer.alloc(4 + keyType.length + 4 + raw.length);
  let offset = 0;
  buf.writeUInt32BE(keyType.length, offset); offset += 4;
  keyType.copy(buf, offset); offset += keyType.length;
  buf.writeUInt32BE(raw.length, offset); offset += 4;
  raw.copy(buf, offset);
  return `ssh-ed25519 ${buf.toString('base64')} ${comment}`;
}

export function generateKeys(alias: string): KeyPair {
  ensureDirs();
  const privatePath = path.join(KEYS_DIR, alias);
  const publicPath = `${privatePath}.pub`;

  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const pubKeyObj = createPublicKey(publicKey);
  const derBuf = pubKeyObj.export({ type: 'spki', format: 'der' });
  const opensshPub = toOpenSSHPublicKey(derBuf, `pkrelay-${alias}`);

  fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
  fs.writeFileSync(publicPath, opensshPub + '\n', { mode: 0o644 });

  return { privatePath, publicPath, publicKey: opensshPub };
}

export function getKeyPair(alias: string): KeyPair | null {
  const privatePath = path.join(KEYS_DIR, alias);
  const publicPath = `${privatePath}.pub`;
  if (!fs.existsSync(privatePath)) return null;
  const publicKey = fs.existsSync(publicPath)
    ? fs.readFileSync(publicPath, 'utf-8').trim()
    : '';
  return { privatePath, publicPath, publicKey };
}

export function deleteKeyPair(alias: string): boolean {
  const privatePath = path.join(KEYS_DIR, alias);
  const publicPath = `${privatePath}.pub`;
  let deleted = false;
  if (fs.existsSync(privatePath)) { fs.unlinkSync(privatePath); deleted = true; }
  if (fs.existsSync(publicPath)) { fs.unlinkSync(publicPath); deleted = true; }
  return deleted;
}

export function listKeyPairs(): string[] {
  ensureDirs();
  return fs.readdirSync(KEYS_DIR)
    .filter(f => !f.endsWith('.pub'))
    .sort();
}
