import type { MixerHandle, StemName, StemSetting } from "@stem-player-web/core";

export interface StemRowProps {
  name: StemName;
  buffer: AudioBuffer;
  settings: StemSetting & { anySolo: boolean };
  duration: number;
  onVolume: (name: StemName, volume: number) => void;
  onMute: (name: StemName, muted: boolean) => void;
  onSolo: (name: StemName, solo: boolean) => void;
  onSeek: (time: number) => void;
  onPreview: (time: number) => void;
  registerTime: MixerHandle["onTime"];
  onLevels: MixerHandle["onLevels"];
  // True while the menu is open, which is when the row bounces with the stem's level.
  active: boolean;
}

export default function StemRow(_props: StemRowProps) {
  return null;
}
