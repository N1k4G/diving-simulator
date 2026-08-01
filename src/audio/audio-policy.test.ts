import { describe, expect, it } from "vitest";

import { AUDIO_CUES, AudioVoicePolicy } from "./audio-policy";

describe("AudioVoicePolicy", () => {
  it("preserves the legacy warning and information tone definitions", () => {
    expect(AUDIO_CUES["alert.warning"]).toMatchObject({
      waveform: "square",
      frequencyHz: 800,
      durationMs: 300,
      gain: 0.15,
      throttleMs: 5_000,
    });
    expect(AUDIO_CUES["info.better-gas"]).toMatchObject({
      waveform: "sine",
      frequencyHz: 600,
      durationMs: 150,
      gain: 0.15,
    });
  });

  it("throttles repeated warnings and caps simultaneous voices", () => {
    const policy = new AudioVoicePolicy(2);

    expect(policy.acquire("alert.warning", 0)).not.toBeNull();
    expect(policy.acquire("alert.warning", 4_999)).toBeNull();
    expect(policy.acquire("environment.breath", 1)).not.toBeNull();
    expect(policy.acquire("environment.bubbles", 1)).toBeNull();
    expect(policy.activeVoices).toBe(2);

    policy.release();
    expect(policy.acquire("alert.warning", 5_000)).not.toBeNull();
  });

  it("never underflows its active voice count", () => {
    const policy = new AudioVoicePolicy();
    policy.release();
    expect(policy.activeVoices).toBe(0);
  });
});
