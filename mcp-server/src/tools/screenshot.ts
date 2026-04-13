import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerScreenshotTool(server: McpServer, bridge: NativeMessagingBridge) {
  server.tool(
    'browser_screenshot',
    'Capture a screenshot of the current page. Can crop to a specific element or region for token efficiency. Use browser_snapshot first to identify elements, then screenshot specific areas.',
    {
      selector: z
        .string()
        .optional()
        .describe('CSS selector to crop screenshot to element bounds'),
      region: z
        .object({
          x: z.number().describe('X coordinate of crop region'),
          y: z.number().describe('Y coordinate of crop region'),
          width: z.number().describe('Width of crop region'),
          height: z.number().describe('Height of crop region'),
        })
        .optional()
        .describe('Arbitrary crop region in pixels'),
      fullPage: z
        .boolean()
        .optional()
        .default(false)
        .describe('Capture full scrollable page (default false, viewport only)'),
      tabId: z
        .number()
        .optional()
        .describe('Target tab ID (defaults to active attached tab)'),
    },
    async (params) => {
      const requestParams: Record<string, unknown> = {
        fullPage: params.fullPage,
      };
      if (params.selector !== undefined) requestParams.selector = params.selector;
      if (params.region !== undefined) requestParams.region = params.region;
      if (params.tabId !== undefined) requestParams.tabId = params.tabId;

      const result = (await bridge.request('screenshot', requestParams)) as {
        data: string;
        mimeType?: string;
      };

      return {
        content: [
          {
            type: 'image' as const,
            data: result.data,
            mimeType: (result.mimeType as 'image/png') || 'image/png',
          },
        ],
      };
    },
  );
}
