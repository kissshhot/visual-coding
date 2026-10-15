import type { AgentState } from '../models/types.js';

/** A content hash may recur after a revert; observations before the last patch are still stale. */
export function currentObservations(state: AgentState) {
  const lastPatch = state.history.findLastIndex(h => h.tool === 'project_patch' && h.result.ok);
  return state.history.slice(Math.max(0, lastPatch)).filter(h => h.result.ok && h.result.revision === state.revision);
}
