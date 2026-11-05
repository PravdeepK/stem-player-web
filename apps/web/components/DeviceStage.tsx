import type { MixerHandle, StemName } from "@stem-player-web/core";

export interface DeviceStageProps {
  mixer: MixerHandle;
  busy: boolean;
  applyVolume: (name: StemName, volume: number) => void;
  onLoadPress: () => void;
  // Called once if WebGL or the model fails, so the page can show the fallback controls.
  onUnavailable: () => void;
}

export default function DeviceStage(_props: DeviceStageProps) {
  return null;
}
