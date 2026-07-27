import type { AudioCore } from './AudioCore';

/** Where the listener is, refreshed once per frame by the AudioManager. */
export interface ListenerState {
  x: number;
  z: number;
  forwardX: number;
  forwardZ: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Per-weapon voicing, defined alongside each weapon in WeaponDefs. */
export interface GunSoundProfile {
  /** Peak level, 0..1. */
  level: number;
  /** Centre frequency of the noise crack, Hz. */
  brightness: number;
  /** Starting frequency of the low-end thump, Hz. */
  body: number;
  /** Crack decay time, seconds. */
  decay: number;
  /** Low-end tail length, seconds. */
  tail: number;
  /** Waveshaper drive, 0..1. */
  drive: number;
  /** Reverb send amount, 0..1. */
  space: number;
}

/**
 * Every sound effect in the game, synthesised on demand.
 *
 * Each method builds a tiny disposable node graph, schedules its envelope, and
 * hands the chain to AudioCore.scheduleRelease so it is disconnected once it
 * has gone quiet. Leaving that to the garbage collector is not good enough:
 * nodes with tail time stay in the graph and keep being processed long after
 * they are silent.
 */
export class SoundBank {
  private listener: ListenerState = { x: 0, z: 0, forwardX: 0, forwardZ: -1 };

  /**
   * Gunshot voice budget.
   *
   * A full gunshot is three layered voices plus a reverb send. An SMG at 14
   * rounds a second sustains ~60 overlapping nodes, which is enough to starve
   * the audio thread on a modest machine — the symptom is crackling, because
   * the graph misses its render deadline rather than because anything clips.
   *
   * Past a threshold, extra shots drop to a single dry crack layer. It still
   * reads as continuous fire but costs a third as much.
   */
  private activeGunshots = 0;
  private static readonly FULL_DETAIL_VOICES = 4;
  private static readonly MAX_VOICES = 10;

  constructor(private readonly core: AudioCore) {}

  setListener(state: ListenerState): void {
    this.listener = state;
  }

  /** Routes a sound either to the flat 2D bus or through positional shaping. */
  private output(position?: Vec3Like, maxDistance = 55, reverb = 0.18): GainNode | null {
    const { core } = this;
    if (!position) {
      const gain = core.createGain(1);
      gain.connect(core.sfxBus);
      const chain: AudioNode[] = [gain];
      if (reverb > 0) {
        const send = core.createGain(reverb);
        gain.connect(send);
        send.connect(core.reverbSend);
        chain.push(send);
      }
      // Same guarantee as the positional path: the chain tears itself down.
      core.scheduleRelease(chain, 4);
      return gain;
    }

    const { input, audible } = core.createPositionalOutput(
      this.listener,
      { x: this.listener.forwardX, z: this.listener.forwardZ },
      position,
      maxDistance,
    );
    if (!audible) {
      input.disconnect();
      return null;
    }
    return input;
  }

  // -------------------------------------------------------------------------
  // Weapons
  // -------------------------------------------------------------------------

