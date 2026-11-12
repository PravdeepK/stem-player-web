import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { TOUCH_LIMITS, createMixer, type MixerHandle } from "@stem-player-web/core";
import { stemApi } from "../lib/stemApi";

// iOS puts Web Audio in the "ambient" audio session, which the ring/silent
// switch mutes. "playback" is the session a music app uses, and it has to be
// chosen before the context starts. Safari 16.4 is the first with
// navigator.audioSession and also the oldest browser the site builds for;
// elsewhere the property doesn't exist and there's no switch to get around.
type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

function createContext() {
  const { audioSession } = navigator as AudioSessionNavigator;
  if (audioSession) audioSession.type = "playback";
  return new AudioContext();
}

// The memory limit is for phones and tablets, whose browsers kill a tab long
// before a laptop runs short. A touchscreen laptop still reports a fine
// primary pointer, so it plays long songs in stereo like any other laptop.
const isTouchDevice = () => matchMedia("(pointer: coarse)").matches;

export function useAudioMixer(): MixerHandle {
  const [mixer] = useState(() =>
    createMixer({
      createContext,
      readStem: (source) => stemApi.readStem(source),
      frames: {
        request: (callback) => requestAnimationFrame(callback),
        cancel: (id) => cancelAnimationFrame(id),
      },
      limits: () => (isTouchDevice() ? TOUCH_LIMITS : null),
    }),
  );

  const state = useSyncExternalStore(mixer.subscribe, mixer.getState, mixer.getState);

  useEffect(() => () => mixer.dispose(), [mixer]);

  return useMemo(() => {
    const { getState: _getState, subscribe: _subscribe, dispose: _dispose, ...controls } = mixer;
    return { ...state, ...controls };
  }, [mixer, state]);
}
