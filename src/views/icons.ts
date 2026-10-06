import {
  House, MessageCircle, Plus, Settings, Volume2, VolumeX, ArrowUpRight,
  ChevronRight, ChevronLeft, Check, ArrowUp, CircleAlert, X, Timer,
  Ellipsis, Star, Layers, FileText, Minus,
} from "lucide";

export const ICONS = {
  house: House, bubble: MessageCircle, plus: Plus, gear: Settings,
  gearFill: Settings, speakerOn: Volume2, speakerOff: VolumeX,
  arrowUpRight: ArrowUpRight, chevronRight: ChevronRight,
  chevronLeft: ChevronLeft, check: Check, arrowUp: ArrowUp,
  bang: CircleAlert, xmark: X, timer: Timer, ellipsis: Ellipsis,
  star: Star, stack: Layers, doc: FileText, minus: Minus,
} as const;
