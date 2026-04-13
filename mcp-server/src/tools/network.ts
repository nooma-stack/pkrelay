import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerNetworkTool(server: McpServer, bridge: NativeMessagingBridge) {
  server.tool(
    'browser_network',
    'Get captured network requests and responses. Filter by URL pattern, HTTP method, or status code. Useful for debugging API calls.',
    {
      filter: z
        .string()
        .optional()
        .describe('URL pattern to match (substring or glob)'),
      method: z
        .string()
        .optional()
        .describe('HTTP method filter (e.g. "GET", "POST")'),
      status: z
        .string()
        .optional()
        .describe('Status code filter (e.g. "4xx", "500")'),
      limit: z
        .number()
        .optional()
        .describe('Max requests to return (default: 50)'),
      clear: z
        .boolean()
        .optional()
        .describe('Clear network buffer after reading'),
      tabId: z
        .number()
        .optional()
        .describe('Target tab ID (defaults to active attached tab)'),
    },
    async (params) => {
      const requestParams: Record<string, unknown> = {};
      if (params.filter !== undefined) requestParams.filter = params.filter;
      if (params.method !== undefined) requestParams.method = params.method;
      if (params.status !== undefined) requestParams.status = params.status;
      if (params.limit !== undefined) requestParams.limit = params.limit;
      if (params.tabId !== undefined) requestParams.tabId = params.tabId;

      const result = await bridge.request('network.query', requestParams);

      if (params.clear) {
        await bridge.request('network.clear', { tabId: params.tabId });
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
