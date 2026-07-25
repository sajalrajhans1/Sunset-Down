import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import zombieModelUrl from '../assets/zombie.glb';
import { applyStylizedShading } from '../textures/StylizedMaterial';
import { clamp01, lerp } from '../utilities/MathUtils';
import type { ZombieTypeDef } from './ZombieTypes';
import type { ZombieAnimationState, ZombieVisual } from './ZombieVisual';

/**
 * Skinned glTF zombie.
 *
 * The supplied model is a Valve Biped (Source engine) rig with a full humanoid
 * hierarchy but **no baked animation clips**, so every pose in the game —
 * shamble, sprint, attack swing, collapse — is authored here procedurally by
 * rotating bones.
 *
 * Two details make that robust without ever hard-coding the exporter's
 * conventions:
 *
 *  1. **Facing is derived from the skeleton.** The vector from the right thigh
 *     to the left thigh gives the character's left; forward is `left × up`.
 *     A corrective yaw then guarantees the model faces +Z, which is what the
 *     rest of the game assumes.
 *  2. **Rotation axes are derived per bone.** Each animated bone stores the
 *     model-space X/Y/Z axes expressed in *its own parent's* space, so a swing
 *     is always a swing regardless of how that joint's rest orientation was
 *     authored.
 */

// --- Shared template ---------------------------------------------------------

interface ZombieTemplate {
  scene: THREE.Group;
  /** Scale that normalises the model to TARGET_HEIGHT metres. */
  normalizeScale: number;
  /** Corrective yaw, in radians, that turns the model to face +Z. */
  facingCorrection: number;
  /** Head height in normalised units. */
  headHeight: number;
}

/** Height of a zombie at class scale 1.0, in metres. */
const TARGET_HEIGHT = 1.6;

let templatePromise: Promise<ZombieTemplate> | null = null;
let template: ZombieTemplate | null = null;

/** Bone lookup keys. Matched as substrings so the numeric suffixes don't matter. */
const BONE_KEYS = {
  pelvis: 'Bip01_Pelvis',
  spine: 'Bip01_Spine_',
  spine1: 'Bip01_Spine1',
  spine2: 'Bip01_Spine2',
  spine4: 'Bip01_Spine4',
  neck: 'Bip01_Neck1',
  head: 'Bip01_Head1',
  thighL: 'Bip01_L_Thigh',
  calfL: 'Bip01_L_Calf',
  footL: 'Bip01_L_Foot',
  thighR: 'Bip01_R_Thigh',
  calfR: 'Bip01_R_Calf',
  footR: 'Bip01_R_Foot',
  clavicleL: 'Bip01_L_Clavicle',
  upperArmL: 'Bip01_L_UpperArm',
  forearmL: 'Bip01_L_Forearm',
  handL: 'Bip01_L_Hand',
  clavicleR: 'Bip01_R_Clavicle',
  upperArmR: 'Bip01_R_UpperArm',
  forearmR: 'Bip01_R_Forearm',
  handR: 'Bip01_R_Hand',
} as const;

type BoneKey = keyof typeof BONE_KEYS;

/**
 * Loads and prepares the shared model. Called once during the loading screen;
 * every zombie instance is a skeleton clone of this template.
 */
