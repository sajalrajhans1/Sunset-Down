import type { AudioCore } from './AudioCore';
import { clamp01 } from '../utilities/MathUtils';

/**
 * Generative adaptive soundtrack.
 *
 * There is no music file. The score is composed live from a chord progression
 * and eight instrument voices whose density, register, brightness and volume
 * are driven by a single `intensity` value the game feeds it.
 *
 * Musical design notes:
 *  • **Harmony** is a real ii–V–i-flavoured progression in natural minor with
 *    added 7ths and 9ths, not a static loop of triads. Chords last two bars at
 *    low intensity and one bar when things get hot, so the harmonic rhythm
 *    itself accelerates with danger.
 *  • **Voice leading** picks the chord tone nearest the previous note rather
 *    than always playing root position, which is what stops arpeggios sounding
 *    like an arpeggiator.
 *  • **The melody** is a constrained random walk on the pentatonic scale with
 *    rests and repeated motifs, so it reads as a tune rather than noodling.
 *  • **Swing** is applied to off-beat 16ths, which is most of what separates
 *    "programmed" from "played".
 *
 * Scheduling uses the standard two-clock pattern: a coarse `setInterval` looks
 * ahead and queues notes onto the sample-accurate Web Audio clock, so timing
 * never drifts even when the render loop stutters.
 */

type Track = 'menu' | 'gameplay' | 'none';

interface Voice {
  input: GainNode;
  gain: GainNode;
  filter: BiquadFilterNode;
}

interface Chord {
  /** Semitone offset of the chord root from the key's tonic. */
  root: number;
  /** Chord tones as semitone offsets above the chord root. */
  tones: number[];
  /** Scale degrees available to the melody over this chord. */
  color: number[];
}

/** Warm, wistful, unhurried — the fair at golden hour. */
const MENU_PROGRESSION: Chord[] = [
  { root: 0, tones: [0, 4, 7, 11], color: [0, 2, 4, 7, 11] }, // Imaj7
  { root: 5, tones: [0, 4, 7, 11], color: [0, 2, 4, 7, 9] }, // IVmaj7
  { root: 9, tones: [0, 3, 7, 10], color: [0, 3, 5, 7, 10] }, // vi7
  { root: 7, tones: [0, 4, 7, 9], color: [0, 2, 4, 7, 9] }, // V6
];

/** Darker and more driven, but still tuneful — this is a siege, not a funeral. */
const GAMEPLAY_PROGRESSION: Chord[] = [
  { root: 0, tones: [0, 3, 7, 10], color: [0, 3, 5, 7, 10] }, // i7
  { root: 8, tones: [0, 4, 7, 11], color: [0, 2, 4, 7, 11] }, // VImaj7
  { root: 5, tones: [0, 3, 7, 10], color: [0, 3, 5, 7, 10] }, // iv7
  { root: 7, tones: [0, 4, 7, 10], color: [0, 1, 4, 7, 10] }, // V7 (leading tone)
];

/** Minor pentatonic — every note lands regardless of the chord underneath. */
const PENTATONIC = [0, 3, 5, 7, 10];

export class MusicEngine {
  private readonly core: AudioCore;

  private readonly pad: Voice;
  private readonly bass: Voice;
  private readonly arp: Voice;
  private readonly lead: Voice;
  private readonly bell: Voice;
  private readonly drums: Voice;

  /** Shared plate reverb for the musical voices, separate from the SFX send. */
  private musicReverb!: ConvolverNode;
  private musicReverbGain!: GainNode;

  private track: Track = 'none';
  private timer: number | null = null;

  private bpm = 92;
  private step = 0;
  private nextStepTime = 0;
  private intensity = 0;
  private targetIntensity = 0;

  /** Tonic frequency of the current key. */
  private rootFrequency = 130.81;

  /** Last melody note, so the walk can move by step rather than leaping. */
  private lastMelodyDegree = 0;
  /** Remembered two-bar motif, repeated for cohesion. */
  private motif: number[] = [];

