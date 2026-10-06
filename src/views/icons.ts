import type { IconNode } from "lucide";
import {
  House, MessageCircle, Plus, Settings, Volume2, VolumeX, ArrowUpRight,
  ChevronRight, ChevronLeft, Check, ArrowUp, CircleAlert, X, Timer,
  Ellipsis, Star, Layers, FileText, Minus,
} from "lucide";

/** Provider marks, drawn as strokes like the lucide set. */
const ClaudeMark: IconNode = [
  ["path", { d: "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" }],
];
const CodexMark: IconNode = [
  ["rect", { x: "3", y: "4", width: "18", height: "16", rx: "4" }],
  ["path", { d: "m8 10 3 2-3 2M13 15h3" }],
];

export const ICONS = {
  house: House, bubble: MessageCircle, plus: Plus, gear: Settings,
  gearFill: Settings, speakerOn: Volume2, speakerOff: VolumeX,
  arrowUpRight: ArrowUpRight, chevronRight: ChevronRight,
  chevronLeft: ChevronLeft, check: Check, arrowUp: ArrowUp,
  bang: CircleAlert, xmark: X, timer: Timer, ellipsis: Ellipsis,
  claude: ClaudeMark, codex: CodexMark, star: Star, stack: Layers, doc: FileText, minus: Minus,
} as const;
