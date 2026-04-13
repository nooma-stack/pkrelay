#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NativeMessagingBridge } from './bridge.js';
import { registerTools } from './tools/index.js';

const bridge = new NativeMessagingBridge();
const server = new McpServer({
  name: 'pkrelay',
  version: '3.0.0',
});

registerTools(server, bridge);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('PKRelay MCP server failed to start:', err);
  process.exit(1);
});
