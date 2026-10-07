// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, isSession, type AgentTask, type AskOption, type AskQuestion } from "../core/state";
import { mergeWindow, parseWindow, type UsageKey, type UsageWindow } from "../core/usage";
import type { Island } from "./island";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

export interface HookPayload {
  hook_event_name?: string;
  provider?: "codex";
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  koukou_agent?: string;
  /** Statusline only: `five_hour` / `seven_day` plan usage windows. */
  rate_limits?: unknown;
  /** Added by the relay: the session's process chain, nearest first. */
  ancestor_pids?: unknown[];
  /** Added by the relay when the session runs in a classic console window. */
  console_hwnd?: unknown;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Step labels, one verb per tool. The macOS app's frenchStep() uses French
 * ("Exécute", "Écrit"…); the Windows island is English everywhere else, so
 * its steps are too.
 */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Run",
  Read: "Read",
  Write: "Write",
  Edit: "Edit",
  Glob: "Find",
  Grep: "Search",
  WebSearch: "Web search",
  WebFetch: "Fetch",
  TodoWrite: "Tasks",
  Task: "Agent",
  Agent: "Agent",
  LS: "List",
  MultiEdit: "Edit",
  NotebookEdit: "Notebook",
  PowerShell: "Run",
  apply_patch: "Edit",
};

/** A step is one line: multi-line commands and prompts collapse to one. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Text of the first `<tag>…</tag>` in `s`, or null. */
function tagText(s: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s);
  return m ? oneLine(m[1]) : null;
}

/**
 * What a UserPromptSubmit actually says. Not every prompt was typed: Claude
 * Code also submits markup of its own — a background task reporting back, a
 * slash command, a `!` shell line — and showing that raw put
 * "<task-notification> <task-id>…" in the ticker instead of what happened.
 */
export function promptStep(raw: string): string | null {
  // Context Claude Code attaches for the model, never meant to be read here.
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text) return null;

  if (text.startsWith("<task-notification>")) {
    const summary = tagText(text, "summary");
    const status = tagText(text, "status");
    return `↩ ${summary ?? (status ? `Background task ${status}` : "Background task update")}`;
  }

  const command = tagText(text, "command-name");
  if (command) {
    const args = tagText(text, "command-args");
    const name = command.startsWith("/") ? command : `/${command}`;
    return args ? `${name} ${args}` : name;
  }

  const bash = tagText(text, "bash-input");
  if (bash) return `! ${bash}`;

  // Output Claude Code echoes back into the conversation: nothing was asked.
  if (/^<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/.test(text)) return null;

  // A typed prompt stays as typed, even one that mentions `<div>`.
  if (!text.startsWith("<")) return oneLine(text);

  // Some other markup of Claude Code's: keep the words, drop the tags.
  const plain = oneLine(text.replace(/<\/?[a-z][\w-]*>/gi, " "));
  return plain || null;
}

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${oneLine(cmd).slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

/** Claude's multiple-choice tool. It reaches us as a PermissionRequest too. */
const ASK_TOOL = "AskUserQuestion";

/**
 * The questions of an AskUserQuestion call, or null if they are not in a shape
 * the card can show. In that case the terminal asks instead: offering Allow on
 * a question would answer nothing and only skip the question.
 */
function parseQuestions(input: Record<string, unknown>): AskQuestion[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") return null;
    const { question, header, options, multiSelect } = q as Record<string, unknown>;
    if (typeof question !== "string" || !Array.isArray(options) || options.length === 0) return null;
    const opts: AskOption[] = [];
    for (const o of options) {
      const label = (o as Record<string, unknown>)?.label;
      if (typeof label !== "string" || !label) return null;
      const description = (o as Record<string, unknown>).description;
      opts.push({ label, description: typeof description === "string" ? description : undefined });
    }
    questions.push({
      question,
      header: typeof header === "string" ? header : undefined,
      options: opts,
      multiSelect: multiSelect === true,
    });
  }
  return questions;
}

/** A session that has said nothing for this long is gone (VS Code was closed). */
const STALE_MS = 30 * 60 * 1000;

/** Sessions whose window closed without a SessionEnd would linger forever. */
function pruneStale(now: number) {
  for (const t of State.sessionTasks) {
    if (State.pendingApproval?.sessionId === t.sessionId) continue;
    if (now - (t.lastEventAt ?? now) > STALE_MS) State.removeSession(t.sessionId!);
  }
}

/** Fires at the next reset time, so a finished window leaves the bar on time. */
let usageExpiry: number | null = null;

/**
 * The status line's usage report. It never creates a session — a status line
 * also runs for a session that is just sitting there — but it does tell us an
 * existing one is still alive, which keeps it from being pruned as stale.
 */
