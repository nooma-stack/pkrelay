import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from '../bridge-interface.js';

export function registerWaitTool(server: McpServer, bridge: Bridge) {
  server.tool(
    'browser_wait',
    'Wait for a condition on the page — element to appear, text to be visible, or network to be idle.',
    {
      selector: z.string().optional().describe('Wait for element matching CSS selector'),
      text: z.string().optional().describe('Wait for visible text on page'),
      networkIdle: z.boolean().optional().describe('Wait for no pending network requests'),
      timeout: z.number().optional().default(10000).describe('Max wait time in ms (default 10000)'),
      tabId: z.number().optional().describe('Target tab ID'),
    },
    async (params) => {
      const result = await bridge.request('wait', params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );
}
