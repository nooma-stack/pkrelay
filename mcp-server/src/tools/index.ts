import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerTools(server: McpServer, bridge: NativeMessagingBridge) {
  // Tools will be registered here as they are implemented
  // Each tool file exports a register(server, bridge) function
}