  /**
   * Gunshot = three layered elements, exactly as in real sound design:
   *   1. the "crack" — filtered noise burst, defines the character
   *   2. the "body"  — pitch-dropping sine, gives it weight
   *   3. the "tail"  — low resonant noise decaying into the reverb
   */
  gunshot(profile: GunSoundProfile, position?: Vec3Like): void {
    const { core } = this;
    const t = core.now;

    // Hard ceiling: beyond this the ear cannot separate the shots anyway.
    if (this.activeGunshots >= SoundBank.MAX_VOICES) return;

    const lean = this.activeGunshots >= SoundBank.FULL_DETAIL_VOICES;
    // Reverb is the most expensive part of the chain, so busy moments get less.
    const space = lean ? profile.space * 0.25 : profile.space;

    const out = this.output(position, 90, space);
    if (!out) return;

    this.activeGunshots++;
    const totalLife = Math.max(profile.decay, profile.tail) * 1.9;
    // Released off the shared audio sweep rather than its own timer, so
    // sustained fire doesn't queue a setTimeout per round.
    core.scheduleRelease([], totalLife, () => {
      this.activeGunshots = Math.max(0, this.activeGunshots - 1);
    });

    // Overlapping shots are quieter, which keeps the sum away from the limiter
    // and stops sustained fire from pumping the whole mix.
    const crowding = 1 / (1 + this.activeGunshots * 0.16);

    // Slight random detune per shot so sustained fire never sounds looped.
    const variance = 0.92 + Math.random() * 0.16;

    // --- Crack -------------------------------------------------------------
    const noise = core.createNoiseSource(1 + Math.random() * 0.3);
    const bandpass = core.createFilter('bandpass', profile.brightness * variance, 1.1);
    const highpass = core.createFilter('highpass', 320, 0.7);
    const crackGain = core.createGain(0);
    const drive = core.createDistortion(profile.drive);

    noise.connect(bandpass);
    bandpass.connect(highpass);
    highpass.connect(drive);
    drive.connect(crackGain);
    crackGain.connect(out);

    crackGain.gain.setValueAtTime(0.0001, t);
    crackGain.gain.linearRampToValueAtTime(profile.level * crowding, t + 0.002);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + profile.decay);
    // Sweeping the filter down as it decays mimics the muzzle blast dispersing.
    bandpass.frequency.setValueAtTime(profile.brightness * variance, t);
    bandpass.frequency.exponentialRampToValueAtTime(
      Math.max(180, profile.brightness * 0.28),
      t + profile.decay,
    );

    noise.start(t, Math.random() * 1.5);
    core.disposeAfter(noise, profile.decay + 0.05);
    core.scheduleRelease([bandpass, highpass, drive, crackGain], profile.decay + 0.3);

    if (lean) return;

    // --- Body --------------------------------------------------------------
    const bodyOsc = core.createOscillator('sine', profile.body * variance);
    const bodyGain = core.createGain(0);
    bodyOsc.connect(bodyGain);
    bodyGain.connect(out);
    bodyOsc.frequency.setValueAtTime(profile.body * variance, t);
    bodyOsc.frequency.exponentialRampToValueAtTime(profile.body * 0.32, t + profile.tail);
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.linearRampToValueAtTime(profile.level * 0.85 * crowding, t + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + profile.tail);
    bodyOsc.start(t);
    core.disposeAfter(bodyOsc, profile.tail + 0.05);
    core.scheduleRelease([bodyGain], profile.tail + 0.3);

    // --- Tail --------------------------------------------------------------
    const tailNoise = core.createNoiseSource(0.6);
    const tailFilter = core.createFilter('lowpass', 700, 3.5);
    const tailGain = core.createGain(0);
    tailNoise.connect(tailFilter);
    tailFilter.connect(tailGain);
    tailGain.connect(out);
    tailGain.gain.setValueAtTime(0.0001, t + 0.01);
    tailGain.gain.linearRampToValueAtTime(profile.level * 0.3 * crowding, t + 0.02);
    tailGain.gain.exponentialRampToValueAtTime(0.0001, t + profile.tail * 1.8);
    tailNoise.start(t, Math.random());
    core.disposeAfter(tailNoise, profile.tail * 1.8 + 0.05);
    core.scheduleRelease([tailFilter, tailGain], profile.tail * 1.8 + 0.3);
  }

  /** Hammer falling on an empty chamber. */
  dryFire(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.05);
    if (!out) return;

    const click = core.createNoiseSource(2.2);
    const filter = core.createFilter('bandpass', 2600, 4);
    const gain = core.createGain(0);
    click.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.28, t + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    click.start(t, Math.random());
    core.disposeAfter(click, 0.06);

