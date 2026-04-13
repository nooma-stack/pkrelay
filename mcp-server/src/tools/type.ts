import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerTypeTool(server: McpServer, bridge: NativeMessagingBridge) {
  server.tool(
    'browser_type',
    'Type text into an input field. Optionally clear the field first or submit after typing.',
    {
      selector: z.string().optional().describe('CSS selector of target input'),
      text: z.string().describe('Text to type'),
      clear: z.boolean().optional().describe('Clear field first'),
      submit: z.boolean().optional().describe('Press Enter after typing'),
      tabId: z.number().optional().describe('Target tab ID'),
    },
    async (params) => {
      const result = await bridge.request('type', params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );
}
