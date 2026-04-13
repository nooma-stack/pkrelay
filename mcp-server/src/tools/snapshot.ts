import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerSnapshotTool(server: McpServer, bridge: NativeMessagingBridge) {
  server.tool(
    'browser_snapshot',
    'Get a token-efficient structured representation of the current page. Returns headings, forms, buttons, links, and text with element indices and bounding boxes.',
    {
      format: z
        .enum(['compact', 'structured'])
        .optional()
        .default('compact')
        .describe('Output format: "compact" for minimal tokens, "structured" for detailed hierarchy'),
      selector: z
        .string()
        .optional()
        .describe('CSS selector to scope snapshot to a subtree'),
      tabId: z
        .number()
        .optional()
        .describe('Target tab ID (defaults to active attached tab)'),
    },
    async (params) => {
      const result = await bridge.request('snapshot', {
        format: params.format,
        ...(params.selector !== undefined && { selector: params.selector }),
        ...(params.tabId !== undefined && { tabId: params.tabId }),
      }) as Record<string, unknown>;

      // For compact format, return only the lines array to minimize tokens
      let output: string;
      if (params.format === 'compact' || !params.format) {
        const content = result?.content as Record<string, unknown> | undefined;
        const lines = content?.lines as string[] | undefined;
        if (lines) {
          output = lines.join('\n');
        } else {
          output = typeof result === 'string' ? result : JSON.stringify(result);
        }
      } else {
        output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      }

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    },
  );
}
