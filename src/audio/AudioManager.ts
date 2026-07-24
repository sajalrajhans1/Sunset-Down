import * as THREE from 'three';
import { AudioCore } from './AudioCore';
import { MusicEngine } from './MusicEngine';
import { SoundBank } from './SoundBank';
import { settings } from '../game/Settings';

/**
 * Single entry point the rest of the game talks to for anything audible.
 *
 * Owns the audio context, the sound bank and the music engine, keeps the
 * listener in sync with the camera, and wires itself to the settings store so
 * volume sliders take effect immediately.
 */
class AudioManager {
  private core: AudioCore | null = null;
  private bankInstance: SoundBank | null = null;
  private musicInstance: MusicEngine | null = null;
  private initialised = false;

  private readonly forward = new THREE.Vector3();
  private footstepAccumulator = 0;
  private lastHeartbeat = 0;

  /**
   * Lazily constructs the audio graph. Deliberately not done at module load —
   * creating an AudioContext before a user gesture triggers console warnings
   * and leaves a suspended context lying around.
   */
  init(): void {
    if (this.initialised) return;
    try {
      this.core = new AudioCore();
      this.bankInstance = new SoundBank(this.core);
      this.musicInstance = new MusicEngine(this.core);
      this.initialised = true;

      this.applyVolumes();
      settings.subscribe((_, key) => {
        if (key === null || key === 'musicVolume' || key === 'sfxVolume') this.applyVolumes();
      });
    } catch (error) {
      // Audio is a nice-to-have: a failure here must never break the game.
      console.warn('[AudioManager] Web Audio unavailable — running silent.', error);
      this.initialised = false;
    }
  }

  private applyVolumes(): void {
    if (!this.core) return;
    this.core.setBusVolume('sfx', settings.current.sfxVolume);
    this.core.setBusVolume('music', settings.current.musicVolume);
  }

  async resume(): Promise<void> {
    this.init();
    await this.core?.resume();
  }

  get ready(): boolean {
    return this.initialised && this.core !== null;
  }

  /** Sound effects. Returns a no-op stub before init so callers never null-check. */
  get sfx(): SoundBank {
    if (!this.bankInstance) {
      this.init();
    }
    return this.bankInstance ?? (SILENT_BANK as unknown as SoundBank);
  }

  get music(): MusicEngine {
    if (!this.musicInstance) this.init();
    return this.musicInstance ?? (SILENT_MUSIC as unknown as MusicEngine);
  }

  /** Keeps positional audio aligned with the camera. Called once per frame. */
  updateListener(camera: THREE.Camera): void {
    if (!this.bankInstance) return;
    camera.getWorldDirection(this.forward);
    this.bankInstance.setListener({
      x: camera.position.x,
      z: camera.position.z,
      forwardX: this.forward.x,
      forwardZ: this.forward.z,
    });
  }

  /**
   * Distance-based footstep cadence. Driven by distance travelled rather than
   * time, so steps stay in sync whether walking, sprinting or crouching.
   */
  updateFootsteps(distanceThisFrame: number, onGround: boolean, surface: 'grass' | 'stone', sprinting: boolean): void {
    if (!onGround) {
      this.footstepAccumulator = 1.4;
      return;
    }
    this.footstepAccumulator += distanceThisFrame;
    const stride = sprinting ? 2.05 : 1.6;
    if (this.footstepAccumulator >= stride) {
      this.footstepAccumulator = 0;
      this.sfx.footstep(surface, sprinting ? 1.25 : 0.9);
    }
  }

  /** Rate-limited heartbeat while critically wounded. */
  updateHeartbeat(healthFraction: number, elapsed: number): void {
    if (healthFraction > 0.3) return;
    // Beats faster the closer to death you are.
    const interval = 0.55 + healthFraction * 1.6;
    if (elapsed - this.lastHeartbeat < interval) return;
    this.lastHeartbeat = elapsed;
    this.sfx.heartbeat();
  }

  dispose(): void {
    this.musicInstance?.dispose();
    void this.core?.context.close().catch(() => undefined);
    this.core = null;
    this.bankInstance = null;
    this.musicInstance = null;
    this.initialised = false;
  }
}

/**
 * Null-object fallbacks used when Web Audio is unavailable. Every method the
 * game calls exists and does nothing, so no call site needs a guard.
 */
const SILENT_BANK = new Proxy(
  {},
  { get: () => () => undefined },
);

const SILENT_MUSIC = new Proxy(
  {},
  { get: () => () => undefined },
);

export const audio = new AudioManager();