function handleStatusline(sessionId: string, raw: unknown) {
  const t = State.sessionTask(sessionId);
  if (t) t.lastEventAt = performance.now();

  const limits = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const nowS = Date.now() / 1000;
  const next = {
    fiveHour: mergeWindow(State.usage.fiveHour, parseWindow(limits.five_hour), nowS),
    sevenDay: mergeWindow(State.usage.sevenDay, parseWindow(limits.seven_day), nowS),
  };
  const same = (a: UsageWindow | null, b: UsageWindow | null) =>
    a?.pct === b?.pct && a?.resetsAt === b?.resetsAt;
  if (same(next.fiveHour, State.usage.fiveHour) && same(next.sevenDay, State.usage.sevenDay)) return;
  State.usage = next;

  if (usageExpiry != null) window.clearTimeout(usageExpiry);
  const resets = [next.fiveHour, next.sevenDay].filter(Boolean).map((w) => w!.resetsAt);
  if (resets.length) {
    const ms = Math.max(1000, (Math.min(...resets) - nowS) * 1000 + 500);
    // Capped well below setTimeout's 24.8-day ceiling; a 7-day window just rechecks.
    usageExpiry = window.setTimeout(() => {
      usageExpiry = null;
      handleStatusline("", null);
    }, Math.min(ms, 6 * 3600 * 1000));
  }
  State.notify();
}

/** Stop resets its own session to idle after a moment; one timer per session. */
const idleTimers = new Map<string, number>();

/**
 * A /goal session fires Stop after every turn and then carries on by itself, so
 * Stop is held back for a moment: only if nothing follows is the turn really over.
 */
const STOP_GRACE_MS = 4000;
const stopTimers = new Map<string, number>();
/** Events that mean the session is working again after a Stop. */
const RESUME_EVENTS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "PermissionRequest"]);

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  const toWindow = (w: unknown): UsageWindow | null => {
    if (!w || typeof w !== "object") return null;
    const { pct, resetsAt } = w as Record<string, unknown>;
    return typeof pct === "number" && typeof resetsAt === "number" ? { pct, resetsAt } : null;
  };

  // The last known limits survive a restart; a window past its reset is dropped.
  void Bridge.usageCacheLoad().then((cached) => {
    const c = (cached && typeof cached === "object" ? cached : {}) as Record<string, Record<string, unknown> | undefined>;
    const nowS = Date.now() / 1000;
    const fresh = (w: unknown) => mergeWindow(null, toWindow(w), nowS);
    State.usage = {
      fiveHour: State.usage.fiveHour ?? fresh(c.claude?.fiveHour),
      sevenDay: State.usage.sevenDay ?? fresh(c.claude?.sevenDay),
    };
    State.codexUsage = {
      fiveHour: State.codexUsage.fiveHour ?? fresh(c.codex?.fiveHour),
      sevenDay: State.codexUsage.sevenDay ?? fresh(c.codex?.sevenDay),
    };
    State.notify();
  });

  let saved = "";
  const persist = () => {
    const next = JSON.stringify({ claude: State.usage, codex: State.codexUsage });
    if (next === saved) return;
    saved = next;
    void Bridge.usageCacheSave({ claude: State.usage, codex: State.codexUsage });
  };
  State.subscribe(persist);

  void onEvent<Record<UsageKey, unknown>>("codex-usage", (raw) => {
    State.codexUsage = { fiveHour: toWindow(raw.fiveHour), sevenDay: toWindow(raw.sevenDay) };
    State.notify();
  });
  // Claude's limits fetched from the account: merged like a status-line report.
  void onEvent<Record<UsageKey, unknown>>("claude-usage", (raw) => {
    const nowS = Date.now() / 1000;
    State.usage = {
      fiveHour: mergeWindow(State.usage.fiveHour, toWindow(raw.fiveHour), nowS),
      sevenDay: mergeWindow(State.usage.sevenDay, toWindow(raw.sevenDay), nowS),
    };
    State.notify();
  });
}

