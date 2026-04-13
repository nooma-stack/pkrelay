import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NativeMessagingBridge } from '../bridge.js';

export function registerTabTools(server: McpServer, bridge: NativeMessagingBridge) {
  server.tool(
    'browser_tabs',
    'List open browser tabs with their titles, URLs, and debugger attachment status.',
    {
      attached: z
        .boolean()
        .optional()
        .describe('Filter to only attached tabs'),
    },
    async (params) => {
      const requestParams: Record<string, unknown> = {};
      if (params.attached !== undefined) requestParams.attached = params.attached;

      const result = await bridge.request('tabs.list', requestParams);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'browser_tab_attach',
    'Attach the debugger to a browser tab. Required before using any other browser tools on that tab. The tab must have been granted permission by the user via the PKRelay extension icon.',
    {
      tabId: z
        .number()
        .describe('Tab ID to attach the debugger to'),
    },
    async (params) => {
      const result = await bridge.request('tabs.attach', { tabId: params.tabId });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'browser_tab_detach',
    'Detach the debugger from a browser tab.',
    {
      tabId: z
        .number()
        .describe('Tab ID to detach the debugger from'),
    },
    async (params) => {
      const result = await bridge.request('tabs.detach', { tabId: params.tabId });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'browser_tab_switch',
    'Switch to a browser tab by ID or title match.',
    {
      tabId: z
        .number()
        .optional()
        .describe('Tab ID to switch to'),
      title: z
        .string()
        .optional()
        .describe('Partial match on tab title'),
    },
    async (params) => {
      const requestParams: Record<string, unknown> = {};
      if (params.tabId !== undefined) requestParams.tabId = params.tabId;
      if (params.title !== undefined) requestParams.title = params.title;

      const result = await bridge.request('tabs.switch', requestParams);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
