export type AudioCue =
  | "alert.warning"
  | "info.better-gas"
  | "info.deco-stop-changed"
  | "environment.breath"
  | "environment.bubbles";

export interface AudioCueDefinition {
  readonly waveform: OscillatorType;
  readonly frequencyHz: number;
  readonly endFrequencyHz: number;
  readonly durationMs: number;
  readonly gain: number;
  readonly throttleMs: number;
  readonly priority: number;
}

export const AUDIO_CUES: Readonly<Record<AudioCue, AudioCueDefinition>> =
  Object.freeze({
    "alert.warning": Object.freeze({
      waveform: "square",
      frequencyHz: 800,
      endFrequencyHz: 800,
      durationMs: 300,
      gain: 0.15,
      throttleMs: 5_000,
      priority: 100,
    }),
    "info.better-gas": Object.freeze({
      waveform: "sine",
      frequencyHz: 600,
      endFrequencyHz: 600,
      durationMs: 150,
      gain: 0.15,
      throttleMs: 0,
      priority: 60,
    }),
    "info.deco-stop-changed": Object.freeze({
      waveform: "sine",
      frequencyHz: 600,
      endFrequencyHz: 600,
      durationMs: 150,
      gain: 0.15,
      throttleMs: 0,
      priority: 60,
    }),
    "environment.breath": Object.freeze({
      waveform: "sine",
      frequencyHz: 170,
      endFrequencyHz: 105,
      durationMs: 820,
      gain: 0.035,
      throttleMs: 1_500,
      priority: 10,
    }),
    "environment.bubbles": Object.freeze({
      waveform: "sine",
      frequencyHz: 420,
      endFrequencyHz: 760,
      durationMs: 260,
      gain: 0.026,
      throttleMs: 900,
      priority: 10,
    }),
  });

export class AudioVoicePolicy {
  readonly #maximumVoices: number;
  readonly #lastPlayedAtMs = new Map<AudioCue, number>();
  #activeVoices = 0;

  constructor(maximumVoices = 8) {
    if (!Number.isInteger(maximumVoices) || maximumVoices <= 0) {
      throw new RangeError("maximum audio voices must be a positive integer");
    }
    this.#maximumVoices = maximumVoices;
  }

  get activeVoices(): number {
    return this.#activeVoices;
  }

  acquire(cue: AudioCue, nowMs: number): AudioCueDefinition | null {
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new RangeError("audio timestamp must be finite and non-negative");
    }
    const definition = AUDIO_CUES[cue];
    const lastPlayedAtMs = this.#lastPlayedAtMs.get(cue);
    if (
      lastPlayedAtMs !== undefined &&
      nowMs - lastPlayedAtMs < definition.throttleMs
    ) {
      return null;
    }
    if (this.#activeVoices >= this.#maximumVoices) {
      return null;
    }

    this.#lastPlayedAtMs.set(cue, nowMs);
    this.#activeVoices += 1;
    return definition;
  }

  release(): void {
    this.#activeVoices = Math.max(0, this.#activeVoices - 1);
  }
}
