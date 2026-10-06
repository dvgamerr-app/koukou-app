// Dev harness: several Claude Code sessions at once, in a plain browser, so the
// overview, the session bubbles and the compact status can be watched without
// opening three VS Code windows. Not part of the app bundle.
//
//   ?sessions=1|2|3   how many sessions talk (default 3)
//   ?integrations=0   no integration pills (the solo layout)
//   ?mode=compact     the compact island instead of the overview

import "../src/style.css";
import { State } from "../src/core/state";
import { Island } from "../src/island/island";
import { handleHook, type HookPayload } from "../src/island/hooks";

const q = new URLSearchParams(location.search);
const sessionCount = Number(q.get("sessions") ?? 3);
const compact = q.get("mode") === "compact";
if (q.get("integrations") === "0") State.settings.activeIntegrations = [];

const island = new Island(document.getElementById("root")!);
State.loadIntegrationTasks();
island.applySettings();

const SESSIONS = [
  { id: "s-coucou", cwd: "E:\\coucou" },
  { id: "s-api", cwd: "E:\\work\\billing-api" },
  { id: "s-web", cwd: "E:\\work\\storefront" },
].slice(0, sessionCount);

const SCRIPT: Omit<HookPayload, "session_id" | "cwd">[] = [
  { hook_event_name: "UserPromptSubmit", prompt: "Fix the overlapping ticker text" },
  { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "src/views/ticker.ts" } },
  { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 1; netstat -an | findstr 1420" } },
  { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "tick-text" } },
  { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "src/style.css" } },
  { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "GODEBUG=http2client=0 go test ./..." } },
];

const send = (s: (typeof SESSIONS)[number], p: Omit<HookPayload, "session_id" | "cwd">) =>
  handleHook(island, { ...p, session_id: s.id, cwd: s.cwd });

for (const s of SESSIONS) send(s, { hook_event_name: "SessionStart" });
// Each session gets a head start so they are mid-task, not in lockstep.
SESSIONS.forEach((s, i) => {
  for (let k = 0; k <= i + 1; k++) send(s, SCRIPT[k % SCRIPT.length]);
});

if (compact) island.collapse();
else island.alert("overview");
State.isPinned = true;

// Every session reports plan usage through its status line, each a little out
// of date in its own way; the bar must show the highest of them.
//   ?usage=0 — no usage reports (API-key users, or not installed yet)
if (q.get("usage") !== "0") {
  const now = Math.floor(Date.now() / 1000);
  SESSIONS.forEach((s, i) => send(s, {
    hook_event_name: "Statusline",
    rate_limits: {
      five_hour: { used_percentage: [42, 67.4, 55][i], resets_at: now + 2 * 3600 },
      seven_day: { used_percentage: [18, 12, 91][i], resets_at: now + 4 * 86400 },
    },
  }));
}

// ?ask=1 — the first session asks a multiple-choice question (AskUserQuestion),
// ?ask=multi — two questions, the second one multi-select.
const ask = q.get("ask");
if (ask && SESSIONS[0]) {
  const questions: Record<string, unknown>[] = [{
    question: "PR ของ panel จะจัดการแบบไหนคะ? งานใหม่อยู่บน branch parked/interactive-world-map ซึ่งเป็น PR #5 ที่ติดป้าย PARKED อยู่",
    header: "PR",
    multiSelect: false,
    options: [
      { label: "อัปเดต PR #5 (Recommended)", description: "เขียน title และ description ใหม่ เอาป้าย PARKED ออก ยังเป็น draft" },
      { label: "เปิด PR ใหม่", description: "สร้าง branch ใหม่จาก HEAD แล้วเปิด PR ใหม่ไป main" },
      { label: "คงป้าย PARKED ไว้", description: "อัปเดต description ของ #5 แต่ยังคงสถานะ do not merge" },
    ],
  }];
  if (ask === "multi") {
    questions.push({
      question: "Which checks should run before the PR?",
      header: "CI",
      multiSelect: true,
      options: [{ label: "lint" }, { label: "test" }, { label: "build" }],
    });
  }
  window.setTimeout(() => send(SESSIONS[0], {
    hook_event_name: "PermissionRequest",
    request_id: "dev-ask",
    tool_name: "AskUserQuestion",
    tool_input: { questions },
  }), 300);
}

// ?done=1 — every session finishes and goes idle: only the usage stays on the bar.
if (q.get("done") === "1") {
  for (const s of SESSIONS) send(s, { hook_event_name: "SessionEnd" });
}

// ?finish=1 — a session nobody is looking at finishes: the bar must say so.
const finish = q.get("finish") === "1";
if (finish && SESSIONS[1]) {
  window.setTimeout(() => send(SESSIONS[1], { hook_event_name: "Stop" }), 1200);
}

// Keep everyone busy, out of step with each other.
let n = 0;
if (q.get("done") !== "1" && !finish) window.setInterval(() => {
  n++;
  SESSIONS.forEach((s, i) => {
    if ((n + i) % (i + 2) === 0) send(s, SCRIPT[(n + i) % SCRIPT.length]);
  });
}, 700);
