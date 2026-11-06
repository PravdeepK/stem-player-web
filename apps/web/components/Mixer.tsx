import type { ReactNode } from "react";
import type { FeedbackType, MixerHandle } from "@stem-player-web/core";

export type MeterStyle = "dots" | "wave" | "off";

export interface MixerProps {
  mixer: MixerHandle;
  title: string;
  // What's happening right now ("Loading stems…"), or "" when idle.
  activity: string;
  menu: ReactNode;
  stemsActions: ReactNode;
  meterStyle: MeterStyle;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onMenuOpen: () => void;
  onMenuClose: () => void;
  onFeedback: (type: FeedbackType) => void;
}

export default function Mixer(_props: MixerProps) {
  return null;
}
