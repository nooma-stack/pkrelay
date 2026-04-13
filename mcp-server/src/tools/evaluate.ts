import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerEvaluateTool(server: McpServer, bridge: NativeMessagingBridge) {
  server.tool(
    'browser_evaluate',
    'Execute JavaScript in the page context and return the result. Use for custom interactions not covered by other tools.',
    {
      expression: z.string().describe('JavaScript expression to evaluate'),
      tabId: z.number().optional().describe('Target tab ID'),
    },
    async (params) => {
      const result = await bridge.request('evaluate', params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );
}