export function loadZombieModel(): Promise<ZombieTemplate> {
  if (templatePromise) return templatePromise;

  templatePromise = new Promise<ZombieTemplate>((resolve, reject) => {
    new GLTFLoader().load(
      zombieModelUrl,
      (gltf) => {
        const scene = gltf.scene;
        scene.updateMatrixWorld(true);

        // --- Normalise size from the real bounding box ---------------------
        // Positions are quantised in the optimised file, so the glTF accessor
        // min/max are unusable; measure the decoded geometry instead.
        const box = new THREE.Box3().setFromObject(scene);
        const height = Math.max(0.001, box.max.y - box.min.y);
        const normalizeScale = TARGET_HEIGHT / height;

        // --- Derive facing from the hips -----------------------------------
        const thighL = findBone(scene, BONE_KEYS.thighL);
        const thighR = findBone(scene, BONE_KEYS.thighR);
        let facingCorrection = 0;

        if (thighL && thighR) {
          const left = new THREE.Vector3().subVectors(
            thighL.getWorldPosition(new THREE.Vector3()),
            thighR.getWorldPosition(new THREE.Vector3()),
          );
          left.y = 0;
          if (left.lengthSq() > 1e-8) {
            left.normalize();
            // forward = left x up
            const forward = new THREE.Vector3().crossVectors(left, new THREE.Vector3(0, 1, 0)).normalize();
            // Rotate so that forward becomes +Z.
            facingCorrection = -Math.atan2(forward.x, forward.z);
          }
        } else {
          console.warn('[Zombie] Hip bones not found — falling back to default facing.');
        }

        // Feet should rest on y = 0 after scaling.
        const footOffset = -box.min.y * normalizeScale;

        const head = findBone(scene, BONE_KEYS.head);
        const headWorldY = head ? head.getWorldPosition(new THREE.Vector3()).y : height * 0.88;
        const headHeight = (headWorldY - box.min.y) * normalizeScale;

        scene.position.y = footOffset / normalizeScale;

        scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          // Skinned characters are animated every frame; per-object culling
          // against a stale bounding volume causes them to vanish mid-stride.
          mesh.frustumCulled = false;
        });

        template = { scene, normalizeScale, facingCorrection, headHeight };

        if (import.meta.env.DEV) {
          // Verifying the derived rig is far easier from a log than from the
          // render, especially the facing correction.
          const resolved = (Object.keys(BONE_KEYS) as BoneKey[]).filter((key) =>
            findBone(scene, BONE_KEYS[key]),
          );
          console.info(
            '[Zombie model] height=%s scale=%s facing=%s° bones=%d/%d%s',
            height.toFixed(3),
            normalizeScale.toFixed(3),
            THREE.MathUtils.radToDeg(facingCorrection).toFixed(1),
            resolved.length,
            Object.keys(BONE_KEYS).length,
            resolved.length < Object.keys(BONE_KEYS).length
              ? ` MISSING: ${(Object.keys(BONE_KEYS) as BoneKey[]).filter((k) => !resolved.includes(k)).join(', ')}`
              : '',
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

export function isZombieModelReady(): boolean {
  return template !== null;
}

function findBone(root: THREE.Object3D, key: string): THREE.Bone | null {
  let found: THREE.Bone | null = null;
  root.traverse((object) => {
    if (found) return;
    if (object.name.includes(key)) found = object as THREE.Bone;
  });
  return found;
}

// --- Per-bone animation data -------------------------------------------------

interface BoneRig {
  bone: THREE.Bone;
  restQuaternion: THREE.Quaternion;
  /** Model-space X axis expressed in this bone's parent space. */
  axisX: THREE.Vector3;
  /** Model-space Y axis expressed in this bone's parent space. */
  axisY: THREE.Vector3;
  /** Model-space Z axis expressed in this bone's parent space. */
  axisZ: THREE.Vector3;
}

const _q = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _inverse = new THREE.Quaternion();

export class GlbZombieVisual implements ZombieVisual {
  readonly root = new THREE.Group();

  private readonly orient = new THREE.Group();
  private readonly model: THREE.Group;
  private readonly bones = new Map<BoneKey, BoneRig>();
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly baseEmissive: THREE.Color[] = [];
  private readonly meshes: THREE.Mesh[] = [];

  private readonly restPelvisY: number;
  private normalizeScale = 1;

  bodyColor = 0x7d9c6e;
  headHeight = 1.5;
  bodyRadius = 0.42;

  private lod = 0;
  private frameCounter = 0;
  private hitFlash = 0;
  private primingGlow = 0;
  private def: ZombieTypeDef | null = null;

  constructor() {
    if (!template) {
      throw new Error('Zombie model requested before loadZombieModel() resolved.');
    }

    this.normalizeScale = template.normalizeScale;

    // SkeletonUtils.clone duplicates the node hierarchy and rebinds a fresh
    // skeleton while sharing geometry — exactly what pooled characters need.
    this.model = cloneSkinned(template.scene) as THREE.Group;

    this.orient.rotation.y = template.facingCorrection;
    this.orient.add(this.model);
    this.root.add(this.orient);

    this.cloneMaterials();
    this.model.updateMatrixWorld(true);
    this.captureRig();

    const pelvis = this.bones.get('pelvis');
    this.restPelvisY = pelvis ? pelvis.bone.position.y : 0;
    this.headHeight = template.headHeight;
  }

  /**
   * Gives this instance its own materials so hit flashes and class tints stay
   * local. Textures and compiled programs are still shared.
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
        // Cold rim so the zombies never look lit by the village's warm sunset.
        applyStylizedShading(copy, {
          rimColor: 0xa8d8ff,
          rimStrength: 0.45,
          rimPower: 2.8,
          subsurfaceStrength: 0,
        });
        this.materials.push(copy);
        this.baseEmissive.push(copy.emissive.clone());
        return copy;
      });

      mesh.material = Array.isArray(source) ? cloned : cloned[0];
    });
  }

  /**
   * Records each animated bone's rest rotation and the model-space axes
   * expressed in its parent's frame, so later rotations are orientation-safe.
   */
  private captureRig(): void {
    for (const key of Object.keys(BONE_KEYS) as BoneKey[]) {
      const bone = findBone(this.model, BONE_KEYS[key]);
      if (!bone) continue;

      const parent = bone.parent;
      _parentQuat.identity();
      if (parent) parent.getWorldQuaternion(_parentQuat);
      _inverse.copy(_parentQuat).invert();

      this.bones.set(key, {
        bone,
        restQuaternion: bone.quaternion.clone(),
        axisX: new THREE.Vector3(1, 0, 0).applyQuaternion(_inverse).normalize(),
        axisY: new THREE.Vector3(0, 1, 0).applyQuaternion(_inverse).normalize(),
        axisZ: new THREE.Vector3(0, 0, 1).applyQuaternion(_inverse).normalize(),
      });
    }
  }

  /** Rotates a bone about a model-space axis, relative to its rest pose. */
  private rotate(key: BoneKey, axis: 'x' | 'y' | 'z', angle: number, additive = false): void {
    const rig = this.bones.get(key);
    if (!rig) return;
    const vector = axis === 'x' ? rig.axisX : axis === 'y' ? rig.axisY : rig.axisZ;
    _q.setFromAxisAngle(vector, angle);
    if (additive) rig.bone.quaternion.premultiply(_q);
    else rig.bone.quaternion.copy(rig.restQuaternion).premultiply(_q);
  }

  // -------------------------------------------------------------------------

  applyType(def: ZombieTypeDef, colorIndex: number): void {
    this.def = def;
    const p = def.proportions;

    // Class silhouette comes from non-uniform scale, since one mesh has to
    // serve a lanky sprinter and a bulky bruiser alike.
    const scale = this.normalizeScale * def.scale;
    this.orient.scale.set(
      scale * lerp(1, p.bodyWidth, 0.55),
      scale * lerp(1, p.bodyHeight, 0.4),
      scale * lerp(1, p.bodyWidth, 0.55),
    );

    const color = def.colors[colorIndex % def.colors.length];
    this.bodyColor = color;

    // Tint toward the class colour while keeping the painted texture readable.
    const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45);
    for (let i = 0; i < this.materials.length; i++) {
      this.materials[i].color.copy(tint);
      this.materials[i].emissive.copy(this.baseEmissive[i]);
      this.materials[i].emissiveIntensity = 1;
    }

    const effectiveHeight = TARGET_HEIGHT * def.scale * lerp(1, p.bodyHeight, 0.4);
    this.headHeight = (template!.headHeight / TARGET_HEIGHT) * effectiveHeight;
    this.bodyRadius = 0.3 * def.scale * lerp(1, p.bodyWidth, 0.55);

    this.resetPose();
  }

  resetPose(): void {
    for (const rig of this.bones.values()) rig.bone.quaternion.copy(rig.restQuaternion);
    const pelvis = this.bones.get('pelvis');
    if (pelvis) pelvis.bone.position.y = this.restPelvisY;
  }

  // -------------------------------------------------------------------------
  // Animation
  // -------------------------------------------------------------------------

  animate(state: ZombieAnimationState): void {
    // Distant zombies re-pose less often. Skinning a 114-bone skeleton is the
    // dominant per-zombie CPU cost, and nobody can see a 20 Hz walk cycle at
    // fifty metres.
    this.frameCounter++;
    if (this.lod === 2 && this.frameCounter % 3 !== 0) return;
    if (this.lod === 1 && this.frameCounter % 2 !== 0) return;

    if (state.deathProgress > 0) {
      this.poseDeath(state);
      return;
    }

    const def = this.def;
    const wobble = def ? def.gaitWobble : 1;
    const phase = state.gaitPhase + state.phaseOffset;
    const stride = clamp01(state.stride);

    const swing = Math.sin(phase);
    const swing2 = Math.sin(phase * 2);
    // A limp: one leg drives harder than the other, which instantly reads as
    // "not a healthy person walking".
    const limp = 1 + Math.sin(phase) * 0.18 * wobble;

    // --- Legs -------------------------------------------------------------
    const legAmp = lerp(0.25, 0.95, stride);
    this.rotate('thighL', 'x', swing * legAmp * limp);
    this.rotate('thighR', 'x', -swing * legAmp);

    // Knees only bend one way. Drive each calf from the half of the cycle
    // where that leg is trailing.
    const kneeAmp = lerp(0.2, 1.25, stride);
    this.rotate('calfL', 'x', -Math.max(0, -swing) * kneeAmp);
    this.rotate('calfR', 'x', -Math.max(0, swing) * kneeAmp);

    // Feet flatten as they plant and point as they lift.
    this.rotate('footL', 'x', swing * 0.3 * stride);
    this.rotate('footR', 'x', -swing * 0.3 * stride);

    // --- Hips + spine -----------------------------------------------------
    const pelvis = this.bones.get('pelvis');
    if (pelvis) {
      // Vertical bob: two bounces per stride, plus a sag on the weak leg.
      const bob = Math.abs(swing2) * 0.035 * stride * wobble - Math.max(0, swing) * 0.02 * wobble;
      pelvis.bone.position.y = this.restPelvisY + bob / Math.max(0.001, this.orient.scale.y);
      this.rotate('pelvis', 'z', -swing * 0.1 * wobble * stride);
      this.rotate('pelvis', 'y', swing * 0.12 * stride, true);
    }

    // Forward lean scales with speed — sprinters pitch further over.
    const lean = lerp(0.06, 0.34, stride);
    this.rotate('spine', 'x', lean * 0.4);
    this.rotate('spine1', 'x', lean * 0.3);
    this.rotate('spine2', 'x', lean * 0.2);
    // Counter-rotate the shoulders against the hips.
    this.rotate('spine2', 'y', -swing * 0.16 * stride, true);
    this.rotate('spine4', 'x', lean * 0.15);

    // --- Head -------------------------------------------------------------
    // Lolling head that still tracks the player.
    const headLoll = Math.sin(phase * 0.5 + state.phaseOffset) * 0.12 * wobble;
    this.rotate('neck', 'x', -lean * 0.7 + Math.sin(phase * 2) * 0.06 * stride);
    this.rotate('head', 'y', THREE.MathUtils.clamp(state.lookOffset, -0.9, 0.9) * 0.55);
    this.rotate('head', 'z', headLoll, true);
    this.rotate('head', 'x', -lean * 0.35, true);

    // --- Arms -------------------------------------------------------------
    if (state.attackWindup > 0) {
      this.poseAttackWindup(state);
    } else if (state.isAttacking) {
      this.poseAttacking(state);
    } else {
      this.poseArmsWalking(swing, stride, wobble);
    }
  }

  /** Classic outstretched reach, swaying opposite the legs. */
  private poseArmsWalking(swing: number, stride: number, wobble: number): void {
    // Arms come up as the zombie closes in: shambling low, sprinting high.
    const reach = lerp(-0.55, -1.45, stride);
    const armSwing = swing * lerp(0.18, 0.5, stride);

    this.rotate('clavicleL', 'z', -0.12);
    this.rotate('clavicleR', 'z', 0.12);

    this.rotate('upperArmL', 'x', reach - armSwing);
    this.rotate('upperArmR', 'x', reach + armSwing);
    this.rotate('upperArmL', 'z', 0.26 + Math.sin(swing) * 0.06 * wobble, true);
    this.rotate('upperArmR', 'z', -0.26 - Math.sin(swing) * 0.06 * wobble, true);

    // Elbows stay bent; hands hang loose and twitch slightly.
    this.rotate('forearmL', 'x', -0.75 - Math.max(0, armSwing) * 0.4);
    this.rotate('forearmR', 'x', -0.75 - Math.max(0, -armSwing) * 0.4);
    this.rotate('handL', 'x', -0.35);
    this.rotate('handR', 'x', -0.35);
  }

  /** Arms rear back and up before a swing. */
  private poseAttackWindup(state: ZombieAnimationState): void {
    const t = 1 - clamp01(state.attackWindup / Math.max(0.001, state.attackWindupDuration));
    const raise = Math.sin(t * Math.PI) * 1.6;

    this.rotate('upperArmL', 'x', -1.3 - raise);
    this.rotate('upperArmR', 'x', -1.3 - raise);
    this.rotate('upperArmL', 'z', 0.45, true);
    this.rotate('upperArmR', 'z', -0.45, true);
    this.rotate('forearmL', 'x', -0.5 - raise * 0.3);
    this.rotate('forearmR', 'x', -0.5 - raise * 0.3);
    // Whole body coils backward then snaps forward.
    this.rotate('spine1', 'x', -raise * 0.18, true);
  }

  /** Grabbing at the player at contact range. */
  private poseAttacking(state: ZombieAnimationState): void {
    const grab = Math.sin(state.elapsed * 9 + state.phaseOffset) * 0.18;
    this.rotate('upperArmL', 'x', -1.55 + grab);
    this.rotate('upperArmR', 'x', -1.55 - grab);
    this.rotate('upperArmL', 'z', 0.34, true);
    this.rotate('upperArmR', 'z', -0.34, true);
    this.rotate('forearmL', 'x', -0.5 + grab);
    this.rotate('forearmR', 'x', -0.5 - grab);
    this.rotate('handL', 'x', -0.7);
    this.rotate('handR', 'x', -0.7);
  }

  /** Collapse: knees buckle, spine folds, arms go slack. */
  private poseDeath(state: ZombieAnimationState): void {
    const t = clamp01(state.deathProgress);
    const fold = Math.min(1, t * 1.6);

    this.rotate('thighL', 'x', fold * 0.9);
    this.rotate('thighR', 'x', fold * 0.7);
    this.rotate('calfL', 'x', -fold * 1.7);
    this.rotate('calfR', 'x', -fold * 1.5);

    const pelvis = this.bones.get('pelvis');
    if (pelvis) {
      pelvis.bone.position.y =
        this.restPelvisY - (fold * 0.35) / Math.max(0.001, this.orient.scale.y);
    }

    this.rotate('spine', 'x', fold * 0.5);
    this.rotate('spine1', 'x', fold * 0.4);
    this.rotate('spine2', 'x', fold * 0.35);
    this.rotate('neck', 'x', fold * 0.5);
    this.rotate('head', 'x', fold * 0.7);

    // Arms fall outward and behind.
    this.rotate('upperArmL', 'x', fold * 1.1);
    this.rotate('upperArmR', 'x', fold * 1.0);
    this.rotate('upperArmL', 'z', fold * 0.7, true);
    this.rotate('upperArmR', 'z', -fold * 0.7, true);
    this.rotate('forearmL', 'x', -fold * 0.5);
    this.rotate('forearmR', 'x', -fold * 0.4);
  }

  // -------------------------------------------------------------------------

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
    const flash = this.hitFlash * this.hitFlash;
    const prime = this.primingGlow;
    for (let i = 0; i < this.materials.length; i++) {
      const material = this.materials[i];
      if (prime > 0.001) {
        material.emissive.setRGB(1 * prime, 0.32 * prime, 0.08 * prime);
        material.emissiveIntensity = 1 + prime * 1.6;
      } else if (flash > 0.001) {
        material.emissive.setRGB(flash, flash * 0.85, flash * 0.7);
        material.emissiveIntensity = 1;
      } else {
        material.emissive.copy(this.baseEmissive[i]);
        material.emissiveIntensity = 1;
      }
    }
  }

  setShadowsEnabled(enabled: boolean): void {
    for (const mesh of this.meshes) {
      if (mesh.castShadow !== enabled) mesh.castShadow = enabled;
    }
  }

  setLod(level: number): void {
    this.lod = level;
  }

  dispose(): void {
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.meshes.length = 0;
    this.bones.clear();
  }
}
