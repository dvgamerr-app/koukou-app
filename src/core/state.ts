// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { UsageKey, UsageWindow } from "./usage";

export type AgentSource = "claudeCode" | "codex" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  /** Steps ever appended. `steps` is capped, so only this tells the ticker a new one arrived. */
  stepCount: number;
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Claude Code `session_id` — set on session tasks only. */
  sessionId?: string;
  /** The session's process chain and console window, to find its window again. */
  windowPids?: number[];
  consoleHwnd?: number | null;
  /** performance.now() of the last hook event, for pruning sessions that vanished. */
  lastEventAt?: number;
  /**
   * performance.now() of the last real hook event. Unlike `lastEventAt`, the
   * status line never refreshes it, so a session stuck "working" after an
   * interrupt does eventually stop counting as busy.
   */
  lastWorkAt?: number;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  /**
   * Set when the request is an AskUserQuestion: Claude is asking the user to
   * choose, not asking for permission, so the card shows the choices instead of
   * Allow / Deny.
   */
  questions?: AskQuestion[];
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect: boolean;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], stepCount: 0, source, isIntegration: true,
});

export const CLAUDE_ID = "integration_claude";

/** One Mochi per Claude Code session. The first is the classic white one. */
const SESSION_COLORS = ["#F5F6F8", "#38BDF8", "#E879F9", "#EAB308", "#2EC4A0", "#FF5A4E"];

export const sessionTaskId = (sessionId: string) => `session:${sessionId}`;

export const isSession = (
  t: AgentTask | null | undefined,
): t is AgentTask & { sessionId: string } =>
  !!t && t.sessionId != null;

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  shortcutsEnabled: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
}

export const DEFAULT_SETTINGS: Settings = {
  shortcutsEnabled: true,
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;
  /**
   * The session the Finished / Error card is about. Not the focus: a session
   * nobody was looking at can finish and get its card without taking the focus.
   */
  alertTaskId: string | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  /** Plan usage, one value per window for the whole account (see core/usage.ts). */
  usage: Record<UsageKey, UsageWindow | null> = { fiveHour: null, sevenDay: null };
  /** Codex plan usage, read from its session logs by the Rust side. */
  codexUsage: Record<UsageKey, UsageWindow | null> = { fiveHour: null, sevenDay: null };

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  /** Live Claude Code sessions, in the order they appeared. */
  get sessionTasks(): AgentTask[] {
    return this.tasks.filter(isSession);
  }

  /**
   * Every task the user can see. The generic VS Code pill only stands in for
   * Claude Code while no session is live — once one is, the sessions are it.
   */
  get visibleTasks(): AgentTask[] {
    const hasSession = this.tasks.some(isSession);
    return hasSession ? this.tasks.filter((t) => t.id !== CLAUDE_ID) : this.tasks;
  }

  get focusTask(): AgentTask | null {
    const visible = this.visibleTasks;
    return visible.find((t) => t.id === this.focusId) ?? visible[0] ?? null;
  }

  get otherTasks(): AgentTask[] {
    const focus = this.focusTask;
    return this.visibleTasks.filter((t) => t !== focus);
  }

  /** Who the Finished / Error card is about. */
  get alertTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.alertTaskId) ?? this.focusTask;
  }

  sessionTask(sessionId: string): AgentTask | null {
    return this.tasks.find((t) => t.sessionId === sessionId) ?? null;
  }

  /** Finds or creates the task for one Claude Code session. */
  ensureSession(sessionId: string, projectName: string, cwd: string, source: AgentSource = "claudeCode"): AgentTask {
    const existing = this.sessionTask(sessionId);
    if (existing) {
      if (cwd) existing.sessionCwd = cwd;
      existing.lastEventAt = performance.now();
      existing.lastWorkAt = existing.lastEventAt;
      return existing;
    }
    const sessions = this.sessionTasks;
    // Two windows on the same project still need telling apart.
    const sameName = sessions.filter(
      (t) => t.name === projectName || t.name.startsWith(`${projectName} `),
    );
    const name = sameName.length ? `${projectName} ${sameName.length + 1}` : projectName;
    const used = new Set(sessions.map((t) => t.color));
    const color =
      SESSION_COLORS.find((c) => !used.has(c)) ??
      SESSION_COLORS[sessions.length % SESSION_COLORS.length];
    const t: AgentTask = {
      id: sessionTaskId(sessionId), name, color, state: "idle", stepIndex: 0, steps: [],
      stepCount: 0, source, isIntegration: false, sessionCwd: cwd || null,
      sessionId, lastEventAt: performance.now(), lastWorkAt: performance.now(),
    };
    // Sessions sit before the integrations, in the order they appeared.
    const firstIntegration = this.tasks.findIndex((x) => !isSession(x));
    this.tasks.splice(firstIntegration < 0 ? this.tasks.length : firstIntegration, 0, t);
    // The first session takes over from the generic pill; later ones never take
    // the view — every window feeding one task is what made the island flip.
    const focusLive = this.tasks.some((x) => x.id === this.focusId);
    if (!this.focusId || this.focusId === CLAUDE_ID || !focusLive) this.focusId = t.id;
    return t;
  }

  removeSession(sessionId: string) {
    const idx = this.tasks.findIndex((t) => t.sessionId === sessionId);
    if (idx < 0) return;
    const [t] = this.tasks.splice(idx, 1);
    if (this.focusId === t.id) this.focusId = this.sessionTasks[0]?.id ?? CLAUDE_ID;
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    t.stepCount += 1;
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: sessions first (stable, so they keep the order they appeared in),
    // then integration_claude, then agent_* pills (visible in slice(0,4)), then
    // other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      if (isSession(a) || isSession(b)) return Number(isSession(b)) - Number(isSession(a));
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [], stepCount: 0,
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
