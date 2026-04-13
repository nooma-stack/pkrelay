import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerSelectTool(server: McpServer, bridge: NativeMessagingBridge) {
  server.tool(
    'browser_select',
    'Select an option from a dropdown or select element.',
    {
      selector: z.string().describe('CSS selector of target select element'),
      value: z.string().optional().describe('Option value to select'),
      label: z.string().optional().describe('Option visible text to select'),
      tabId: z.number().optional().describe('Target tab ID'),
    },
    async (params) => {
      const result = await bridge.request('select', params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );
}
