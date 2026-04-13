import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerConsoleTool(server: McpServer, bridge: NativeMessagingBridge) {
  server.tool(
    'browser_console',
    'Get recent browser console messages (errors, warnings, logs). Useful for debugging JavaScript errors and API failures.',
    {
      level: z
        .enum(['error', 'warn', 'all'])
        .optional()
        .describe('Filter by message level (default: all)'),
      limit: z
        .number()
        .optional()
        .describe('Max messages to return (default: 50)'),
      clear: z
        .boolean()
        .optional()
        .describe('Clear console buffer after reading'),
      tabId: z
        .number()
        .optional()
        .describe('Target tab ID (defaults to active attached tab)'),
    },
    async (params) => {
      const result = await bridge.request('console.query', {
        level: params.level,
        limit: params.limit,
        tabId: params.tabId,
      });

      if (params.clear) {
        await bridge.request('console.clear', { tabId: params.tabId });
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
