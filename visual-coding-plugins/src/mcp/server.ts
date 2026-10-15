import { McpServer } from '@modelcontextprotocol/server';
import { ContextSchema, definitions, type ToolName } from '../core/contract.js';
import { PluginRuntime } from '../core/runtime.js';

export function createServer(root: string, browserChannel?: 'chrome' | 'chromium') {
  const runtime = new PluginRuntime(root, browserChannel);
  const server = new McpServer({ name: 'visual-coding-plugins', version: '0.1.0' });
  for (const name of Object.keys(definitions) as ToolName[]) {
    const definition = definitions[name];
    server.registerTool(name, {
      description: definition.description,
      inputSchema: ContextSchema.extend({ params: definition.params }),
    }, async input => {
      const { result, image } = await runtime.invoke(name, input);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result) },
          ...(image ? [{ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/png' }] : []),
        ],
        structuredContent: result,
        isError: !result.ok,
      };
    });
  }
  return { server, runtime };
}
