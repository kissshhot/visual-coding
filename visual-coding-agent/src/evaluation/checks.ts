import type { AgentState } from '../models/types.js';
import { rgb } from '../models/offline.js';
import { currentObservations } from './observations.js';

export function evaluate(state: AgentState) {
  const current = currentObservations(state);
  const inspection = current.filter(item => item.tool === 'browser_inspect' && item.result.ok).at(-1);
  const elements = (inspection?.result.data.elements ?? []) as { selector: string; text?: string; styles?: { backgroundColor?: string } }[];
  const heading = elements.find(e => e.selector === 'h1');
  const button = elements.find(e => e.selector === '#action');
  const status = elements.find(e => e.selector === '#status');
  const errors = current.flatMap(item => (item.result.data.console_errors ?? []) as string[]);
  const capture = current.findLast(item => item.tool === 'browser_capture' && item.result.ok);
  const screenshot = capture?.result.artifacts.find(a => a.mime_type === 'image/png');
  const review = state.reviews?.findLast(r => r.revision === state.revision && r.screenshot_id === screenshot?.id);
  const click = current.findLast(item => item.tool === 'browser_act' && item.params.action === 'click' && item.params.selector === '#action');
  const beforeClick = click ? current.slice(0, current.indexOf(click)).findLast(item => item.tool === 'browser_inspect') : undefined;
  const beforeElements = (beforeClick?.result.data.elements ?? []) as { selector: string; text?: string }[];
  const beforeStatus = beforeElements.find(e => e.selector === '#status')?.text;
  const changed = beforeStatus !== undefined && beforeStatus !== state.task.success_text && status?.text === state.task.success_text;
  return {
    runtime: capture && errors.length === 0 ? 'passed' : 'failed',
    specified_dom_checks: heading?.text === state.task.title && button?.styles?.backgroundColor === rgb(state.task.accent) ? 'passed' : 'failed',
    interaction: click && inspection && current.indexOf(inspection) > current.indexOf(click) && changed ? 'passed' : 'failed',
    interaction_evidence: { before_text: beforeStatus ?? null, after_text: status?.text ?? null, changed_to_expected: changed },
    visual_quality: review ? (review.assessment.verdict === 'pass' ? 'model_review_passed' : 'model_review_failed') : 'not_evaluated',
    console_errors: [...new Set(errors)],
  };
}
