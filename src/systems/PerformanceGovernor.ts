
export interface GovernorTargets {
  /** Called with the render scale to apply, 0.5 .. 1.0 of the quality cap. */
  onRenderScale: (scale: number) => void;
  /** Called with the fraction of the preset's zombie cap to allow, 0.5 .. 1. */
  onCrowdBudget: (fraction: number) => void;
}

/**
 * Keeps the frame rate playable on hardware we've never seen, without letting
 * the game visibly get worse while someone is playing it.
 *
 * That second half is a deliberate constraint, and it dictates the order of
 * what follows. A player who reaches wave fifteen and finds the picture has
 * quietly turned soft, or the shadows have gone, experiences that as the game
 * breaking - not as a frame rate being rescued. So quality is the *last* thing
 * touched, not the first:
 *
 *  1. **Crowd budget** — a cap on how many zombies may be active at once.
 *     Measured on this scene the zombies are around 90% of the triangles and
 *     over half the draw calls, so this is both the largest win available and
 *     the one nobody reads as a downgrade: a wave with forty bodies instead of
 *     fifty still looks like the game it was a minute ago.
 *  2. **Render scale** — a multiplier on the drawing buffer, floored at 0.8.
 *     Below roughly that the softness becomes obvious, so the floor is set
 *     where it stops being free rather than at the lowest number that helps.
 *
 * The graphics preset is deliberately *never* changed automatically. Shadows
 * switching off or bloom disappearing mid-run is the single most visible thing
 * this could do, and a machine that cannot hold the frame rate at the reduced
 * crowd and resolution is better served by the player picking a lighter preset
 * themselves, once, in Settings.
 *
 * The measurement uses a median rather than a mean: a single 200 ms hitch from
 * a GC pause or a shader compile shouldn't convince the governor that the
 * machine is slow.
 */
export class PerformanceGovernor {
  private readonly samples: number[] = [];
  private static readonly SAMPLE_SIZE = 45;

  /** Current multiplier on the preset's pixel-ratio cap. */
  private renderScale = 1;
  /**
   * Softness below about 0.8 is plainly visible on text and on the high
   * contrast edges of the buildings, so this is set where the saving stops
   * being free rather than at the lowest number that would still help.
   */
  private static readonly MIN_SCALE = 0.8;
  private static readonly MAX_SCALE = 1;

  /** Current fraction of the preset's zombie cap that may be active. */
  private crowdBudget = 1;
  /**
   * Now the first lever rather than the second, so it can go further: a wave
   * of thirty-five instead of fifty reads as a slightly quieter wave, where a
   * soft picture reads as a broken game.
   */
  private static readonly MIN_CROWD = 0.45;

  /** Frame-time budgets in milliseconds. */
  private static readonly TARGET_MS = 16.7;
  private static readonly BAD_MS = 22;
  private static readonly GOOD_MS = 13.5;

  private cooldown = 0;
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

  get currentCrowdBudget(): number {
    return this.crowdBudget;
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
      }
  }

  /**
   * Median frame time, computed into a reused buffer. This runs every frame
   * once the window is full, and allocating a fresh 45-element array each time
   * would be the governor itself generating the collection pauses it exists to
   * smooth out.
   */
  private readonly sortScratch: number[] = [];

  private median(): number {
    const scratch = this.sortScratch;
    scratch.length = 0;
    for (let i = 0; i < this.samples.length; i++) scratch.push(this.samples[i]);
    scratch.sort((a, b) => a - b);
    return scratch[Math.floor(scratch.length / 2)];
  }

  private stepDown(median: number): void {
    // How far past budget are we? A machine at 40 ms needs a bigger cut than
    // one at 23 ms, so scale the step by the overshoot.
    const overshoot = median / PerformanceGovernor.TARGET_MS;
    const step = overshoot > 2 ? 0.15 : overshoot > 1.5 ? 0.1 : 0.06;

    // Thin the horde first. It is the biggest single saving in this scene and
    // the one a player is least likely to read as the game degrading.
    if (this.crowdBudget > PerformanceGovernor.MIN_CROWD) {
      this.crowdBudget = Math.max(PerformanceGovernor.MIN_CROWD, this.crowdBudget - step);
      this.targets.onCrowdBudget(this.crowdBudget);
      this.afterChange();
      return;
    }

    // Only then give up resolution, and only down to a floor where the
    // softness is still hard to notice.
    if (this.renderScale > PerformanceGovernor.MIN_SCALE) {
      this.renderScale = Math.max(PerformanceGovernor.MIN_SCALE, this.renderScale - step);
      this.targets.onRenderScale(this.renderScale);
      this.afterChange();
      return;
    }

    // Both levers are spent. The preset is deliberately left alone: turning
    // shadows or bloom off mid-run is the most visible thing this could do,
    // and a machine this far behind is better served by the player choosing a
    // lighter preset once, deliberately, than by the game changing its own
    // appearance while they are trying to play it.
  }

  private stepUp(): void {

    // Recover in the reverse order: sharpness back first, then the crowd.
    if (this.renderScale < PerformanceGovernor.MAX_SCALE) {
      // Slowly - it is far better to sit slightly soft than to oscillate.
      this.renderScale = Math.min(PerformanceGovernor.MAX_SCALE, this.renderScale + 0.04);
      this.targets.onRenderScale(this.renderScale);
      this.afterChange();
      return;
    }

    if (this.crowdBudget < 1) {
      this.crowdBudget = Math.min(1, this.crowdBudget + 0.05);
      this.targets.onCrowdBudget(this.crowdBudget);
      this.afterChange();
    }
  }

  private afterChange(cooldown = PerformanceGovernor.COOLDOWN): void {
    this.samples.length = 0;
    this.cooldown = cooldown;
  }
}
