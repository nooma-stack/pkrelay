#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NativeMessagingBridge } from './bridge.js';
import { ClientBridge } from './client-bridge.js';
import { registerTools } from './tools/index.js';
import type { Bridge } from './bridge-interface.js';

const BRIDGE_PORT = parseInt(process.env.PKRELAY_PORT || '18793', 10);
const BROKER_URL = process.env.PKRELAY_BROKER || '';
const IS_DAEMON = process.argv.includes('--daemon');

async function startBroker(): Promise<Bridge> {
  const bridge = new NativeMessagingBridge(BRIDGE_PORT);
  await bridge.start();
  process.stderr.write(`[pkrelay] Broker listening on 127.0.0.1:${BRIDGE_PORT}\n`);
  return bridge;
}

async function startClient(url: string): Promise<Bridge> {
  const bridge = new ClientBridge(url);
  await bridge.start();
  return bridge;
}

async function main() {
  let bridge: Bridge;

  if (BROKER_URL) {
    process.stderr.write(`[pkrelay] Client mode: connecting to ${BROKER_URL}\n`);
    bridge = await startClient(BROKER_URL);
  } else {
    try {
      bridge = await startBroker();
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        if (IS_DAEMON) {
          process.stderr.write(`[pkrelay] Port ${BRIDGE_PORT} in use — broker already running. Exiting.\n`);
          process.exit(0);
        }
        const fallbackUrl = `ws://127.0.0.1:${BRIDGE_PORT}/mcp-client`;
        process.stderr.write(`[pkrelay] Port ${BRIDGE_PORT} in use — falling back to client mode (${fallbackUrl})\n`);
        bridge = await startClient(fallbackUrl);
      } else {
        throw err;
      }
    }
  }

  if (IS_DAEMON) {
    process.stderr.write('[pkrelay] Running as daemon (no MCP stdio)\n');

    // Restore previously configured tunnels
    if (bridge instanceof NativeMessagingBridge) {
      bridge.tunnelManager.startAllTunnels();
    }

    process.on('SIGTERM', async () => {
      if (bridge instanceof NativeMessagingBridge) {
        bridge.tunnelManager.stopAllTunnels();
      }
      await bridge.stop();
      process.exit(0);
    });
    process.on('SIGINT', async () => {
      if (bridge instanceof NativeMessagingBridge) {
        bridge.tunnelManager.stopAllTunnels();
      }
      await bridge.stop();
      process.exit(0);
    });
    return;
  }

  const server = new McpServer({ name: 'pkrelay', version: '3.1.0' });
  registerTools(server, bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`PKRelay MCP server failed to start: ${err}\n`);
  process.exit(1);
});