/** Exported for dev/sessions-preview.ts, which plays fake sessions in a browser. */
export function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = `${payload.provider === "codex" ? "Codex · " : ""}${aliasProjectName(raw || "Session")}`;
  // Every VS Code window runs its own session. Feeding them all into one task
  // made the island flip between projects on every event; each gets its own.
  const sessionId = `${payload.provider === "codex" ? "codex:" : ""}${payload.session_id || "default"}`;

  pruneStale(performance.now());

  if (name === "Statusline") {
    handleStatusline(sessionId, payload.rate_limits);
    return;
  }

  // Route to the right pill. Valid koukou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → the session's own pill.
  const validAgent = validateAgent(payload.koukou_agent);
  const isExternalAgent = validAgent !== null;

  if (name === "SessionEnd") {
    if (isExternalAgent) {
      State.removeTask(`agent_${validAgent}`);
      return;
    }
    const t = State.sessionTask(sessionId);
    if (t) {
      window.clearTimeout(idleTimers.get(sessionId));
      idleTimers.delete(sessionId);
      window.clearTimeout(stopTimers.get(sessionId));
      stopTimers.delete(sessionId);
      State.removeSession(sessionId);
    }
    State.notify();
    return;
  }

  let task: AgentTask | null;
  if (isExternalAgent) {
    const agentId = `agent_${validAgent}`;
    // Only work events create the pill: a late event after Stop removed it must
    // not bring it back.
    if (name === "SessionStart" || name === "UserPromptSubmit" || name === "PreToolUse") {
      State.upsertExternalAgent(agentId, validAgent, agentColor(validAgent));
    }
    task = State.tasks.find((t) => t.id === agentId) ?? null;
  } else {
    task = State.ensureSession(sessionId, projectName, cwd, payload.provider === "codex" ? "codex" : "claudeCode");
    // Only some events carry these (see WINDOW_EVENTS in the relay); keep the last.
    if (Array.isArray(payload.ancestor_pids) && payload.ancestor_pids.length) {
      task.windowPids = payload.ancestor_pids.filter((p): p is number => typeof p === "number");
      task.consoleHwnd = typeof payload.console_hwnd === "number" ? payload.console_hwnd : null;
    }
  }
  const id = task?.id ?? `agent_${validAgent}`;
  // An external agent whose pill is gone has nothing to show. Its permission
  // requests still go through the case below, which hands them back.
  if (!task && name !== "PermissionRequest") return;
  const focused = task != null && State.focusTask === task;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  if (!isExternalAgent && RESUME_EVENTS.has(name)) {
    // The session went on after Stop: the held Stop never happened (a goal still
    // running), or its Finished card is already up and has nothing left to say.
    if (stopTimers.has(sessionId)) {
      window.clearTimeout(stopTimers.get(sessionId));
      stopTimers.delete(sessionId);
    }
    if (State.mode === "expanded" && State.view === "finished" && State.alertTaskId === id) {
      State.alertTaskId = null;
      island.collapse();
    }
    if (task?.pillBadge === "finished") State.setPillBadge(id, null);
  }

  switch (name) {
    case "SessionStart":
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      State.updateTask(id, "thinking");
      // A new turn: "done" or "failed" from the last one no longer holds.
      if (task?.pillBadge === "finished" || task?.pillBadge === "error") State.setPillBadge(id, null);
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = promptStep(payload.prompt ?? payload.message ?? "");
      if (asked) State.appendStep(id, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      State.updateTask(id, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(id, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(id, "working");
      break;

    case "Interrupt":
      State.updateTask(id, "idle");
      State.appendStep(id, "Interrupted");
      break;

    case "PostToolUseFailure":
      State.updateTask(id, "working");
      State.appendStep(id, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(id, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(id, "question");
        State.appendStep(id, message);
      }
      break;
    }

    case "Stop": {
      const finish = () => {
        const focused = State.focusTask != null && State.focusTask.id === id;
        State.updateTask(id, "finished");
        if (payload.message) State.appendStep(id, payload.message.slice(0, 60));
        Sound.play("finish");
        // Every session gets its Finished card, watched or not — the card names
        // the session, and the focus stays where it was. Only when the card would
        // interrupt something (a decision, a message being typed…) does it fall
        // back to the compact bar saying so for a moment.
        if (!focused) State.setPillBadge(id, "finished");
        if (focused || island.canPopUp()) {
          State.alertTaskId = id;
          surface("finished", true);
        } else {
          island.announce(id);
        }
        if (isExternalAgent) {
          // An external agent's pill only lives for its turn.
          window.setTimeout(() => State.removeTask(id), 5200);
          return;
        }
        window.clearTimeout(idleTimers.get(sessionId));
        idleTimers.set(sessionId, window.setTimeout(() => {
          idleTimers.delete(sessionId);
          const t = State.sessionTask(sessionId);
          if (!t || t.state !== "finished") return;
          // The badge is left alone: clearing it here made an unwatched session's
          // "done" vanish five seconds later. Focusing the session clears it.
          State.updateTask(id, "idle");
        }, 5200));
      };
      if (isExternalAgent) {
        finish();
        break;
      }
      window.clearTimeout(stopTimers.get(sessionId));
      stopTimers.set(sessionId, window.setTimeout(() => {
        stopTimers.delete(sessionId);
        finish();
      }, STOP_GRACE_MS));
      break;
    }

    case "StopFailure":
      State.updateTask(id, "error");
      Sound.play("error");
      if (!focused) State.setPillBadge(id, "error");
      if (focused || island.canPopUp()) {
        State.alertTaskId = id;
        surface("error", true);
      } else {
        island.announce(id);
      }
      break;

    case "SubagentStart":
      State.appendStep(id, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(id, "• subagent done");
      break;

    case "PermissionRequest": {
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      if (payload.provider === "codex" && tool === ASK_TOOL) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      const questions = tool === ASK_TOOL ? parseQuestions(input) : null;
      if (tool === ASK_TOOL && !questions) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      State.pendingApproval = {
        requestId,
        sessionId,
        tool,
        command: questions ? questions[0].question : approvalTarget(tool, input),
        questions: questions ?? undefined,
      };
      const view = questions ? "ask" : "approval";
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(id, questions ? "question" : "approval");
      State.isPinned = true;
      Sound.play("approval");
      // Another session holding the view hands it over: a permission request is
      // the one thing worth switching windows for, and the card names the session.
      if (focused || isSession(State.focusTask)) {
        State.focusId = id;
        island.alert(view);
      } else {
        // An integration holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(id, "approval");
        island.reveal();
      }
      // Koukou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(id, "working");
        State.setPillBadge(id, null);
        if (State.view === "approval" || State.view === "ask") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
