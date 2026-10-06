// One-line status of a Claude Code session — shared by the compact island and
// the session bubbles in the overview.

import { State, type AgentTask } from "../core/state";

const STATE_LABELS: Partial<Record<AgentTask["state"], string>> = {
  thinking: "Thinking…",
  working: "Working…",
  approval: "Needs permission",
  question: "Asking a question",
  finished: "Finished",
  error: "Stopped on an error",
  ratelimit: "Rate limited",
  idle: "Idle",
};

/** What the session is doing right now, in a few words. */
export function statusText(task: AgentTask): string {
  const req = State.pendingApproval;
  if (req && State.sessionTask(req.sessionId) === task) {
    return req.questions
      ? `Asks · ${req.questions[0].question}`
      : `Needs permission · ${req.command}`;
  }
  if (task.state === "idle") return STATE_LABELS.idle!;
  // The outcome first: the last step alone ("Run · git status") doesn't
  // say the session is done.
  if (task.state === "finished" || task.state === "error") {
    const last = task.steps.at(-1);
    const label = task.state === "finished" ? "✓ Finished" : "Stopped on an error";
    return last ? `${label} · ${last}` : label;
  }
  return task.steps.at(-1) ?? STATE_LABELS[task.state] ?? "…";
}

/** Text colour for a status line: the alert states stand out, work stays quiet. */
export function statusColor(task: AgentTask): string | null {
  switch (task.state) {
    case "approval":
    case "ratelimit":
      return "#F5A524";
    case "question":
      return "#22D3EE";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    default:
      return null;
  }
}

/** Working states get the shimmer, the same as the ticker's current row. */
export const isBusy = (task: AgentTask) => task.state === "working" || task.state === "thinking";

/**
 * Silence this long and a "working" session is taken to be stuck (an interrupt
 * sends no Stop), so it no longer keeps the compact island up.
 */
const STUCK_MS = 10 * 60 * 1000;

/**
 * A session still worth watching from the compact island: doing something, or
 * waiting on the user. Finished, idle and error are settled — nothing more will happen
 * until the user acts.
 */
export function isActive(task: AgentTask, nowMs = performance.now()): boolean {
  if (task.sessionId == null || task.state === "finished" || task.state === "idle" || task.state === "error") return false;
  const req = State.pendingApproval;
  if (req && req.sessionId === task.sessionId) return true;
  return nowMs - (task.lastWorkAt ?? 0) < STUCK_MS;
}
