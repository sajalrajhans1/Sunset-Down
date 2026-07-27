import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import bossModelUrl from '../assets/boss-matriarch.glb';
import { applyStylizedShading } from '../textures/StylizedMaterial';
import type { ZombieTypeDef } from './ZombieTypes';
import type { ZombieAnimationState, ZombieVisual } from './ZombieVisual';
import { clamp01 } from '../utilities/MathUtils';

/**
 * The boss body: a sculpted character mesh, animated as a single rigid object.
 *
 * Unlike the rank-and-file zombies this model has no skeleton, so there are no
 * limbs to pose. Everything readable about her movement therefore has to come
 * from how the *whole* body is thrown around — and for something this size that
 * works in its favour. A giant does not jog; it transfers weight. The gait here
 * is built from a heavy vertical drop on each footfall, a slow roll from hip to
 * hip, and a counter-twist through the shoulders, which together read as a
 * deliberate stomp rather than a statue sliding along the ground.
 *
 * She is deliberately far larger than any other class — see BOSS_HEIGHT.
 */

/**
 * Standing height in metres. The player's eye sits at 1.68 m, so at this size
 * she reads as roughly three and a half times their height and has to be looked
 * up at. The previous boss stood about 4 m.
 */
const BOSS_HEIGHT = 5.6;

/** Hit radius. Matched to the old boss so navigation behaves identically. */
const BOSS_RADIUS = 1.5;

/**
 * Head size as a fraction of standing height. The centre is then derived from
 * the top of the actual mesh rather than guessed, so the headshot sphere sits
 * on the skull instead of floating near it.
 */
const HEAD_RADIUS_RATIO = 0.062;

interface BossTemplate {
  scene: THREE.Group;
  /** Multiplier that takes the raw model to BOSS_HEIGHT. */
  normalizeScale: number;
  /** Lift needed to put her feet on y = 0. */
  footOffset: number;
  /** Head centre and size in world metres, at BOSS_HEIGHT. */
  headHeight: number;
  headRadius: number;
}

let template: BossTemplate | null = null;
let templatePromise: Promise<BossTemplate> | null = null;

/**
 * Loads and prepares the shared boss mesh. Called once during the loading
 * screen; each boss instance shares the geometry and clones only materials.
 */
export function loadBossModel(): Promise<BossTemplate> {
  if (templatePromise) return templatePromise;

  templatePromise = new Promise<BossTemplate>((resolve, reject) => {
    const loader = new GLTFLoader();
    // The asset is meshopt-compressed: 625 kB instead of 14 MB, but it will not
    // parse at all without the decoder registered.
    loader.setMeshoptDecoder(MeshoptDecoder);

    loader.load(
      bossModelUrl,
      (gltf) => {
        const scene = gltf.scene;
        scene.updateMatrixWorld(true);

        // Vertex positions are quantised, so the glTF accessor min/max cannot
        // be trusted — measure the decoded geometry instead.
        const box = new THREE.Box3().setFromObject(scene);
        const height = Math.max(0.001, box.max.y - box.min.y);
        const normalizeScale = BOSS_HEIGHT / height;
        const footOffset = -box.min.y;

        // Measured off the top of the mesh, the same way the regular zombies
        // do it, so hair or a hood does not push the hit sphere off the skull.
        const headRadius = BOSS_HEIGHT * HEAD_RADIUS_RATIO;
        const headHeight = BOSS_HEIGHT - headRadius * 1.15;

        scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          // The body is animated as a rigid object whose bounds Three.js cannot
          // see through the parent transforms, so per-mesh culling would pop
          // her out of view mid-stride.
          mesh.frustumCulled = false;
        });

        template = { scene, normalizeScale, footOffset, headHeight, headRadius };

        if (import.meta.env.DEV) {
          let triangles = 0;
          scene.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh || !mesh.geometry.index) return;
            triangles += mesh.geometry.index.count / 3;
          });
          console.info(
            '[Boss model] raw=%s scale=%s → %sm tall, head y=%s r=%s, %d triangles',
            height.toFixed(3),
            normalizeScale.toFixed(2),
            BOSS_HEIGHT,
            headHeight.toFixed(2),
            headRadius.toFixed(2),
            triangles,
          );
        }

        resolve(template);
      },
      undefined,
      (error) => reject(error),
    );
  });

  return templatePromise;
}

