import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { GradeShader } from './shaders/GradeShader';
import { RadialBlurShader } from './shaders/RadialBlurShader';
import type { QualityProfile } from '../game/Settings';
import { clamp01, damp } from '../utilities/MathUtils';

/**
 * Post-processing stack.
 *
 * Pipeline order and the colour space at each stage:
 *   RenderPass  -> linear HDR   (Three skips tonemapping when drawing to an RT)
 *   GTAOPass    -> linear HDR   (ambient occlusion, ultra/high only)
 *   Bloom       -> linear HDR   (must run before tonemapping to bloom properly)
 *   OutputPass  -> sRGB display (applies ACES + colour-space conversion)
 *   RadialBlur  -> sRGB display
 *   GradePass   -> sRGB display, renders to screen
 */
export class PostFX {
  readonly composer: EffectComposer;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly outputPass: OutputPass;
  private readonly blurPass: ShaderPass;
  private readonly gradePass: ShaderPass;
  private gtaoPass: GTAOPass | null = null;

  private enabled = true;
  private width = 1;
  private height = 1;
  private samples = 0;

  // Transient effect state, smoothed toward targets every frame.
  private damageTarget = 0;
  private damageCurrent = 0;
  private flashCurrent = 0;
  private motionTarget = 0;
  private motionCurrent = 0;
  private lowHealthTarget = 0;
  private lowHealthCurrent = 0;
  private elapsed = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = Math.max(1, size.x);
    this.height = Math.max(1, size.y);

