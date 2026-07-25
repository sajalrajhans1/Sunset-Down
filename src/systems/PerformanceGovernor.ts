import { settings, type GraphicsPreset } from '../game/Settings';

export interface GovernorTargets {
  /** Called with the render scale to apply, 0.5 .. 1.0 of the quality cap. */
  onRenderScale: (scale: number) => void;
  /** Called when the governor decides the whole preset must drop. */
  onPresetChange: (preset: GraphicsPreset) => void;
}

const PRESET_ORDER: GraphicsPreset[] = ['low', 'medium', 'high', 'ultra'];

/**
 * Keeps the frame rate playable on hardware we've never seen.
 *
 * Two levers, applied in order of how much they hurt:
 *
 *  1. **Render scale** — a continuous 0.55..1.0 multiplier on the drawing
 *     buffer. Cheap to change, reversible, and by far the biggest single win
 *     because almost everything here is fragment-bound (bloom, the grade pass,
 *     the ground). Adjusted gently, in small steps.
 *  2. **Graphics preset** — only after render scale has bottomed out and the
 *     frame time is *still* bad. This is a visible change, so it needs strong
 *     evidence before firing.
 *
 * The measurement deliberately uses a median rather than a mean: a single
 * 200 ms hitch from a GC pause or a shader compile shouldn't convince the
 * governor that the machine is slow.
 */
export class PerformanceGovernor {
  private readonly samples: number[] = [];
  private static readonly SAMPLE_SIZE = 45;

  /** Current multiplier on the preset's pixel-ratio cap. */
  private renderScale = 1;
  private static readonly MIN_SCALE = 0.55;
  private static readonly MAX_SCALE = 1;

  /** Frame-time budgets in milliseconds. */
  private static readonly TARGET_MS = 16.7;
  private static readonly BAD_MS = 22;
  private static readonly GOOD_MS = 13.5;

  private cooldown = 0;
  private downgradeStreak = 0;
  private enabled = true;

  /** Frames to ignore after a change, while the pipeline re-settles. */
  private static readonly COOLDOWN = 1.2;

  constructor(private readonly targets: GovernorTargets) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Resets measurement — call when the scene changes substantially. */
  reset(): void {
    this.samples.length = 0;
    this.cooldown = PerformanceGovernor.COOLDOWN;
  }

  get currentScale(): number {
    return this.renderScale;
  }

  update(dt: number, frameMs: number): void {
    if (!this.enabled) return;

    // Ignore absurd frames entirely: alt-tab, breakpoint, tab throttling.
    if (frameMs > 200 || frameMs <= 0) return;

    this.samples.push(frameMs);
    if (this.samples.length > PerformanceGovernor.SAMPLE_SIZE) this.samples.shift();

    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    if (this.samples.length < PerformanceGovernor.SAMPLE_SIZE) return;

    const median = this.median();

    if (median > PerformanceGovernor.BAD_MS) {
      this.stepDown(median);
    } else if (median < PerformanceGovernor.GOOD_MS) {
      this.stepUp();
    } else {
      // Comfortably inside the target band; forget any pending downgrade.
      this.downgradeStreak = 0;
    }
  }

  private median(): number {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private stepDown(median: number): void {
    // How far past budget are we? A machine at 40 ms needs a bigger cut than
    // one at 23 ms, so scale the step by the overshoot.
    const overshoot = median / PerformanceGovernor.TARGET_MS;
    const step = overshoot > 2 ? 0.15 : overshoot > 1.5 ? 0.1 : 0.06;

    if (this.renderScale > PerformanceGovernor.MIN_SCALE) {
      this.renderScale = Math.max(PerformanceGovernor.MIN_SCALE, this.renderScale - step);
      this.targets.onRenderScale(this.renderScale);
      this.afterChange();
      return;
    }

    // Resolution is already at the floor. Drop the preset, but only after
    // several consecutive bad readings — this one is visible to the player.
    this.downgradeStreak++;
    if (this.downgradeStreak < 3) {
      this.cooldown = PerformanceGovernor.COOLDOWN;
      return;
    }

    const index = PRESET_ORDER.indexOf(settings.current.graphics);
    if (index > 0) {
      const next = PRESET_ORDER[index - 1];
      this.downgradeStreak = 0;
      // Give the lighter preset room to breathe before judging it again.
      this.renderScale = Math.min(1, this.renderScale + 0.2);
      this.targets.onPresetChange(next);
      this.afterChange(2.5);
    }
  }

  private stepUp(): void {
    this.downgradeStreak = 0;
    if (this.renderScale >= PerformanceGovernor.MAX_SCALE) return;
    // Recover slowly: it's far better to sit slightly soft than to oscillate.
    this.renderScale = Math.min(PerformanceGovernor.MAX_SCALE, this.renderScale + 0.04);
    this.targets.onRenderScale(this.renderScale);
    this.afterChange();
  }

  private afterChange(cooldown = PerformanceGovernor.COOLDOWN): void {
    this.samples.length = 0;
    this.cooldown = cooldown;
  }
}