export function isBossModelReady(): boolean {
  return template !== null;
}

export class GlbBossVisual implements ZombieVisual {
  readonly root = new THREE.Group();

  /** Holds the normalising scale and the foot offset. */
  private readonly orient = new THREE.Group();
  /** Everything the animation moves. Kept separate so scale never fights pose. */
  private readonly sway = new THREE.Group();
  private readonly model: THREE.Object3D;

  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly baseEmissive: THREE.Color[] = [];
  private readonly meshes: THREE.Mesh[] = [];

  bodyColor = 0x43558f;
  headHeight: number;
  bodyRadius = BOSS_RADIUS;
  headRadius: number;

  private hitFlash = 0;
  private primingGlow = 0;
  private restY = 0;
  /**
   * Metres-to-model-units. The animated group sits inside the normalising
   * scale, so every offset written below in metres has to be divided back down
   * or it gets multiplied by ~5.6 and she bobs a metre per step.
   */
  private readonly perMetre: number;

  constructor() {
    if (!template) {
      throw new Error('Boss model requested before loadBossModel() resolved.');
    }

    // Geometry and textures are shared; only the material wrapper is per-boss.
    this.model = template.scene.clone(true);
    this.restY = template.footOffset;
    this.perMetre = 1 / template.normalizeScale;
    this.headHeight = template.headHeight;
    this.headRadius = template.headRadius;

    this.sway.position.y = this.restY;
    this.sway.add(this.model);

    this.orient.scale.setScalar(template.normalizeScale);
    this.orient.add(this.sway);
    this.root.add(this.orient);

    this.cloneMaterials();
  }

