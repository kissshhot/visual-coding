import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { createHash } from 'node:crypto';

const ArtifactSchema = z.object({ id: z.string(), path: z.string(), mime_type: z.string(), sha256: z.string(), revision: z.string() });
export const ResultSchema = z.object({
  contract_version: z.literal('0.1.0'), ok: z.boolean(), run_id: z.string(), revision: z.string().nullable(),
  data: z.record(z.string(), z.unknown()), artifacts: z.array(ArtifactSchema),
  error: z.object({ code: z.string(), message: z.string() }).nullable(), duration_ms: z.number(),
});
export type ToolResult = z.infer<typeof ResultSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export interface ImageObservation { mimeType: string; data: string }
export interface Observation { tool: string; params: Record<string, unknown>; result: ToolResult; images: ImageObservation[] }

/** Keep audit evidence without duplicating multi-megabyte input image payloads. */
export function summarizeObservation({ images, ...entry }: Observation) {
  const params = { ...entry.params };
  if (entry.tool === 'visual_compare' && params.reference) {
    const { data_base64, ...reference } = params.reference as Record<string, unknown>;
    params.reference = { ...reference, encoded_bytes: typeof data_base64 === 'string' ? data_base64.length : 0 };
  }
  return { ...entry, params, image_count: images.length };
}

export class PluginsClient {
  private client = new Client({ name: 'visual-coding-agent', version: '0.1.0' });
  private tools = new Set<string>();

  async connect(serverPath: string, workspace: string, signal?: AbortSignal, browserChannel?: 'chrome' | 'chromium'): Promise<string[]> {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [serverPath, '--root', workspace, ...(browserChannel ? ['--browser-channel', browserChannel] : [])], stderr: 'inherit',
    });
    try {
      await this.client.connect(transport, { signal, timeout: 15_000 });
      const listing = await this.client.listTools({}, { signal, timeout: 15_000 });
      for (const tool of listing.tools) this.tools.add(tool.name);
      return [...this.tools];
    } catch (error) { await transport.close(); throw error; }
  }

  async call(tool: string, params: Record<string, unknown>, context: { workspace: string; run_id: string; revision: string | null }, timeoutMs: number): Promise<Observation> {
    if (!this.tools.has(tool)) throw new Error(`Plugin does not expose tool: ${tool}`);
    const reply = await this.client.callTool({ name: tool, arguments: { ...context, params } }, { timeout: timeoutMs });
    if (!('content' in reply) || !Array.isArray(reply.content)) throw new Error('Unexpected MCP tool result');
    const text = reply.content.find(block => block.type === 'text');
    const payload = 'structuredContent' in reply && reply.structuredContent
      ? reply.structuredContent : text?.type === 'text' ? JSON.parse(text.text) : null;
    const result = ResultSchema.parse(payload);
    if (result.run_id !== context.run_id) throw new Error('Plugin returned a different run_id');
    if (result.ok && result.revision === null) throw new Error('Successful result must identify its code revision');
    const images: ImageObservation[] = [];
    for (const block of reply.content) if (block.type === 'image') images.push({ mimeType: block.mimeType, data: block.data });
    if (['browser_capture', 'visual_compare'].includes(tool) && result.ok) {
      const image = images[0];
      const artifact = result.artifacts.find(a => a.mime_type === 'image/png');
      if (images.length !== 1 || image?.mimeType !== 'image/png' || !artifact || artifact.revision !== result.revision || createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex') !== artifact.sha256) throw new Error('Screenshot bytes do not match the revision-bound artifact');
    }
    return { tool, params, result, images };
  }

  async close(): Promise<void> { await this.client.close(); }
}
