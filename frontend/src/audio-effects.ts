import type { AppStatus, AudioEffectMode } from "./types";

export const AUDIO_EFFECT_OPTIONS: Array<{ id: AudioEffectMode; label: string }> = [
  { id: "wave", label: "WAVE" },
  { id: "border-pulse", label: "BORDER PULSE" },
];

export function resolveAppShellAudioEffectClass(
  status: AppStatus,
  audioEffect: AudioEffectMode,
): string {
  if (status !== "playing") {
    return "";
  }

  return audioEffect === "border-pulse" ? "app-shell-effect-border" : "app-shell-effect-wave";
}