  /**
   * Per-instance materials so a hit flash lights up one boss, not the template.
   *
   * The source mesh is a realistic scan, which would sit oddly in a village
   * built out of flat painted shapes. Pushing it through the same stylised
   * shading as everything else — cold rim light, banded falloff — pulls it into
   * the same world rather than leaving it looking pasted on.
   */
  private cloneMaterials(): void {
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.meshes.push(mesh);

      const source = mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
      const list = Array.isArray(source) ? source : [source];
      const cloned = list.map((material) => {
        const copy = material.clone() as THREE.MeshStandardMaterial;
        copy.roughness = Math.max(0.65, copy.roughness);
        copy.metalness = 0;
        applyStylizedShading(copy, {
          // Colder and stronger than the regular zombies: she should read as
          // lit by something other than the village's sunset.
          rimColor: 0x9fc4ff,
          rimStrength: 0.7,
          rimPower: 2.2,
          subsurfaceStrength: 0,
        });
        this.materials.push(copy);
        this.baseEmissive.push(copy.emissive.clone());
        return copy;
      });

      mesh.material = Array.isArray(source) ? cloned : cloned[0];
    });
  }

  applyType(def: ZombieTypeDef, colorIndex: number): void {
    this.bodyColor = def.colors[colorIndex % def.colors.length];

    // Only a light tint: the painted detail in the texture is the point, and
    // washing it out would lose the silhouette's read at distance.
    const tint = new THREE.Color(this.bodyColor).lerp(new THREE.Color(0xffffff), 0.78);
    for (let i = 0; i < this.materials.length; i++) {
      this.materials[i].color.copy(tint);
      this.materials[i].emissive.copy(this.baseEmissive[i]);
      this.materials[i].emissiveIntensity = 1;
    }

    this.headHeight = template!.headHeight;
    this.headRadius = template!.headRadius;
    this.bodyRadius = BOSS_RADIUS;

    this.resetPose();
  }

  /**
   * Poses the body for this frame.
   *
   * With no skeleton, the whole character is the only thing that can move, so
   * the gait is expressed as weight rather than footsteps: she drops onto each
   * foot, rolls across to the other hip, and her shoulders counter-twist.
   */
  animate(state: ZombieAnimationState): void {
    const { sway } = this;

    if (state.deathProgress > 0) {
      this.animateDeath(state.deathProgress);
      return;
    }

    const phase = state.gaitPhase + state.phaseOffset;
    const stride = clamp01(state.stride);
    const m = this.perMetre;

    // Two footfalls per gait cycle. |sin| gives the sharp landing and slow
    // recovery of something heavy, where a plain sine would just float.
    const footfall = Math.abs(Math.sin(phase));
    const walkDrop = -footfall * 0.17 * stride * m;
    // She never fully settles, even standing still.
    const breathe = Math.sin(state.elapsed * 1.1 + state.phaseOffset) * 0.04 * (1 - stride) * m;

    // Weight rolling from hip to hip, at half the footfall rate.
    const roll = Math.sin(phase * 0.5) * 0.075 * stride;
    const twist = Math.sin(phase * 0.5 + Math.PI * 0.5) * 0.09 * stride;
    let lean = stride * 0.13;

    let lunge = 0;
    if (state.attackWindup > 0 && state.attackWindupDuration > 0) {
      // Rear back over the windup, so the slam that follows has somewhere to
      // come from and the player gets a full beat of warning.
      const windup = clamp01(state.attackWindup / state.attackWindupDuration);
      lean -= windup * 0.42;
      lunge = -windup * 0.35 * m;
    } else if (state.isAttacking) {
      lean += 0.5;
      lunge = 0.9 * m;
    }

    sway.position.y = this.restY + walkDrop + breathe;
    sway.position.z = lunge;
    sway.rotation.set(lean, twist, roll);

    // Head tracking is the one articulation available without bones: turning
    // the whole upper body toward the player.
    sway.rotation.y += THREE.MathUtils.clamp(state.lookOffset, -0.5, 0.5) * 0.35;
  }

  /** Topples forward and sinks, so a kill lands with some weight. */
  private animateDeath(progress: number): void {
    const t = clamp01(progress);
    const fall = Math.min(1, t * 1.6);
    // Ease-out: she tips slowly, then drops.
    const eased = 1 - (1 - fall) * (1 - fall);

    const m = this.perMetre;
    this.sway.rotation.set(eased * Math.PI * 0.5, this.sway.rotation.y, eased * 0.25);
    // Drops, then sinks through the ground so the body never lies there.
    this.sway.position.y = this.restY - (eased * 0.5 + Math.max(0, t - 0.75) * 12) * m;
    this.sway.position.z = eased * 0.8 * m;

    // Fade out over the last quarter rather than vanishing on a frame.
    const fade = 1 - clamp01((t - 0.7) / 0.3);
    for (const material of this.materials) {
      material.transparent = fade < 1;
      material.opacity = fade;
    }
  }

  setHitFlash(amount: number): void {
    if (amount === this.hitFlash) return;
    this.hitFlash = amount;
    this.refreshEmissive();
  }

  setPrimingGlow(amount: number): void {
    if (amount === this.primingGlow) return;
    this.primingGlow = amount;
    this.refreshEmissive();
  }

  private refreshEmissive(): void {
    const flash = Math.max(this.hitFlash, this.primingGlow);
    for (let i = 0; i < this.materials.length; i++) {
      const material = this.materials[i];
      material.emissive.copy(this.baseEmissive[i]).lerp(new THREE.Color(0xffffff), flash);
      material.emissiveIntensity = 1 + flash * 2.2;
    }
  }

  setShadowsEnabled(enabled: boolean): void {
    for (const mesh of this.meshes) mesh.castShadow = enabled;
  }

  setLod(level: number): void {
    // A single mesh has nothing to drop, but a distant boss does not need to
    // pay for a shadow map pass.
    for (const mesh of this.meshes) mesh.castShadow = level < 2;
  }

  resetPose(): void {
    this.sway.position.set(0, this.restY, 0);
    this.sway.rotation.set(0, 0, 0);
    this.hitFlash = 0;
    this.primingGlow = 0;
    for (let i = 0; i < this.materials.length; i++) {
      this.materials[i].transparent = false;
      this.materials[i].opacity = 1;
      this.materials[i].emissive.copy(this.baseEmissive[i]);
      this.materials[i].emissiveIntensity = 1;
    }
  }

  dispose(): void {
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.meshes.length = 0;
  }
}
