// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { CLAUDE_ID, State, isSession, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { isBusy, statusColor, statusText } from "./status";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  /** AskUserQuestion: for each question, the indices of the chosen options. */
  answer(choices: number[][]): void;
  /** AskUserQuestion: let the terminal ask it instead. */
  answerInTerminal(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** True while `tick` still has motion to finish — keeps the frame loop alive. */
  readonly animating?: boolean;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const minimizeBtn = h("button", { title: "Minimize to compact", "aria-label": "Minimize to compact", onclick: () => actions.collapse() }, svg(ICONS.minus, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    h("div", { class: "header-actions" }, minimizeBtn, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

/** How many other sessions fit as bubbles, with and without the integration row. */
const MAX_BUBBLES_WITH_CHIPS = 2;
const MAX_BUBBLES = 3;

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";
  /** Bubble texts, refreshed on every sync without rebuilding the mini Mochis. */
  let bubbles: { task: AgentTask; text: HTMLElement }[] = [];

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    get animating() {
      return mode === "ticker" && ticker.animating;
    },
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // A Claude Code session keeps the ticker; every other pill shows its own
      // card, exactly like IntegrationCardView.
      if (isSession(task)) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.source === "codex" ? "Codex" : "Claude Code" }),
        );
        // `steps` is capped at 20, so "n/total" read 20/20 forever.
        if (task.stepCount > 1) {
          who.append(h("span", { class: "count", text: `${task.stepCount} steps` }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const others = State.otherTasks;
      // No integration and no other session: an empty card on the right is just
      // noise, so the focused card takes the whole width instead.
      el.classList.toggle("solo", others.length === 0);

      const sessions = others.filter(isSession);
      const integrations = others.filter((t) => !isSession(t)).slice(0, 4);
      const badges = (list: AgentTask[]) => list.map((t) => `${t.id}:${t.pillBadge ?? ""}`);

      if (sessions.length === 0) {
        const pillKey = ["pills", ...badges(integrations)].join("|");
        if (pillKey !== pillIds) {
          pillIds = pillKey;
          bubbles = [];
          clear(right);
          right.append(pills);
          clear(pills);
          for (const t of integrations) pills.append(buildPill(t, actions));
          pruneMiniBots();
        }
        return;
      }

      // Other sessions are at work: each is its own Mochi and they talk to each
      // other — a speech bubble apiece saying what it is doing, alternating sides.
      const max = integrations.length ? MAX_BUBBLES_WITH_CHIPS : MAX_BUBBLES;
      const shown = sessions.slice(0, max);
      const hidden = sessions.length - shown.length;
      const convoKey = ["convo", ...badges(shown), hidden, ...badges(integrations)].join("|");
      if (convoKey !== pillIds) {
        pillIds = convoKey;
        clear(right);
        const convo = h("div", { class: "convo" });
        bubbles = shown.map((t, i) => {
          const built = buildBubble(t, i % 2 === 1, actions);
          convo.append(built.el);
          return { task: t, text: built.text };
        });
        if (integrations.length || hidden > 0) {
          const chips = h("div", { class: "chips" });
          for (const t of integrations) chips.append(buildChip(t, actions));
          if (hidden > 0) chips.append(h("span", { class: "chip-more", text: `+${hidden}` }));
          convo.append(chips);
        }
        right.append(convo);
        pruneMiniBots();
      }
      for (const b of bubbles) {
        const text = statusText(b.task);
        if (b.text.textContent !== text) b.text.textContent = text;
        b.text.classList.toggle("shimmer", isBusy(b.task));
        b.text.style.color = statusColor(b.task) ?? "";
      }
    },
  };
}

/** The badge in the corner of a pill, bubble or chip. */
function badge(task: AgentTask): HTMLElement | null {
  if (!task.pillBadge) return null;
  const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
  const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
  const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
  const el = h("div", { class: "pill-badge" }, inner);
  el.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
  return el;
}

/** Another session as a mini Mochi saying what it is up to. */
function buildBubble(
  task: AgentTask,
  flipped: boolean,
  actions: ViewActions,
): { el: HTMLElement; text: HTMLElement } {
  const text = h("span", { class: "say-text" });
  const bubble = h("div", { class: "bubble" }, h("b", { text: task.name }), text, badge(task));
  bubble.style.setProperty("--c", task.color);
  const el = h(
    "div",
    { class: flipped ? "say flip" : "say", title: task.name, onclick: () => actions.setFocus(task.id) },
    createMiniBot(task, 20),
    bubble,
  );
  return { el, text };
}

/** An integration squeezed down to its Mochi, under the conversation. */
function buildChip(task: AgentTask, actions: ViewActions): HTMLElement {
  const chip = h(
    "div",
    { class: "chip", title: task.name, onclick: () => actions.setFocus(task.id) },
    createMiniBot(task, 14),
    badge(task),
  );
  chip.style.borderColor = `${task.color}40`;
  return chip;
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === CLAUDE_ID ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  const b = badge(task);
  if (b) pill.append(b);
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      // The session that asked, not whichever one has the focus: you can wander
      // off to another session's bubble and come back while the card is up.
      who.append(agentWho(requester(), "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

/** The session behind the pending request. */
function requester(): AgentTask | null {
  const req = State.pendingApproval;
  return (req && State.sessionTask(req.sessionId)) ?? State.focusTask;
}

// ── Ask (AskUserQuestion) ─────────────────────────────────────────────────────

/**
 * Claude asking the user to choose. This arrives as a PermissionRequest, but
 * Allow / Deny would be nonsense here: Allow answered nothing and Claude carried
 * on without an answer. The card shows the question and its options instead;
 * one click on an option is the answer.
 */
function buildAsk(actions: ViewActions): ViewHost {
  const who = h("div");
  const head = h("div", { class: "ask-head" });
  const title = h("div", { class: "ask-q" });
  const options = h("div", { class: "ask-options" });
  const hint = h("span", { class: "ask-hint" });
  const terminal = h("button", {
    class: "link-btn ask-terminal",
    text: "Answer in terminal",
    onclick: () => actions.answerInTerminal(),
  });
  const footer = h("div", { class: "ask-footer" }, hint, terminal);
  const el = h("div", { class: "view" },
    card("cyan", stack(116, 16, who, head, title, options, footer)));

  let reqId = "";
  let index = 0;
  let choices: number[][] = [];
  let builtKey = "";

  const advance = () => {
    const qs = State.pendingApproval?.questions ?? [];
    if (index + 1 < qs.length) {
      index += 1;
      State.notify();
    } else {
      actions.answer(choices);
    }
  };

  return {
    el,
    sync() {
      const req = State.pendingApproval;
      const qs = req?.questions;
      if (!req || !qs) return;
      if (req.requestId !== reqId) {
        reqId = req.requestId;
        index = 0;
        choices = qs.map(() => []);
        builtKey = "";
      }
      const q = qs[index];
      const picked = choices[index];

      clear(who);
      const step = qs.length > 1 ? ` · ${index + 1}/${qs.length}` : "";
      who.append(agentWho(requester(), `is asking${step}`));

      // Only rebuilt when something really changed: replacing a button between
      // mouse-down and mouse-up would swallow the click.
      const key = `${reqId}|${index}|${picked.join(",")}`;
      if (key === builtKey) return;
      builtKey = key;

      head.textContent = q.header ?? "";
      head.style.display = q.header ? "" : "none";
      title.textContent = q.question;
      title.title = q.question;
      hint.textContent = q.multiSelect ? "Pick one or more" : "";

      clear(options);
      q.options.forEach((opt, i) => {
        const on = picked.includes(i);
        const b = h(
          "button",
          {
            class: on ? "ask-opt on" : "ask-opt",
            title: opt.description ?? opt.label,
            onclick: () => {
              if (q.multiSelect) {
                choices[index] = on ? picked.filter((x) => x !== i) : [...picked, i].sort((a, z) => a - z);
                State.notify();
              } else {
                choices[index] = [i];
                advance();
              }
            },
          },
          h("span", { text: opt.label }),
        );
        // The description is what tells two options apart; show it on hover.
        b.addEventListener("mouseenter", () => (hint.textContent = opt.description ?? ""));
        b.addEventListener("mouseleave", () => (hint.textContent = q.multiSelect ? "Pick one or more" : ""));
        options.append(b);
      });
      if (q.multiSelect) {
        const last = index + 1 >= qs.length;
        const send = btn(last ? "Send" : "Next", "primary", () => {
          if (choices[index].length > 0) advance();
        });
        send.classList.toggle("disabled", picked.length === 0);
        options.append(send);
      }
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code is asking a question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Coucou can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.alertTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : task?.source === "codex" ? "Codex" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      // The session that finished — which need not be the focused one.
      const task = State.alertTask;
      clear(who);
      who.append(agentWho(task, task?.source === "codex" ? "Codex finished" : "Claude Code finished"));
      title.textContent = task?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  // 0 = off: the island is never hidden by the timer.
  const AUTO_CLOSE_CHOICES = [0, 10, 15, 30];
  const segButtons = AUTO_CLOSE_CHOICES.map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, s === 0 ? "Off" : `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent =
        s.autoCloseInterval > 0 ? `Auto-close · ${Math.round(s.autoCloseInterval)}s` : "Auto-close · off";
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === AUTO_CLOSE_CHOICES[i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("ask", buildAsk(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
