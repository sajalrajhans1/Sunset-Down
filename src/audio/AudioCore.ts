/**
 * Web Audio foundation.
 *
 * The game ships zero audio files — every sound is synthesised at runtime from
 * oscillators and noise buffers. This keeps the download at zero bytes of audio
 * and lets sounds respond to gameplay (pitch varies per shot, growls detune per
 * zombie, music reharmonises with wave intensity).
 *
 * Signal graph:
 *
 *   sources ──┬─► dry ─────────────────────┐
 *             └─► reverbSend ─► convolver ─┤
 *                                          ├─► busGain ─► master ─► limiter ─► out
 *   music  ─────────────────────────────────┘
 */

export type Bus = 'sfx' | 'music';

export class AudioCore {
  readonly context: AudioContext;

  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly sfxBus: GainNode;
  readonly musicBus: GainNode;
  readonly reverbSend: GainNode;

  private readonly convolver: ConvolverNode;
  private noiseBuffer: AudioBuffer | null = null;
  private unlocked = false;
  private suspendedByPage = false;

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = new Ctor({ latencyHint: 'interactive' });

    // A gentle limiter stops a wave of simultaneous gunshots and explosions
    // from clipping into distortion.
    this.limiter = this.context.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.16;
    this.limiter.connect(this.context.destination);

    this.master = this.context.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.limiter);

    this.sfxBus = this.context.createGain();
    this.sfxBus.gain.value = 0.8;
    this.sfxBus.connect(this.master);

    this.musicBus = this.context.createGain();
    this.musicBus.gain.value = 0.55;
    this.musicBus.connect(this.master);

    // Short, bright reverb: an open village square, not a cathedral.
    this.convolver = this.context.createConvolver();
    this.convolver.buffer = this.createImpulseResponse(1.35, 2.6);
    const reverbReturn = this.context.createGain();
    reverbReturn.gain.value = 0.5;
    this.convolver.connect(reverbReturn);
    reverbReturn.connect(this.sfxBus);

    this.reverbSend = this.context.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(this.convolver);

    this.setupAutoResume();
  }

  /**
   * Browsers block audio until a user gesture. We attach one-shot listeners and
   * resume on the first interaction of any kind.
   */
  private setupAutoResume(): void {
    const unlock = (): void => {
      if (this.unlocked) return;
      void this.context.resume().then(() => {
        this.unlocked = this.context.state === 'running';
      });
    };
    for (const event of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(event, unlock, { passive: true });
    }

    // Mute while the tab is hidden so the game doesn't play to an empty room.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.suspendedByPage = true;
        void this.context.suspend();
      } else if (this.suspendedByPage) {
        this.suspendedByPage = false;
        void this.context.resume();
      }
    });
  }

  async resume(): Promise<void> {
    if (this.context.state !== 'running') {
      await this.context.resume().catch(() => undefined);
    }
    this.unlocked = this.context.state === 'running';
  }

  get isRunning(): boolean {
    return this.context.state === 'running';
  }

  get now(): number {
    return this.context.currentTime;
  }

  setBusVolume(bus: Bus, volume: number): void {
    const target = bus === 'sfx' ? this.sfxBus : this.musicBus;
    // Perceptual curve: linear slider values sound wrong, squared feels right.
    const shaped = Math.max(0, Math.min(1, volume)) ** 1.6;
    target.gain.setTargetAtTime(shaped, this.now, 0.05);
  }

  // -------------------------------------------------------------------------
  // Building blocks
  // -------------------------------------------------------------------------

  /** Cached 2-second white noise buffer, the source of all percussive sounds. */
  getNoiseBuffer(): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = this.context.sampleRate * 2;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  /**
   * Synthesises a reverb impulse: exponentially decaying stereo noise with a
   * slight high-frequency roll-off, which is a convincing cheap room.
   */
  private createImpulseResponse(duration: number, decay: number): AudioBuffer {
    const rate = this.context.sampleRate;
    const length = Math.floor(rate * duration);
    const impulse = this.context.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      let lowpassState = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const envelope = Math.pow(1 - t, decay);
        const noise = (Math.random() * 2 - 1) * envelope;
        // One-pole lowpass darkens the tail over time.
        lowpassState += (noise - lowpassState) * (0.35 - t * 0.25);
        data[i] = lowpassState;
      }
    }
    return impulse;
  }

  createNoiseSource(playbackRate = 1): AudioBufferSourceNode {
    const source = this.context.createBufferSource();
    source.buffer = this.getNoiseBuffer();
    source.playbackRate.value = playbackRate;
    // Random offset so repeated shots never sound like a loop.
    source.loop = true;
    return source;
  }

  createOscillator(type: OscillatorType, frequency: number): OscillatorNode {
    const osc = this.context.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency;
    return osc;
  }

  createGain(value = 0): GainNode {
    const gain = this.context.createGain();
    gain.gain.value = value;
    return gain;
  }

  createFilter(type: BiquadFilterType, frequency: number, q = 1): BiquadFilterNode {
    const filter = this.context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    return filter;
  }

  /** Waveshaper curve for soft saturation — adds bite without harshness. */
  createDistortion(amount: number): WaveShaperNode {
    const shaper = this.context.createWaveShaper();
    const samples = 1024;
    const curve = new Float32Array(samples);
    const k = amount * 40;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((3 + k) * x * 20 * Math.PI) / (Math.PI + k * Math.abs(x));
      curve[i] = Math.tanh(curve[i] * 0.02);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    return shaper;
  }

  /**
   * Positional playback. A full PannerNode per source is expensive with dozens
   * of zombies, so we compute stereo pan and distance attenuation ourselves.
   */
  createPositionalOutput(
    listenerPos: { x: number; z: number },
    listenerForward: { x: number; z: number },
    sourcePos: { x: number; y: number; z: number },
    maxDistance = 55,
  ): { input: GainNode; audible: boolean } {
    const dx = sourcePos.x - listenerPos.x;
    const dz = sourcePos.z - listenerPos.z;
    const distance = Math.hypot(dx, dz);

    const gain = this.createGain(0);
    if (distance > maxDistance) {
      return { input: gain, audible: false };
    }

    // Inverse-ish falloff with a soft near field.
    const attenuation = 1 / (1 + (distance / 6) ** 1.35);
    gain.gain.value = attenuation;

    // Right vector = forward rotated -90 degrees around Y.
    const rightX = -listenerForward.z;
    const rightZ = listenerForward.x;
    const lateral = distance > 0.01 ? (dx * rightX + dz * rightZ) / distance : 0;

    const panner = this.context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, lateral * 0.85));

    // Distant sounds lose their highs — cheap but effective air absorption.
    const airFilter = this.createFilter('lowpass', Math.max(900, 18000 - distance * 260), 0.7);

    gain.connect(airFilter);
    airFilter.connect(panner);
    panner.connect(this.sfxBus);

    // Distant sounds get proportionally more reverb.
    const send = this.createGain(Math.min(0.45, distance / maxDistance) * 0.6);
    panner.connect(send);
    send.connect(this.reverbSend);

    return { input: gain, audible: true };
  }

  /** Schedules cleanup so finished nodes are released promptly. */
  disposeAfter(node: AudioScheduledSourceNode, seconds: number): void {
    node.stop(this.now + seconds);
    node.onended = () => node.disconnect();
  }
}
