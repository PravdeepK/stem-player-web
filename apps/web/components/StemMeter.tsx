import type { MixerHandle } from "@stem-player-web/core";
import type { MeterStyle } from "./Mixer";

export interface StemMeterProps {
  mixer: MixerHandle;
  style: Exclude<MeterStyle, "off">;
}

export default function StemMeter(_props: StemMeterProps) {
  return null;
}
