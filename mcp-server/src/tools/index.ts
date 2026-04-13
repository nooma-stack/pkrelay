import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';
import { registerSnapshotTool } from './snapshot.js';
import { registerScreenshotTool } from './screenshot.js';

export function registerTools(server: McpServer, bridge: NativeMessagingBridge) {
  registerSnapshotTool(server, bridge);
  registerScreenshotTool(server, bridge);
}
