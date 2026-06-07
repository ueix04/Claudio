import { describe, expect, it } from "vitest";
import { resolveAppShellAudioEffectClass } from "./audio-effects";

describe("audio effects", () => {
  it("keeps the current wave effect as the default playing state", () => {
    expect(resolveAppShellAudioEffectClass("playing", "wave")).toBe("app-shell-effect-wave");
  });

  it("switches to border pulse effect when requested", () => {
    expect(resolveAppShellAudioEffectClass("playing", "border-pulse")).toBe("app-shell-effect-border");
  });

  it("disables shell effects when music is not playing", () => {
    expect(resolveAppShellAudioEffectClass("idle", "wave")).toBe("");
    expect(resolveAppShellAudioEffectClass("speaking", "border-pulse")).toBe("");
  });
});
