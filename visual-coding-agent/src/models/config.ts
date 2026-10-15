import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ChatConfig, ModelImage } from './chat-completions.js';

const ConfigSchema = z.object({
  endpoint: z.string().url(), model: z.string().min(1), thinking: z.literal('disabled').optional(),
  max_requests: z.number().int().min(1).max(100).default(12),
  max_output_tokens: z.number().int().min(128).max(32000).default(8192),
  request_timeout_ms: z.number().int().min(100).max(300000).default(120000),
  min_interval_ms: z.number().int().min(0).max(60000).default(3200),
}).strict();

export async function loadModelConfig(root: string, configPath?: string, keyFile?: string): Promise<ChatConfig> {
  const config = configPath ?? process.env.VC_MODEL_CONFIG;
  const settings = ConfigSchema.parse(config
    ? JSON.parse(await readFile(path.resolve(root, config), 'utf8'))
    : { endpoint: process.env.OPENAI_CHAT_ENDPOINT ?? `${(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, model: process.env.OPENAI_MODEL });
  const credentialFile = keyFile ?? process.env.OPENAI_API_KEY_FILE;
  const apiKey = credentialFile ? (await readFile(path.resolve(root, credentialFile), 'utf8')).trim() : process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('Set OPENAI_API_KEY_FILE or OPENAI_API_KEY before using the multimodal adapter');
  return { endpoint: settings.endpoint, model: settings.model, thinking: settings.thinking, apiKey,
    maxRequests: settings.max_requests, maxOutputTokens: settings.max_output_tokens,
    requestTimeoutMs: settings.request_timeout_ms, minIntervalMs: settings.min_interval_ms };
}

export async function loadReference(file: string): Promise<ModelImage> {
  const bytes = await readFile(file);
  if (bytes.length > 10_000_000) throw new Error('Reference image exceeds 10 MB');
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : undefined;
  if (!mimeType) throw new Error('Reference must be a PNG or JPEG image');
  return { label: 'REFERENCE: intended visual appearance. The status text may change after interaction.', mimeType, data: bytes.toString('base64') };
}
