import { Storage, STORAGE_KEYS } from '../utilities/Storage';

export type GraphicsPreset = 'low' | 'medium' | 'high' | 'ultra';

export interface GameSettings {
  musicVolume: number;
  sfxVolume: number;
  sensitivity: number;
  graphics: GraphicsPreset;
  motionBlur: boolean;
  shadows: boolean;
  bloom: boolean;
  fov: number;
  showFps: boolean;
  screenShake: number;
  invertY: boolean;
  damageNumbers: boolean;
  reducedMotion: boolean;
  highContrastUi: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  musicVolume: 0.55,
  sfxVolume: 0.8,
  sensitivity: 1.0,
  graphics: 'high',
  motionBlur: true,
  shadows: true,
  bloom: true,
  fov: 78,
  showFps: true,
  screenShake: 1.0,
  invertY: false,
  damageNumbers: true,
  reducedMotion: false,
  highContrastUi: false,
};

/**
 * Per-preset renderer knobs. These are read by the renderer, world and particle
 * systems so a single dropdown scales the whole frame budget coherently.
 */
export interface QualityProfile {
  pixelRatioCap: number;
  shadowMapSize: number;
  shadowsEnabled: boolean;
  bloomEnabled: boolean;
  ssaoEnabled: boolean;
  maxParticles: number;
  maxDecals: number;
  maxZombies: number;
  grassDensity: number;
  fireflyCount: number;
  anisotropy: number;
  godRays: boolean;
  fogDetail: boolean;
  /** Hardware MSAA samples on the post-processing render targets. */
  msaaSamples: number;
}

export const QUALITY_PROFILES: Record<GraphicsPreset, QualityProfile> = {
  low: {
    pixelRatioCap: 1.0,
    shadowMapSize: 1024,
    shadowsEnabled: false,
    bloomEnabled: false,
    ssaoEnabled: false,
    maxParticles: 220,
    maxDecals: 24,
    maxZombies: 26,
    grassDensity: 0,
    fireflyCount: 0,
    anisotropy: 1,
    godRays: false,
    fogDetail: false,
    msaaSamples: 0,
  },
  medium: {
    pixelRatioCap: 1.25,
    shadowMapSize: 1024,
    shadowsEnabled: true,
    bloomEnabled: true,
    ssaoEnabled: false,
    maxParticles: 420,
    maxDecals: 48,
    maxZombies: 38,
    grassDensity: 1200,
    fireflyCount: 40,
    anisotropy: 4,
    godRays: false,
    fogDetail: true,
    msaaSamples: 2,
  },
  high: {
    pixelRatioCap: 1.6,
    shadowMapSize: 2048,
    shadowsEnabled: true,
    bloomEnabled: true,
    // GTAO costs a full extra depth+normal pass. It's a luxury, not a
    // requirement for the look, so "high" spends that budget on framerate.
    ssaoEnabled: false,
    maxParticles: 700,
    maxDecals: 80,
    maxZombies: 52,
    grassDensity: 3200,
    fireflyCount: 90,
    anisotropy: 8,
    godRays: true,
    fogDetail: true,
    msaaSamples: 4,
  },
  ultra: {
    pixelRatioCap: 2.0,
    shadowMapSize: 4096,
    shadowsEnabled: true,
    bloomEnabled: true,
    ssaoEnabled: true,
    maxParticles: 1100,
    maxDecals: 120,
    maxZombies: 64,
    grassDensity: 6000,
    fireflyCount: 140,
    anisotropy: 16,
    godRays: true,
    fogDetail: true,
    msaaSamples: 4,
  },
};

type SettingsListener = (settings: GameSettings, changedKey: keyof GameSettings | null) => void;

/**
 * Reactive settings store. Systems subscribe once and react to changes instead
 * of polling, which keeps the hot loop free of settings lookups.
 */
class SettingsStore {
  private data: GameSettings;
  private readonly listeners = new Set<SettingsListener>();

  constructor() {
    this.data = Storage.get<GameSettings>(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
    // Respect the OS-level accessibility preference on first run.
    if (!Storage.get<Partial<GameSettings> | null>(STORAGE_KEYS.settings, null)) {
      const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced) {
        this.data.reducedMotion = true;
        this.data.motionBlur = false;
        this.data.screenShake = 0.25;
      }
    }
  }

  get current(): Readonly<GameSettings> {
    return this.data;
  }

  get quality(): QualityProfile {
    const base = QUALITY_PROFILES[this.data.graphics];
    // Individual toggles override the preset so users can mix and match.
    return {
      ...base,
      shadowsEnabled: base.shadowsEnabled && this.data.shadows,
      bloomEnabled: base.bloomEnabled && this.data.bloom,
    };
  }

  set<K extends keyof GameSettings>(key: K, value: GameSettings[K]): void {
    if (this.data[key] === value) return;
    this.data = { ...this.data, [key]: value };
    Storage.set(STORAGE_KEYS.settings, this.data);
    this.emit(key);
  }

  patch(partial: Partial<GameSettings>): void {
    this.data = { ...this.data, ...partial };
    Storage.set(STORAGE_KEYS.settings, this.data);
    this.emit(null);
  }

  reset(): void {
    this.data = { ...DEFAULT_SETTINGS };
    Storage.set(STORAGE_KEYS.settings, this.data);
    this.emit(null);
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(key: keyof GameSettings | null): void {
    for (const listener of this.listeners) listener(this.data, key);
  }
}

export const settings = new SettingsStore();

/** Rough device capability sniff used to pick a sensible first-run preset. */
export function detectRecommendedPreset(): GraphicsPreset {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (mobile) return 'low';
  if (cores >= 12 && mem >= 8) return 'ultra';
  if (cores >= 8 && mem >= 8) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}
