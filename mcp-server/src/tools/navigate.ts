import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerNavigateTool(server: McpServer, bridge: NativeMessagingBridge) {
  server.tool(
    'browser_navigate',
    'Navigate to a URL, or go back/forward/reload.',
    {
      url: z.string().optional().describe('URL to navigate to'),
      back: z.boolean().optional().describe('Go back in history'),
      forward: z.boolean().optional().describe('Go forward in history'),
      reload: z.boolean().optional().describe('Reload the current page'),
      tabId: z.number().optional().describe('Target tab ID'),
    },
    async (params) => {
      const result = await bridge.request('navigate', params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );
}
