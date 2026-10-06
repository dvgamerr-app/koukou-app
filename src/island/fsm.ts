// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.

export type FsmState = "hidden" | "petit" | "home" | "koukou";

/** How often a held compact island looks again for everything going idle. */
const PETIT_RECHECK_MS = 5000;

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /** home → petit delay, seconds. 0 turns auto-close off. */
  homeToPetitDelay = 15;
  /** petit → hidden delay, seconds. */
  petitToHiddenDelay = 60;
  /** koukou → petit once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** koukou → petit while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;
  /** false = the compact island never hides; it stays on screen as a mini bar. */
  autoHide = true;
  /**
   * True while there is still something worth watching (a session at work, a
   * question waiting). The compact island doesn't hide until it turns false.
   */
  holdPetit: () => boolean = () => false;

  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("koukou");
  }

  mouseEntered() {
    switch (this.state) {
      case "hidden":
        this.cancelTimers();
        this.transition("petit");
        break;
      case "petit":
        this.clear("petitHide");
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "koukou":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  mouseLeft() {
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "home":
        this.scheduleHomeCollapse();
        break;
      case "koukou":
        this.clear("greetCollapse");
        this.transition("petit");
        break;
    }
  }

  click() {
    if (this.state !== "petit") return;
    this.cancelTimers();
    this.transition("home");
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "koukou") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
    this.schedulePetitHide();
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  /** Applies the auto-hide setting: off keeps the island up, on lets it time out. */
  setAutoHide(on: boolean) {
    this.autoHide = on;
    if (!on) {
      this.clear("petitHide");
      if (this.state === "hidden") this.transition("petit");
    } else if (this.state === "petit") {
      this.schedulePetitHide();
    }
  }

  private schedulePetitHide() {
    this.clear("petitHide");
    if (!this.autoHide) return;
    const attempt = () => {
      this.petitHide = null;
      if (this.state !== "petit") return;
      // Sessions still working: stay, and look again shortly. Once the last one
      // goes idle the island hides within one recheck.
      if (this.holdPetit()) {
        this.petitHide = window.setTimeout(attempt, PETIT_RECHECK_MS);
        return;
      }
      this.transition("hidden");
    };
    this.petitHide = window.setTimeout(attempt, this.petitToHiddenDelay * 1000);
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    // 0 = auto-close off: the island stays open until closed by hand.
    if (this.pinned || this.homeToPetitDelay <= 0) return;
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      if (this.state === "home") this.transition("petit");
    }, this.homeToPetitDelay * 1000);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "koukou") this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "petitHide" | "homeCollapse" | "greetCollapse") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
  }

  cancelTimers() {
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
