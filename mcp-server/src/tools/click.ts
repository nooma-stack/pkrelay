import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from '../bridge-interface.js';

export function registerClickTool(server: McpServer, bridge: Bridge) {
  server.tool(
    'browser_click',
    'Click an element on the page by CSS selector, visible text, or element index from a snapshot.',
    {
      selector: z.string().optional().describe('CSS selector'),
      text: z.string().optional().describe('Match by visible text'),
      index: z.number().optional().describe('Element index from snapshot'),
      tabId: z.number().optional().describe('Target tab ID'),
    },
    async (params) => {
      const result = await bridge.request('click', params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );
}
