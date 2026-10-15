import { z } from 'zod';

export const CONTRACT_VERSION = '0.1.0';
export const ContextSchema = z.object({
  workspace: z.string().min(1),
  run_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export type ToolContext = z.infer<typeof ContextSchema>;

export interface Artifact {
  id: string;
  path: string;
  mime_type: string;
  sha256: string;
  revision: string;
}

export interface ToolResult {
  [key: string]: unknown;
  contract_version: typeof CONTRACT_VERSION;
  ok: boolean;
  run_id: string;
  revision: string | null;
  data: Record<string, unknown>;
  artifacts: Artifact[];
  error: { code: string; message: string } | null;
  duration_ms: number;
}

export class ToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const selector = z.string().min(1).max(300);
export const definitions = {
  project_read: {
    description: 'Read a project file and its current content revision. revision=null bootstraps a run.',
    params: z.object({ path: z.string().min(1) }),
  },
  project_patch: {
    description: 'Replace UTF-8 project files after checking the expected revision. Returns the new revision.',
    params: z.object({ files: z.array(z.object({
      path: z.string().min(1), content: z.string().max(1_000_000),
    })).min(1).max(16) }),
  },
  project_run: {
    description: 'Start a loopback static preview for this HTML/CSS/JS project. No shell commands are executed.',
    params: z.object({}),
  },
  browser_capture: {
    description: 'Render the current project in Chromium and save a revision-bound PNG screenshot.',
    params: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), selector: selector.optional() }),
  },
  browser_inspect: {
    description: 'Inspect selected DOM elements, bounds, computed colors and browser errors.',
    params: z.object({ selectors: z.array(selector).min(1).max(12) }),
  },
  browser_act: {
    description: 'Click or fill one element in the current preview. Preserves page state until code changes.',
    params: z.discriminatedUnion('action', [
      z.object({ action: z.literal('click'), selector }),
      z.object({ action: z.literal('fill'), selector, text: z.string().max(10_000) }),
    ]),
  },
  artifact_save: {
    description: 'Save a JSON report or trace associated with the current project revision.',
    params: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), data: z.record(z.string(), z.unknown()) }),
  },
  visual_compare: {
    description: 'Compare a reference PNG with a current screenshot ID from this MCP session. Returns pixel metrics, changed bounds and a diff PNG; never resizes images.',
    params: z.object({
      reference: z.object({ data_base64: z.string().min(1).max(13_333_336), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
      candidate_id: z.string().uuid(), threshold: z.number().int().min(0).max(255).default(8),
      regions: z.array(z.object({ name: z.string().min(1).max(80), x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) })).max(16).default([]),
    }),
  },
} as const;
export type ToolName = keyof typeof definitions;
