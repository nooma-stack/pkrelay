#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NativeMessagingBridge } from './bridge.js';
import { registerTools } from './tools/index.js';

const BRIDGE_PORT = parseInt(process.env.PKRELAY_PORT || '18793', 10);

const bridge = new NativeMessagingBridge(BRIDGE_PORT);
const server = new McpServer({
  name: 'pkrelay',
  version: '3.0.0',
});

registerTools(server, bridge);

async function main() {
  // Start the TCP bridge for extension communication
  await bridge.start();
  // stderr is safe — MCP uses stdin/stdout only
  process.stderr.write(`[pkrelay] Bridge listening on 127.0.0.1:${BRIDGE_PORT}\n`);

  // Start MCP server on stdio for AI agent communication
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`PKRelay MCP server failed to start: ${err}\n`);
  process.exit(1);
});