    // A hollow metallic "tock" underneath.
    const tock = core.createOscillator('triangle', 190);
    const tockGain = core.createGain(0);
    tock.connect(tockGain);
    tockGain.connect(out);
    tockGain.gain.setValueAtTime(0.0001, t);
    tockGain.gain.linearRampToValueAtTime(0.12, t + 0.003);
    tockGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    tock.start(t);
    core.disposeAfter(tock, 0.09);
  }

  /**
   * Mechanical reload clicks. `variant` selects the character:
   * mag release, magazine seating, or the bolt/slide racking home.
   */
  reloadClick(variant: 'release' | 'insert' | 'rack', delay = 0): void {
    const { core } = this;
    const t = core.now + delay;
    const out = this.output(undefined, 0, 0.1);
    if (!out) return;

    const settings = {
      release: { freq: 1800, q: 6, level: 0.2, decay: 0.05, thump: 120 },
      insert: { freq: 900, q: 3, level: 0.3, decay: 0.09, thump: 85 },
      rack: { freq: 2900, q: 5, level: 0.34, decay: 0.11, thump: 160 },
    }[variant];

    const noise = core.createNoiseSource(1.6);
    const filter = core.createFilter('bandpass', settings.freq, settings.q);
    const gain = core.createGain(0);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(settings.level, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + settings.decay);
    noise.start(t, Math.random());
    core.disposeAfter(noise, settings.decay + 0.05);

    const thump = core.createOscillator('sine', settings.thump);
    const thumpGain = core.createGain(0);
    thump.connect(thumpGain);
    thumpGain.connect(out);
    thumpGain.gain.setValueAtTime(0.0001, t);
    thumpGain.gain.linearRampToValueAtTime(settings.level * 0.5, t + 0.004);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    thump.start(t);
    core.disposeAfter(thump, 0.1);
  }

  /** Brass casing bouncing on stone. */
  shellDrop(delay = 0): void {
    const { core } = this;
    const t = core.now + delay;
    const out = this.output(undefined, 0, 0.25);
    if (!out) return;

    // Three decaying bounces at rising frequency.
    for (let i = 0; i < 3; i++) {
      const bounceTime = t + i * (0.06 + i * 0.045);
      const osc = core.createOscillator('triangle', 2200 + i * 380 + Math.random() * 300);
      const gain = core.createGain(0);
      const filter = core.createFilter('highpass', 1400, 1);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      const level = 0.075 / (i + 1);
      gain.gain.setValueAtTime(0.0001, bounceTime);
      gain.gain.linearRampToValueAtTime(level, bounceTime + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, bounceTime + 0.09);
      osc.start(bounceTime);
      core.disposeAfter(osc, i * 0.12 + 0.14);
    }
  }

  weaponSwitch(): void {
    this.reloadClick('release', 0);
    this.reloadClick('rack', 0.12);
  }

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------

  /** Crisp UI-style tick confirming a hit landed. Pitch rises with severity. */
  hitMarker(kind: 'normal' | 'critical' | 'kill'): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.08);
    if (!out) return;

    const config = {
      normal: { freq: 1750, level: 0.13, decay: 0.055, harmonic: 0 },
      critical: { freq: 2450, level: 0.2, decay: 0.09, harmonic: 1.5 },
      kill: { freq: 1180, level: 0.24, decay: 0.16, harmonic: 2.0 },
    }[kind];

    const osc = core.createOscillator('square', config.freq);
    const filter = core.createFilter('bandpass', config.freq, 2.5);
    const gain = core.createGain(0);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(config.level, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + config.decay);
    osc.start(t);
    core.disposeAfter(osc, config.decay + 0.03);

    // Crits and kills get a sparkly upper partial.
    if (config.harmonic > 0) {
      const shimmer = core.createOscillator('sine', config.freq * config.harmonic);
      const shimmerGain = core.createGain(0);
      shimmer.connect(shimmerGain);
      shimmerGain.connect(out);
      shimmer.frequency.setValueAtTime(config.freq * config.harmonic, t);
      shimmer.frequency.exponentialRampToValueAtTime(config.freq * config.harmonic * 1.6, t + config.decay);
      shimmerGain.gain.setValueAtTime(0.0001, t);
      shimmerGain.gain.linearRampToValueAtTime(config.level * 0.5, t + 0.004);
      shimmerGain.gain.exponentialRampToValueAtTime(0.0001, t + config.decay * 1.3);
      shimmer.start(t);
      core.disposeAfter(shimmer, config.decay * 1.3 + 0.03);
    }
  }

  /** Bullet striking a surface, voiced by material family. */
  impact(surface: 'stone' | 'wood' | 'metal' | 'dirt' | 'foliage', position?: Vec3Like): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(position, 45, 0.2);
    if (!out) return;

    const config = {
      stone: { freq: 2600, q: 2.2, decay: 0.1, level: 0.3, type: 'bandpass' as const },
      wood: { freq: 900, q: 1.6, decay: 0.12, level: 0.32, type: 'bandpass' as const },
      metal: { freq: 4200, q: 8, decay: 0.28, level: 0.24, type: 'bandpass' as const },
      dirt: { freq: 480, q: 0.9, decay: 0.09, level: 0.26, type: 'lowpass' as const },
      foliage: { freq: 5200, q: 0.8, decay: 0.14, level: 0.18, type: 'highpass' as const },
    }[surface];

    const noise = core.createNoiseSource(1 + Math.random() * 0.6);
    const filter = core.createFilter(config.type, config.freq * (0.85 + Math.random() * 0.3), config.q);
    const gain = core.createGain(0);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(config.level, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + config.decay);
    noise.start(t, Math.random());
    core.disposeAfter(noise, config.decay + 0.05);
  }

  /** Boots on grass or cobbles. */
  footstep(surface: 'grass' | 'stone', intensity = 1): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.14);
    if (!out) return;

    const noise = core.createNoiseSource(0.8 + Math.random() * 0.5);
    const filter = core.createFilter(
      surface === 'grass' ? 'highpass' : 'bandpass',
      surface === 'grass' ? 1800 + Math.random() * 900 : 620 + Math.random() * 300,
      surface === 'grass' ? 0.8 : 1.8,
    );
    const gain = core.createGain(0);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    const level = (surface === 'grass' ? 0.075 : 0.11) * intensity;
    const decay = surface === 'grass' ? 0.09 : 0.07;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    noise.start(t, Math.random());
    core.disposeAfter(noise, decay + 0.04);

    // Heel thump on hard ground.
    if (surface === 'stone') {
      const thump = core.createOscillator('sine', 92 + Math.random() * 20);
      const thumpGain = core.createGain(0);
      thump.connect(thumpGain);
      thumpGain.connect(out);
      thumpGain.gain.setValueAtTime(0.0001, t);
      thumpGain.gain.linearRampToValueAtTime(0.07 * intensity, t + 0.004);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      thump.start(t);
      core.disposeAfter(thump, 0.09);
    }
  }

  jump(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.1);
    if (!out) return;
    const osc = core.createOscillator('sine', 260);
    const gain = core.createGain(0);
    osc.connect(gain);
    gain.connect(out);
    osc.frequency.setValueAtTime(210, t);
    osc.frequency.exponentialRampToValueAtTime(380, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.07, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.start(t);
    core.disposeAfter(osc, 0.17);
  }

  land(intensity: number): void {
    this.footstep('stone', 1.4 * intensity);
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.2);
    if (!out) return;
    const osc = core.createOscillator('sine', 130);
    const gain = core.createGain(0);
    osc.connect(gain);
    gain.connect(out);
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(58, t + 0.16);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.16 * intensity, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.start(t);
    core.disposeAfter(osc, 0.24);
  }

  // -------------------------------------------------------------------------
  // Zombies
  // -------------------------------------------------------------------------

  /**
   * Zombie vocalisation — a guttural, formant-filtered growl.
   *
   * Two peaky bandpasses act as vowel formants, which is what turns a buzzing
   * sawtooth into something that reads as a *throat*. Pitched low, driven
   * through a waveshaper for rasp, and detuned against a sub for a rough beat
   * frequency: unpleasant and animal, but with no screaming or wet sounds.
   */
  zombieGrowl(pitch: number, duration: number, position?: Vec3Like): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(position, 46, 0.34);
    if (!out) return;

    const base = 68 * pitch;

    const osc = core.createOscillator('sawtooth', base);
    // Slightly detuned second oscillator creates a rough, unstable beating.
    const osc2 = core.createOscillator('sawtooth', base * 1.013);
    const sub = core.createOscillator('sine', base * 0.5);
    const formant1 = core.createFilter('bandpass', 310 * pitch, 7);
    const formant2 = core.createFilter('bandpass', 840 * pitch, 9);
    const rasp = core.createDistortion(0.55);
    const mix = core.createGain(0);
    const gain = core.createGain(0);

    osc.connect(formant1);
    osc.connect(formant2);
    osc2.connect(formant1);
    osc2.connect(formant2);
    sub.connect(mix);
    formant1.connect(rasp);
    formant2.connect(rasp);
    rasp.connect(mix);
    mix.gain.value = 0.5;
    mix.connect(gain);
    gain.connect(out);

    // Wobble the pitch so it sounds gurgly and alive.
    const lfo = core.createOscillator('sine', 5.5 + Math.random() * 3);
    const lfoGain = core.createGain(base * 0.09);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start(t);
    core.disposeAfter(lfo, duration + 0.1);

    osc.frequency.setValueAtTime(base * 1.15, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.78, t + duration);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.4, t + duration * 0.22);
    gain.gain.setValueAtTime(0.4, t + duration * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.start(t);
    osc2.start(t);
    sub.start(t);
    core.disposeAfter(osc, duration + 0.05);
    core.disposeAfter(osc2, duration + 0.05);
    core.disposeAfter(sub, duration + 0.05);
  }

  /** Short surprised yelp when a zombie takes a hit. */
  zombieHurt(pitch: number, position?: Vec3Like): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(position, 38, 0.25);
    if (!out) return;

    const osc = core.createOscillator('square', 260 * pitch);
    const filter = core.createFilter('lowpass', 1500 * pitch, 3);
    const gain = core.createGain(0);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    osc.frequency.setValueAtTime(320 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(180 * pitch, t + 0.14);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.17, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.start(t);
    core.disposeAfter(osc, 0.19);
  }

  /** Deflating-balloon descent — reads as "defeated", never gruesome. */
  zombieDeath(pitch: number, position?: Vec3Like): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(position, 45, 0.35);
    if (!out) return;

    const osc = core.createOscillator('sawtooth', 300 * pitch);
    const filter = core.createFilter('lowpass', 1800, 4);
    const gain = core.createGain(0);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    osc.frequency.setValueAtTime(340 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(70 * pitch, t + 0.42);
    filter.frequency.setValueAtTime(2400, t);
    filter.frequency.exponentialRampToValueAtTime(320, t + 0.42);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.start(t);
    core.disposeAfter(osc, 0.5);

    // A little puff of air at the end.
    const puff = core.createNoiseSource(0.7);
    const puffFilter = core.createFilter('bandpass', 900, 1.2);
    const puffGain = core.createGain(0);
    puff.connect(puffFilter);
    puffFilter.connect(puffGain);
    puffGain.connect(out);
    puffGain.gain.setValueAtTime(0.0001, t + 0.3);
    puffGain.gain.linearRampToValueAtTime(0.1, t + 0.34);
    puffGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    puff.start(t + 0.3, Math.random());
    core.disposeAfter(puff, 0.65);
  }

  /** Rising warning beeps before an exploder detonates. */
  exploderBeep(step: number, position?: Vec3Like): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(position, 34, 0.2);
    if (!out) return;
    const osc = core.createOscillator('square', 660 * (1 + step * 0.16));
    const gain = core.createGain(0);
    osc.connect(gain);
    gain.connect(out);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.16, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.start(t);
    core.disposeAfter(osc, 0.13);
  }

  /** Cartoon "pop" explosion — big and boomy, but bouncy rather than violent. */
  explosion(position?: Vec3Like): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(position, 80, 0.6);
    if (!out) return;

    const noise = core.createNoiseSource(0.5);
    const filter = core.createFilter('lowpass', 1400, 1.4);
    const gain = core.createGain(0);
    const drive = core.createDistortion(0.3);
    noise.connect(filter);
    filter.connect(drive);
    drive.connect(gain);
    gain.connect(out);
    filter.frequency.setValueAtTime(2600, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.7);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.5, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    noise.start(t, Math.random());
    core.disposeAfter(noise, 0.85);

    // Deep pitch-dropping boom.
    const boom = core.createOscillator('sine', 120);
    const boomGain = core.createGain(0);
    boom.connect(boomGain);
    boomGain.connect(out);
    boom.frequency.setValueAtTime(180, t);
    boom.frequency.exponentialRampToValueAtTime(34, t + 0.6);
    boomGain.gain.setValueAtTime(0.0001, t);
    boomGain.gain.linearRampToValueAtTime(0.55, t + 0.01);
    boomGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    boom.start(t);
    core.disposeAfter(boom, 0.75);

    // Comedy "boing" overtone keeps it firmly out of horror territory.
    const boing = core.createOscillator('triangle', 420);
    const boingGain = core.createGain(0);
    boing.connect(boingGain);
    boingGain.connect(out);
    boing.frequency.setValueAtTime(520, t + 0.03);
    boing.frequency.exponentialRampToValueAtTime(150, t + 0.35);
    boingGain.gain.setValueAtTime(0.0001, t + 0.03);
    boingGain.gain.linearRampToValueAtTime(0.12, t + 0.06);
    boingGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    boing.start(t + 0.03);
    core.disposeAfter(boing, 0.45);
  }

  /** Boss arrival: a huge descending roar with a rising tension swell. */
  bossRoar(position?: Vec3Like): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(position, 120, 0.7);
    if (!out) return;

    const osc = core.createOscillator('sawtooth', 70);
    const sub = core.createOscillator('sine', 35);
    const filter = core.createFilter('lowpass', 900, 6);
    const gain = core.createGain(0);
    const drive = core.createDistortion(0.45);

    osc.connect(filter);
    sub.connect(filter);
    filter.connect(drive);
    drive.connect(gain);
    gain.connect(out);

    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 1.5);
    filter.frequency.setValueAtTime(320, t);
    filter.frequency.exponentialRampToValueAtTime(1800, t + 0.5);
    filter.frequency.exponentialRampToValueAtTime(240, t + 1.5);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.55, t + 0.18);
    gain.gain.setValueAtTime(0.55, t + 0.9);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);

    osc.start(t);
    sub.start(t);
    core.disposeAfter(osc, 1.7);
    core.disposeAfter(sub, 1.7);
  }

  // -------------------------------------------------------------------------
  // Player + economy + UI
  // -------------------------------------------------------------------------

  playerHurt(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.15);
    if (!out) return;

    const thump = core.createOscillator('sine', 160);
    const gain = core.createGain(0);
    thump.connect(gain);
    gain.connect(out);
    thump.frequency.setValueAtTime(190, t);
    thump.frequency.exponentialRampToValueAtTime(62, t + 0.24);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.34, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    thump.start(t);
    core.disposeAfter(thump, 0.34);

    const air = core.createNoiseSource(0.9);
    const airFilter = core.createFilter('bandpass', 700, 1.1);
    const airGain = core.createGain(0);
    air.connect(airFilter);
    airFilter.connect(airGain);
    airGain.connect(out);
    airGain.gain.setValueAtTime(0.0001, t);
    airGain.gain.linearRampToValueAtTime(0.16, t + 0.01);
    airGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    air.start(t, Math.random());
    core.disposeAfter(air, 0.24);
  }

  /** Bright ascending arpeggio — coins landing in your pocket. */
  coinPickup(pitchStep = 0): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.22);
    if (!out) return;

    // Pentatonic so rapid pickups always sound harmonious.
    const scale = [0, 2, 4, 7, 9, 12];
    const semitone = scale[pitchStep % scale.length] + Math.floor(pitchStep / scale.length) * 12;
    const base = 880 * Math.pow(2, semitone / 12);

    for (let i = 0; i < 2; i++) {
      const osc = core.createOscillator(i === 0 ? 'sine' : 'triangle', base * (i === 0 ? 1 : 1.5));
      const gain = core.createGain(0);
      osc.connect(gain);
      gain.connect(out);
      const start = t + i * 0.035;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.11 / (i + 1), start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.start(start);
      core.disposeAfter(osc, 0.28 + i * 0.04);
    }
  }

  /** Satisfying confirmation chord for a completed purchase. */
  purchase(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.25);
    if (!out) return;
    // Major triad, arpeggiated upward.
    for (const [i, ratio] of [1, 1.25, 1.5, 2].entries()) {
      const osc = core.createOscillator('triangle', 523.25 * ratio);
      const gain = core.createGain(0);
      osc.connect(gain);
      gain.connect(out);
      const start = t + i * 0.05;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.1, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
      osc.start(start);
      core.disposeAfter(osc, 0.5 + i * 0.05);
    }
  }

  /** Flat two-tone buzz for "you can't afford that". */
  denied(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.05);
    if (!out) return;
    for (const [i, freq] of [220, 175].entries()) {
      const osc = core.createOscillator('square', freq);
      const gain = core.createGain(0);
      const filter = core.createFilter('lowpass', 1200, 1);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      const start = t + i * 0.09;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      osc.start(start);
      core.disposeAfter(osc, 0.15 + i * 0.09);
    }
  }

  uiHover(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.12);
    if (!out) return;
    const osc = core.createOscillator('sine', 1320);
    const gain = core.createGain(0);
    osc.connect(gain);
    gain.connect(out);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.045, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.start(t);
    core.disposeAfter(osc, 0.09);
  }

  uiClick(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.16);
    if (!out) return;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = core.createOscillator('triangle', freq);
      const gain = core.createGain(0);
      osc.connect(gain);
      gain.connect(out);
      const start = t + i * 0.028;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      osc.start(start);
      core.disposeAfter(osc, 0.19 + i * 0.03);
    }
  }

  uiBack(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.16);
    if (!out) return;
    for (const [i, freq] of [1320, 880].entries()) {
      const osc = core.createOscillator('triangle', freq);
      const gain = core.createGain(0);
      osc.connect(gain);
      gain.connect(out);
      const start = t + i * 0.028;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.075, start + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      osc.start(start);
      core.disposeAfter(osc, 0.17 + i * 0.03);
    }
  }

  /** Fanfare announcing a new wave. */
  waveStart(waveNumber: number): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.5);
    if (!out) return;
    // Rise a whole tone every five waves so later waves feel more urgent.
    const shift = Math.pow(2, Math.floor((waveNumber - 1) / 5) / 6);
    const notes = [261.63, 329.63, 392.0, 523.25];
    for (const [i, note] of notes.entries()) {
      for (const detune of [1, 2]) {
        const osc = core.createOscillator(detune === 1 ? 'triangle' : 'sine', note * shift * detune);
        const gain = core.createGain(0);
        osc.connect(gain);
        gain.connect(out);
        const start = t + i * 0.11;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(0.14 / detune, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
        osc.start(start);
        core.disposeAfter(osc, 0.7 + i * 0.11);
      }
    }
  }

  /** Warm resolving cadence when a wave is cleared. */
  waveClear(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.6);
    if (!out) return;
    const chords = [
      [392.0, 493.88, 587.33],
      [523.25, 659.25, 783.99],
    ];
    for (const [ci, chord] of chords.entries()) {
      for (const note of chord) {
        const osc = core.createOscillator('triangle', note);
        const gain = core.createGain(0);
        osc.connect(gain);
        gain.connect(out);
        const start = t + ci * 0.24;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(0.085, start + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
        osc.start(start);
        core.disposeAfter(osc, 1.0 + ci * 0.24);
      }
    }
  }

  /** Descending minor cadence on death. */
  gameOver(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.75);
    if (!out) return;
    const notes = [440, 392, 349.23, 261.63];
    for (const [i, note] of notes.entries()) {
      for (const [oi, ratio] of [1, 0.5].entries()) {
        const osc = core.createOscillator(oi === 0 ? 'triangle' : 'sine', note * ratio);
        const gain = core.createGain(0);
        const filter = core.createFilter('lowpass', 2200, 0.9);
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(out);
        const start = t + i * 0.34;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(0.12 * (oi === 0 ? 1 : 0.7), start + 0.06);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.4);
        osc.start(start);
        core.disposeAfter(osc, 1.6 + i * 0.34);
      }
    }
  }

  /** Heartbeat thud used when the player is critically wounded. */
  heartbeat(): void {
    const { core } = this;
    const t = core.now;
    const out = this.output(undefined, 0, 0.1);
    if (!out) return;
    for (const [i, delay] of [0, 0.17].entries()) {
      const osc = core.createOscillator('sine', 54);
      const gain = core.createGain(0);
      osc.connect(gain);
      gain.connect(out);
      const start = t + delay;
      osc.frequency.setValueAtTime(72, start);
      osc.frequency.exponentialRampToValueAtTime(38, start + 0.14);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(i === 0 ? 0.3 : 0.2, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
      osc.start(start);
      core.disposeAfter(osc, delay + 0.25);
    }
  }
}