  private static readonly LOOKAHEAD_MS = 25;
  private static readonly SCHEDULE_AHEAD = 0.16;
  private static readonly STEPS_PER_LOOP = 128; // eight bars of 16ths

  constructor(core: AudioCore) {
    this.core = core;
    this.buildReverb();

    // Each voice gets its own filter + gain, and its own reverb send depth.
    this.pad = this.createVoice('lowpass', 1400, 0.55);
    this.bass = this.createVoice('lowpass', 900, 0.08);
    this.arp = this.createVoice('lowpass', 2600, 0.4);
    this.lead = this.createVoice('lowpass', 3200, 0.45);
    this.bell = this.createVoice('highpass', 500, 0.7);
    this.drums = this.createVoice('highpass', 40, 0.12);
  }

  /** Long, soft plate — music sits in a bigger space than the sound effects. */
  private buildReverb(): void {
    const { context } = this.core;
    const duration = 2.8;
    const rate = context.sampleRate;
    const length = Math.floor(rate * duration);
    const impulse = context.createBuffer(2, length, rate);

    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      let lowpass = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        // Slow attack then long exponential tail reads as a plate rather than
        // a room, which suits sustained pads far better.
        const envelope = Math.pow(1 - t, 2.6) * Math.min(1, t * 24);
        const noise = (Math.random() * 2 - 1) * envelope;
        lowpass += (noise - lowpass) * 0.28;
        data[i] = lowpass;
      }
    }

    this.musicReverb = context.createConvolver();
    this.musicReverb.buffer = impulse;
    this.musicReverbGain = this.core.createGain(0.85);
    this.musicReverb.connect(this.musicReverbGain);
    this.musicReverbGain.connect(this.core.musicBus);
  }

  private createVoice(filterType: BiquadFilterType, frequency: number, reverbSend: number): Voice {
    const input = this.core.createGain(1);
    const filter = this.core.createFilter(filterType, frequency, 0.9);
    const gain = this.core.createGain(0);

    input.connect(filter);
    filter.connect(gain);
    gain.connect(this.core.musicBus);

    const send = this.core.createGain(reverbSend);
    gain.connect(send);
    send.connect(this.musicReverb);

    return { input, gain, filter };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  playMenu(): void {
    if (this.track === 'menu') return;
    this.track = 'menu';
    this.bpm = 84;
    this.rootFrequency = 146.83; // D
    this.motif = [];
    this.setLevels({ pad: 0.34, bass: 0.2, arp: 0.15, lead: 0.11, bell: 0.13, drums: 0 }, 2.0);
    this.start();
  }

  playGameplay(): void {
    if (this.track === 'gameplay') return;
    this.track = 'gameplay';
    this.bpm = 122;
    this.rootFrequency = 130.81; // C
    this.motif = [];
    this.applyIntensityMix(1.2);
    this.start();
  }

  private start(): void {
    this.step = 0;
    this.nextStepTime = this.core.now + 0.1;
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.scheduler(), MusicEngine.LOOKAHEAD_MS);
  }

  stop(fadeSeconds = 1.2): void {
    const t = this.core.now;
    for (const voice of [this.pad, this.bass, this.arp, this.lead, this.bell, this.drums]) {
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), t);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, t + fadeSeconds);
    }
    this.track = 'none';
    window.setTimeout(
      () => {
        if (this.track !== 'none') return;
        if (this.timer !== null) {
          window.clearInterval(this.timer);
          this.timer = null;
        }
      },
      fadeSeconds * 1000 + 80,
    );
  }

  setIntensity(value: number): void {
    this.targetIntensity = clamp01(value);
  }

  private setLevels(
    levels: { pad: number; bass: number; arp: number; lead: number; bell: number; drums: number },
    rampSeconds = 1.0,
  ): void {
    const t = this.core.now;
    const apply = (voice: Voice, value: number): void => {
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setTargetAtTime(value, t, rampSeconds / 3);
    };
    apply(this.pad, levels.pad);
    apply(this.bass, levels.bass);
    apply(this.arp, levels.arp);
    apply(this.lead, levels.lead);
    apply(this.bell, levels.bell);
    apply(this.drums, levels.drums);
  }

  /**
   * Maps intensity onto the arrangement. Instruments *enter* at thresholds
   * rather than all fading up together — that's what makes escalation feel
   * like an arrangement building rather than a volume knob turning.
   */
  private applyIntensityMix(rampSeconds = 1.6): void {
    const i = this.intensity;
    const above = (threshold: number, range = 0.25): number =>
      clamp01((i - threshold) / range);

    this.setLevels(
      {
        pad: 0.3 - i * 0.08,
        bass: 0.16 + above(0.1) * 0.14,
        arp: above(0.18) * 0.2,
        lead: above(0.55) * 0.16,
        bell: 0.06 + above(0.3) * 0.08,
        drums: above(0.12) * 0.34,
      },
      rampSeconds,
    );

    // Opening the filters as intensity rises adds perceived energy without
    // just getting louder.
    const t = this.core.now;
    this.arp.filter.frequency.setTargetAtTime(900 + i * 4200, t, 0.6);
    this.pad.filter.frequency.setTargetAtTime(700 + i * 1800, t, 0.6);
    this.lead.filter.frequency.setTargetAtTime(1400 + i * 2600, t, 0.6);
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private scheduler(): void {
    if (this.track === 'none' || !this.core.isRunning) return;

    const previous = this.intensity;
    this.intensity += (this.targetIntensity - this.intensity) * 0.05;
    if (this.track === 'gameplay' && Math.abs(previous - this.intensity) > 0.01) {
      this.applyIntensityMix(2.0);
    }

    const stepSeconds = 60 / this.bpm / 4;
    while (this.nextStepTime < this.core.now + MusicEngine.SCHEDULE_AHEAD) {
      // Swing: delay every off-beat 16th. Subtle at low intensity, looser at
      // high — the groove literally tightens up as the fight escalates.
      const swingAmount = this.track === 'menu' ? 0.16 : 0.1 - this.intensity * 0.06;
      const swing = this.step % 2 === 1 ? stepSeconds * swingAmount : 0;

      this.scheduleStep(this.step, this.nextStepTime + swing);
      this.nextStepTime += stepSeconds;
      this.step = (this.step + 1) % MusicEngine.STEPS_PER_LOOP;
    }
  }

  private get progression(): Chord[] {
    return this.track === 'menu' ? MENU_PROGRESSION : GAMEPLAY_PROGRESSION;
  }

  /** Harmonic rhythm doubles once the fight gets serious. */
  private get stepsPerChord(): number {
    return this.track === 'gameplay' && this.intensity > 0.45 ? 16 : 32;
  }

  private chordAt(step: number): Chord {
    const progression = this.progression;
    return progression[Math.floor(step / this.stepsPerChord) % progression.length];
  }

  private freq(semitonesFromTonic: number, octave = 0): number {
    return this.rootFrequency * Math.pow(2, semitonesFromTonic / 12 + octave);
  }

  private scheduleStep(step: number, time: number): void {
    const chord = this.chordAt(step);
    const beat = step % 16;
    const bar = Math.floor(step / 16);
    const isGameplay = this.track === 'gameplay';
    const chordStart = step % this.stepsPerChord === 0;

    // --- Pad: re-voiced on each chord change ------------------------------
    if (chordStart) {
      const holdSeconds = (60 / this.bpm / 4) * this.stepsPerChord * 1.05;
      // Drop the root an octave and spread the upper tones — proper spacing is
      // most of what makes a pad sound lush instead of muddy.
      this.playPad(this.freq(chord.root, -1), time, holdSeconds, 0.5);
      for (let i = 1; i < chord.tones.length; i++) {
        this.playPad(this.freq(chord.root + chord.tones[i], 0), time, holdSeconds, 1);
      }
    }

    // --- Bass: root on the downbeat, walking approach into the next chord ---
    if (beat === 0) {
      this.playBass(this.freq(chord.root, -2), time, 0.5);
    } else if (isGameplay && (beat === 6 || beat === 11)) {
      this.playBass(this.freq(chord.root + chord.tones[2], -2), time, 0.24);
    } else if (beat === 14 && step % this.stepsPerChord >= this.stepsPerChord - 16) {
      // Chromatic approach note leading into the next chord root.
      const next = this.progression[
        (Math.floor(step / this.stepsPerChord) + 1) % this.progression.length
      ];
      this.playBass(this.freq(next.root - 1, -2), time, 0.2);
    }

    // --- Arpeggio with voice leading --------------------------------------
    const arpEvery = isGameplay ? (this.intensity > 0.5 ? 2 : 4) : 4;
    if (beat % arpEvery === 0) {
      const index = Math.floor(step / arpEvery) % chord.tones.length;
      // Alternate octaves in a rolling pattern rather than a straight ladder.
      const octave = 1 + ((Math.floor(step / (arpEvery * chord.tones.length)) % 2) as number);
      this.playArp(this.freq(chord.root + chord.tones[index], octave), time, 0.34);
    }

    // --- Melody: motif-based random walk ----------------------------------
    if (this.lead.gain.gain.value > 0.005 || this.track === 'menu') {
      this.scheduleMelody(step, beat, bar, time, chord);
    }

    // --- Bell: sparse high accent on chord changes -------------------------
    if (chordStart && (bar % 2 === 0 || this.intensity > 0.6)) {
      this.playBell(this.freq(chord.root + chord.tones[chord.tones.length - 1], 2), time);
    }

    // --- Drums -------------------------------------------------------------
    if (isGameplay && this.intensity > 0.08) {
      this.scheduleDrums(step, beat, time);
    }
  }

  /**
   * Builds a two-bar motif then repeats and varies it, which is what makes a
   * generated line sound composed rather than random.
   */
  private scheduleMelody(step: number, beat: number, bar: number, time: number, chord: Chord): void {
    const phrasePosition = step % 32;

    // Compose a fresh motif at the start of every four-bar phrase.
    if (phrasePosition === 0 && bar % 4 === 0) {
      this.motif = [];
      for (let i = 0; i < 8; i++) {
        // 35% rests keep the line breathing.
        if (Math.random() < 0.35) {
          this.motif.push(NaN);
          continue;
        }
        // Step-wise motion most of the time, occasional leap.
        const move = Math.random() < 0.75 ? (Math.random() < 0.5 ? 1 : -1) : (Math.random() < 0.5 ? 2 : -2);
        this.lastMelodyDegree = Math.max(-3, Math.min(7, this.lastMelodyDegree + move));
        this.motif.push(this.lastMelodyDegree);
      }
    }

    if (this.motif.length === 0) return;
    // Melody sits on 8th notes.
    if (beat % 2 !== 0) return;

    const slot = (phrasePosition / 2) % this.motif.length;
    const degree = this.motif[slot];
    if (Number.isNaN(degree)) return;

    // Map the abstract degree onto the pentatonic scale, then bend it onto a
    // chord tone on strong beats so it always resolves consonantly.
    const octaveShift = Math.floor(degree / PENTATONIC.length);
    let semitone = PENTATONIC[((degree % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length];
    if (beat === 0 || beat === 8) {
      const nearest = chord.color.reduce((best, tone) =>
        Math.abs(tone - semitone) < Math.abs(best - semitone) ? tone : best,
      );
      semitone = nearest;
    }

    const duration = beat === 0 ? 0.62 : 0.4;
    this.playLead(this.freq(semitone, 1 + octaveShift), time, duration);
  }

  private scheduleDrums(step: number, beat: number, time: number): void {
    const i = this.intensity;

    // Kick: four-on-the-floor at high intensity, sparser when calm.
    if (beat === 0 || beat === 8) this.playKick(time);
    else if (i > 0.45 && (beat === 6 || beat === 11)) this.playKick(time, 0.7);

    // Backbeat.
    if (beat === 4 || beat === 12) this.playSnare(time, 0.34);

    // Hats: 8ths, then 16ths as it heats up. Accent the downbeats.
    const hatEvery = i > 0.55 ? 1 : 2;
    if (beat % hatEvery === 0) {
      this.playHat(time, beat % 4 === 0 ? 0.5 : 0.26, beat % 8 === 4 && i > 0.7);
    }

    // Ride the tom fill through the last bar of each eight-bar loop.
    if (i > 0.6 && step >= MusicEngine.STEPS_PER_LOOP - 8 && step % 2 === 0) {
      this.playTom(time, 1 - (MusicEngine.STEPS_PER_LOOP - step) / 8);
    }
  }

  // -------------------------------------------------------------------------
  // Instruments
  // -------------------------------------------------------------------------

  /** Three detuned saws through a slow filter sweep — a proper analogue pad. */
  private playPad(frequency: number, time: number, duration: number, level: number): void {
    const { core } = this;
    const filter = core.createFilter('lowpass', 500, 2.2);
    const gain = core.createGain(0);
    filter.connect(gain);
    gain.connect(this.pad.input);

    for (const detune of [-7, 0, 7]) {
      const osc = core.createOscillator('sawtooth', frequency);
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 0.1);
      osc.onended = () => osc.disconnect();
    }

    // Slow filter bloom gives the pad a sense of breathing.
    filter.frequency.setValueAtTime(420, time);
    filter.frequency.linearRampToValueAtTime(1700, time + duration * 0.55);
    filter.frequency.linearRampToValueAtTime(700, time + duration);

    const peak = 0.05 * level;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(peak, time + duration * 0.3);
    gain.gain.setValueAtTime(peak, time + duration * 0.62);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  }

  private playBass(frequency: number, time: number, duration: number): void {
    const { core } = this;
    const osc = core.createOscillator('sawtooth', frequency);
    const sub = core.createOscillator('sine', frequency * 0.5);
    const filter = core.createFilter('lowpass', 300, 6);
    const gain = core.createGain(0);

    osc.connect(filter);
    sub.connect(gain);
    filter.connect(gain);
    gain.connect(this.bass.input);

    // Envelope on the filter, not just the amp — that's the classic synth-bass
    // "pluck" and it cuts through a busy mix at low volume.
    filter.frequency.setValueAtTime(1600, time);
    filter.frequency.exponentialRampToValueAtTime(240, time + duration * 0.7);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.2, time + 0.014);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.start(time);
    sub.start(time);
    osc.stop(time + duration + 0.05);
    sub.stop(time + duration + 0.05);
    osc.onended = () => {
      osc.disconnect();
      sub.disconnect();
    };
  }

  private playArp(frequency: number, time: number, duration: number): void {
    const { core } = this;
    const osc = core.createOscillator('triangle', frequency);
    const shimmer = core.createOscillator('sine', frequency * 2.01);
    const gain = core.createGain(0);
    const shimmerGain = core.createGain(0);

    osc.connect(gain);
    shimmer.connect(shimmerGain);
    shimmerGain.connect(gain);
    gain.connect(this.arp.input);
    shimmerGain.gain.value = 0.25;

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.13, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.start(time);
    shimmer.start(time);
    osc.stop(time + duration + 0.04);
    shimmer.stop(time + duration + 0.04);
    osc.onended = () => {
      osc.disconnect();
      shimmer.disconnect();
    };
  }

  private playLead(frequency: number, time: number, duration: number): void {
    const { core } = this;
    const osc = core.createOscillator('square', frequency);
    const filter = core.createFilter('lowpass', 2400, 4);
    const gain = core.createGain(0);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.lead.input);

    // Light vibrato once the note has had time to settle.
    const lfo = core.createOscillator('sine', 5.4);
    const lfoGain = core.createGain(0);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfoGain.gain.setValueAtTime(0, time);
    lfoGain.gain.linearRampToValueAtTime(frequency * 0.008, time + duration * 0.6);
    lfo.start(time);
    lfo.stop(time + duration + 0.06);
    lfo.onended = () => lfo.disconnect();

    filter.frequency.setValueAtTime(3600, time);
    filter.frequency.exponentialRampToValueAtTime(1100, time + duration);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.1, time + 0.022);
    gain.gain.setValueAtTime(0.1, time + duration * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.start(time);
    osc.stop(time + duration + 0.06);
    osc.onended = () => osc.disconnect();
  }

  /** FM bell — two sines where one modulates the other's frequency. */
  private playBell(frequency: number, time: number): void {
    const { core } = this;
    const carrier = core.createOscillator('sine', frequency);
    const modulator = core.createOscillator('sine', frequency * 2.4);
    const modGain = core.createGain(frequency * 1.8);
    const gain = core.createGain(0);

    modulator.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(gain);
    gain.connect(this.bell.input);

    // Modulation index decays fast: bright metallic attack, pure sine tail.
    modGain.gain.setValueAtTime(frequency * 1.8, time);
    modGain.gain.exponentialRampToValueAtTime(frequency * 0.02, time + 0.6);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.09, time + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.8);

    carrier.start(time);
    modulator.start(time);
    carrier.stop(time + 1.9);
    modulator.stop(time + 1.9);
    carrier.onended = () => {
      carrier.disconnect();
      modulator.disconnect();
    };
  }

  private playKick(time: number, level = 1): void {
    const { core } = this;
    const osc = core.createOscillator('sine', 150);
    const gain = core.createGain(0);
    const click = core.createNoiseSource(1.8);
    const clickFilter = core.createFilter('highpass', 1800, 1);
    const clickGain = core.createGain(0);

    osc.connect(gain);
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(gain);
    gain.connect(this.drums.input);

    osc.frequency.setValueAtTime(165, time);
    osc.frequency.exponentialRampToValueAtTime(44, time + 0.13);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.62 * level, time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);

    // Beater click gives the kick definition on small speakers.
    clickGain.gain.setValueAtTime(0.12 * level, time);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.02);

    osc.start(time);
    click.start(time, Math.random());
    osc.stop(time + 0.34);
    click.stop(time + 0.05);
    osc.onended = () => {
      osc.disconnect();
      click.disconnect();
    };
  }

  private playSnare(time: number, level: number): void {
    const { core } = this;
    const noise = core.createNoiseSource(1.1);
    const filter = core.createFilter('bandpass', 1900, 0.9);
    const gain = core.createGain(0);

    // A tuned body under the noise turns a hiss into an actual drum.
    const body = core.createOscillator('triangle', 190);
    const bodyGain = core.createGain(0);

    noise.connect(filter);
    filter.connect(gain);
    body.connect(bodyGain);
    bodyGain.connect(gain);
    gain.connect(this.drums.input);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(level, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.19);

    body.frequency.setValueAtTime(220, time);
    body.frequency.exponentialRampToValueAtTime(150, time + 0.1);
    bodyGain.gain.setValueAtTime(0.5, time);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);

    noise.start(time, Math.random());
    body.start(time);
    noise.stop(time + 0.24);
    body.stop(time + 0.14);
    noise.onended = () => {
      noise.disconnect();
      body.disconnect();
    };
  }

  private playHat(time: number, level: number, open: boolean): void {
    const { core } = this;
    const noise = core.createNoiseSource(2.6);
    const filter = core.createFilter('highpass', 8200, 1);
    const gain = core.createGain(0);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.drums.input);

    const decay = open ? 0.22 : 0.05;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(level * 0.15, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decay);

    noise.start(time, Math.random());
    noise.stop(time + decay + 0.03);
    noise.onended = () => noise.disconnect();
  }

  /** Descending tom used for end-of-loop fills. */
  private playTom(time: number, progress: number): void {
    const { core } = this;
    const osc = core.createOscillator('sine', 220 - progress * 90);
    const gain = core.createGain(0);
    osc.connect(gain);
    gain.connect(this.drums.input);

    osc.frequency.setValueAtTime(230 - progress * 100, time);
    osc.frequency.exponentialRampToValueAtTime(90 - progress * 30, time + 0.16);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.3, time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);

    osc.start(time);
    osc.stop(time + 0.24);
    osc.onended = () => osc.disconnect();
  }

  dispose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.track = 'none';
  }
}