    // Half-float target preserves HDR headroom so bloom has something to bloom.
    const target = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      samples: 0,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    this.composer = new EffectComposer(renderer, target);
    // EffectComposer multiplies setSize() by its own _pixelRatio, which it
    // copies from the renderer. We already work in drawing-buffer pixels, so
    // leaving that at the device ratio would square it and allocate targets
    // pixelRatio² too large (2.56x the pixels at a 1.6 ratio).
    this.composer.setPixelRatio(1);
    this.composer.setSize(this.width, this.height);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Threshold is in *linear* light, where a correctly-exposed sunlit surface
    // sits near 1.0. Anything below ~1.1 makes ordinary geometry bloom and the
    // whole frame turns to milk.
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      0.32, // strength
      0.55, // radius
      1.15, // threshold — only the sun, bulbs and muzzle flashes qualify
    );
    this.composer.addPass(this.bloomPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.blurPass = new ShaderPass(RadialBlurShader);
    this.composer.addPass(this.blurPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.renderToScreen = true;
    this.composer.addPass(this.gradePass);

    this.updateResolutionUniform();
  }

  /** Swaps the camera the render pass uses (menu camera vs. player camera). */
  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
    if (this.gtaoPass) this.gtaoPass.camera = camera as THREE.PerspectiveCamera;
  }

  setScene(scene: THREE.Scene): void {
    this.renderPass.scene = scene;
    if (this.gtaoPass) this.gtaoPass.scene = scene;
  }

  /** Reconfigures the stack for a quality preset. Called on settings change. */
  applyQuality(profile: QualityProfile, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.bloomPass.enabled = profile.bloomEnabled;

    const wantsAo = profile.ssaoEnabled;
    if (wantsAo && !this.gtaoPass) {
      // Inserted directly after the render pass so AO multiplies into the beauty
      // buffer before bloom samples it.
      const pass = new GTAOPass(scene, camera, this.width, this.height);
      pass.output = GTAOPass.OUTPUT.Default;
      pass.blendIntensity = 0.85;
      pass.updateGtaoMaterial({
        radius: 0.32,
        distanceExponent: 1.6,
        thickness: 0.6,
        scale: 1.0,
        samples: 12,
        screenSpaceRadius: false,
      });
      pass.setSize(this.width, this.height);
      this.composer.insertPass(pass, 1);
      this.gtaoPass = pass;
    } else if (!wantsAo && this.gtaoPass) {
      this.composer.removePass(this.gtaoPass);
      this.gtaoPass.dispose();
      this.gtaoPass = null;
    } else if (this.gtaoPass) {
      this.gtaoPass.scene = scene;
      this.gtaoPass.camera = camera;
    }

    // Cheaper presets also drop the grain and aberration cost.
    const grade = this.gradePass.uniforms;
    grade.uGrain.value = profile.fogDetail ? 0.016 : 0.0;
    grade.uAberration.value = profile.bloomEnabled ? 0.0011 : 0.0;
  }

  /**
   * Sets MSAA sample count on the composer's render targets.
   *
   * Hardware MSAA in the composer looks considerably better than a
   * post-process AA filter on the hard, stylised edges this art style is full
   * of. Changing it requires rebuilding the targets, so it only happens when
   * the graphics preset changes.
   */
  setSamples(samples: number): void {
    if (samples === this.samples) return;
    this.samples = samples;

    // Mutate the existing targets in place — never replace them.
    //
    // EffectComposer renders into `writeBuffer`/`readBuffer`, which alias
    // renderTarget1/2 but are separate references. Swapping the renderTarget
    // fields would leave the composer drawing into the old (disposed) targets
    // forever, permanently locked to whatever size they were created at.
    //
    // dispose() only tears down the GL-side framebuffer; Three transparently
    // rebuilds it on next use, picking up the new sample count.
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      target.samples = samples;
      target.dispose();
    }
  }

  setMotionBlurEnabled(enabled: boolean): void {
    this.blurPass.enabled = enabled;
    if (!enabled) this.blurPass.uniforms.uStrength.value = 0;
  }

  setBloomEnabled(enabled: boolean): void {
    this.bloomPass.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.composer.setSize(this.width, this.height);
    this.bloomPass.setSize(this.width, this.height);
    this.gtaoPass?.setSize(this.width, this.height);
    this.updateResolutionUniform();
  }

  private updateResolutionUniform(): void {
    (this.gradePass.uniforms.uResolution.value as THREE.Vector2).set(this.width, this.height);
  }

  // -------------------------------------------------------------------------
  // Effect triggers — called by gameplay systems
  // -------------------------------------------------------------------------

  /** 0..1 red edge overlay. Decays automatically. */
  pulseDamage(amount: number): void {
    this.damageTarget = clamp01(Math.max(this.damageTarget, amount));
    this.damageCurrent = Math.max(this.damageCurrent, this.damageTarget);
  }

  /** One-shot full-screen flash. */
  flash(amount: number, color: THREE.ColorRepresentation = 0xffffff): void {
    this.flashCurrent = Math.max(this.flashCurrent, clamp01(amount));
    (this.gradePass.uniforms.uFlashColor.value as THREE.Color).set(color);
  }

  /** Continuous 0..1 signal from camera angular velocity + sprint. */
  setMotionAmount(amount: number): void {
    this.motionTarget = clamp01(amount);
  }

  /** Continuous 0..1 signal: how close the player is to death. */
  setLowHealth(amount: number): void {
    this.lowHealthTarget = clamp01(amount);
  }

  /** Aim-down-sights and menu blur focus point, in 0..1 screen space. */
  setBlurCenter(x: number, y: number): void {
    (this.blurPass.uniforms.uCenter.value as THREE.Vector2).set(x, y);
  }

  setGradeIntensity(saturation: number, contrast: number, vignette: number): void {
    this.gradePass.uniforms.uSaturation.value = saturation;
    this.gradePass.uniforms.uContrast.value = contrast;
    this.gradePass.uniforms.uVignette.value = vignette;
  }

  // -------------------------------------------------------------------------

  render(dt: number): void {
    this.elapsed += dt;

    // Damage overlay: snaps on, fades out over ~0.6s.
    this.damageTarget = Math.max(0, this.damageTarget - dt * 2.2);
    this.damageCurrent = damp(this.damageCurrent, this.damageTarget, 9, dt);

    this.flashCurrent = Math.max(0, this.flashCurrent - dt * 3.6);
    this.motionCurrent = damp(this.motionCurrent, this.motionTarget, 12, dt);
    this.lowHealthCurrent = damp(this.lowHealthCurrent, this.lowHealthTarget, 3.5, dt);

    const grade = this.gradePass.uniforms;
    grade.uTime.value = this.elapsed;
    grade.uDamage.value = this.damageCurrent;
    grade.uFlash.value = this.flashCurrent;
    grade.uLowHealth.value = this.lowHealthCurrent;

    if (this.blurPass.enabled) {
      this.blurPass.uniforms.uStrength.value = this.motionCurrent;
    }

    if (this.enabled) {
      this.composer.render(dt);
    } else {
      this.renderer.render(this.renderPass.scene, this.renderPass.camera);
    }
  }

  dispose(): void {
    this.bloomPass.dispose();
    this.gtaoPass?.dispose();
    this.gradePass.dispose();
    this.blurPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
  }
}
