import { z } from 'zod';
import type { Observation } from '../plugins/client.js';

export const TaskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/), title: z.string().min(1).max(120),
  description: z.string().min(1).max(500), accent: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  button_label: z.string().min(1).max(80), success_text: z.string().min(1).max(120),
  instructions: z.string().max(4000).optional(),
  reference_image: z.string().min(1).optional(),
  editable_files: z.array(z.string().min(1)).min(1).max(16).optional(),
  setup_actions: z.array(z.object({ action: z.literal('fill'), selector: z.string().min(1).max(300), text: z.string().max(1000) })).max(4).optional(),
});
export type Task = z.infer<typeof TaskSchema>;
export const AssessmentSchema = z.object({
  verdict: z.enum(['pass', 'revise']), summary: z.string().min(1).max(2000),
  issues: z.array(z.object({
    description: z.string().min(1).max(1000), region: z.string().min(1).max(200),
    severity: z.enum(['major', 'minor']),
  }).strict()).max(12),
}).strict();
export type Assessment = z.infer<typeof AssessmentSchema>;
export interface VisualReview {
  revision: string; screenshot_id: string; screenshot_sha256: string;
  assessment: Assessment; model_call: number;
}
export interface AgentState { task: Task; history: readonly Observation[]; revision: string | null; reviews?: readonly VisualReview[] }
export type Decision = { type: 'tool'; tool: string; params: Record<string, unknown> }
  | { type: 'review'; review: VisualReview }
  | { type: 'finish'; summary: string };

/** Model adapters receive screenshot bytes and revision-bound observations. */
export interface ModelAdapter {
  readonly name: string;
  readonly requiresVisualReview?: boolean;
  decide(state: AgentState, signal: AbortSignal): Promise<Decision>;
}
