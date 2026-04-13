import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

// Perception
import { registerSnapshotTool } from './snapshot.js';
import { registerScreenshotTool } from './screenshot.js';

// Actions
import { registerClickTool } from './click.js';
import { registerTypeTool } from './type.js';
import { registerSelectTool } from './select.js';
import { registerNavigateTool } from './navigate.js';
import { registerEvaluateTool } from './evaluate.js';
import { registerWaitTool } from './wait.js';

// Monitoring
import { registerConsoleTool } from './console.js';
import { registerNetworkTool } from './network.js';

// Tab management
import { registerTabTools } from './tabs.js';

export function registerTools(server: McpServer, bridge: NativeMessagingBridge) {
  // Perception
  registerSnapshotTool(server, bridge);
  registerScreenshotTool(server, bridge);

  // Actions
  registerClickTool(server, bridge);
  registerTypeTool(server, bridge);
  registerSelectTool(server, bridge);
  registerNavigateTool(server, bridge);
  registerEvaluateTool(server, bridge);
  registerWaitTool(server, bridge);

  // Monitoring
  registerConsoleTool(server, bridge);
  registerNetworkTool(server, bridge);

  // Tab management
  registerTabTools(server, bridge);
}
