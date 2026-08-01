import {
  AudioVoicePolicy,
  type AudioCue,
  type AudioCueDefinition,
} from "./audio-policy";

export interface AudioFrame {
  readonly elapsedRealS: number;
  readonly warningActive: boolean;
}

export interface AudioService {
  readonly muted: boolean;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  setMuted(muted: boolean): void;
  play(cue: AudioCue): void;
  update(frame: Readonly<AudioFrame>): void;
  destroy(): void;
}

export class WebAudioService implements AudioService {
  readonly #createContext: () => AudioContext;
  readonly #voicePolicy: AudioVoicePolicy;

  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #ambience: OscillatorNode[] = [];
  #muted = false;
  #destroyed = false;
  #lastBreathCycle = -1;
  #lastBubbleCycle = -1;

  constructor(
    createContext: () => AudioContext = () => new AudioContext(),
    voicePolicy = new AudioVoicePolicy(),
  ) {
    this.#createContext = createContext;
    this.#voicePolicy = voicePolicy;
  }

  get muted(): boolean {
    return this.#muted;
  }

  async resume(): Promise<void> {
    if (this.#destroyed || this.#muted) {
      return;
    }
    const context = this.#ensureContext();
    if (context.state === "suspended") {
      await context.resume();
    }
  }

  async suspend(): Promise<void> {
    if (this.#context?.state === "running") {
      await this.#context.suspend();
    }
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (this.#master && this.#context) {
      this.#master.gain.setTargetAtTime(
        muted ? 0 : 1,
        this.#context.currentTime,
        0.015,
      );
    }
    if (!muted) {
      void this.resume().catch((error: unknown) => console.error(error));
    }
  }

  play(cue: AudioCue): void {
    if (this.#muted || this.#destroyed) {
      return;
    }
    const context = this.#ensureContext();
    if (context.state !== "running") {
      return;
    }
    const definition = this.#voicePolicy.acquire(cue, performance.now());
    if (!definition) {
      return;
    }
    this.#playOscillator(context, definition);
  }

  update(frame: Readonly<AudioFrame>): void {
    if (this.#muted || this.#destroyed) {
      return;
    }
    const breathCycle = Math.floor(frame.elapsedRealS / 4.5);
    const cyclePhase = frame.elapsedRealS - breathCycle * 4.5;
    if (breathCycle !== this.#lastBreathCycle) {
      this.#lastBreathCycle = breathCycle;
      this.play("environment.breath");
    }
    if (cyclePhase >= 2.1 && breathCycle !== this.#lastBubbleCycle) {
      this.#lastBubbleCycle = breathCycle;
      this.play("environment.bubbles");
    }
    if (frame.warningActive) {
      this.play("alert.warning");
    }
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    for (const source of this.#ambience) {
      source.stop();
    }
    this.#ambience = [];
    const context = this.#context;
    this.#context = null;
    this.#master = null;
    if (context) {
      void context.close().catch((error: unknown) => console.error(error));
    }
  }

  #ensureContext(): AudioContext {
    if (this.#context && this.#master) {
      return this.#context;
    }
    const context = this.#createContext();
    const master = context.createGain();
    master.gain.value = this.#muted ? 0 : 1;
    master.connect(context.destination);
    this.#context = context;
    this.#master = master;
    this.#startAmbience(context, master);
    return context;
  }

  #startAmbience(context: AudioContext, destination: AudioNode): void {
    for (const [frequencyHz, gainValue] of [
      [48, 0.012],
      [73, 0.007],
    ] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequencyHz;
      gain.gain.value = gainValue;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      this.#ambience.push(oscillator);
    }
  }

  #playOscillator(
    context: AudioContext,
    definition: Readonly<AudioCueDefinition>,
  ): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startsAt = context.currentTime;
    const endsAt = startsAt + definition.durationMs / 1_000;
    oscillator.type = definition.waveform;
    oscillator.frequency.setValueAtTime(definition.frequencyHz, startsAt);
    oscillator.frequency.exponentialRampToValueAtTime(
      definition.endFrequencyHz,
      endsAt,
    );
    gain.gain.setValueAtTime(definition.gain, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
    oscillator.connect(gain).connect(this.#master!);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        gain.disconnect();
        this.#voicePolicy.release();
      },
      { once: true },
    );
    oscillator.start(startsAt);
    oscillator.stop(endsAt);
  }
}
