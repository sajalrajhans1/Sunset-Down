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
  /** Head centre height in normalised units. */
  headHeight: number;
  /** Head sphere radius in normalised units. */
  headRadius: number;
}

/**
 * Height of a zombie at class scale 1.0, in metres. The player's eye sits at
 * 1.68 m, so this keeps a baseline zombie at roughly eye-to-eye with them.
 */
const TARGET_HEIGHT = 1.75;

/**
 * Head radius as a fraction of total body height. A human head is about a
 * seventh of standing height, so its radius is roughly half of that.
 */
const HEAD_RADIUS_RATIO = 0.068;

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

        // Head hit sphere, derived from the mesh rather than the head *bone*.
        // The bone sits at the base of the skull, so centring a sphere on it
        // puts the headshot volume down in the neck.
        const headRadiusModel = height * HEAD_RADIUS_RATIO;
        const headCentreModelY = box.max.y - headRadiusModel * 1.05;
        const headHeight = (headCentreModelY - box.min.y) * normalizeScale;
        const headRadius = headRadiusModel * normalizeScale;

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

        template = { scene, normalizeScale, facingCorrection, headHeight, headRadius };

        if (import.meta.env.DEV) {
          // Verifying the derived rig is far easier from a log than from the
          // render, especially the facing correction.
          const resolved = (Object.keys(BONE_KEYS) as BoneKey[]).filter((key) =>
            findBone(scene, BONE_KEYS[key]),
          );
          console.info(
            '[Zombie model] height=%s scale=%s facing=%s° head=%s r=%s bones=%d/%d%s',
            height.toFixed(3),
            normalizeScale.toFixed(3),
            THREE.MathUtils.radToDeg(facingCorrection).toFixed(1),
            headHeight.toFixed(3),
            headRadius.toFixed(3),
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

/**
 * Per-bone rotation axes, derived from anatomy rather than from world axes.
 *
 * This model is T-posed, so the arms point along ±X. Rotating an arm about the
 * model's X axis therefore just twists it along its own length — which is
 * exactly what a naive "rotate about X to swing forward" produces, and it
 * looks broken.
 *
 * Instead each axis is built as a cross product of the bone's own direction
 * (bone → child) with a body direction. `cross(boneDir, forward)` is the axis
 * that moves *this* bone toward forward, whatever way it happens to point. It
 * also mirrors automatically: the same positive angle swings both the left and
 * the right arm forward, with no per-side sign flipping.
 */
interface BoneRig {
  bone: THREE.Bone;
  restQuaternion: THREE.Quaternion;
  /** Positive rotation moves the bone toward the body's forward. */
  swingAxis: THREE.Vector3;
  /** Positive rotation moves the bone toward the body's left. */
  spreadAxis: THREE.Vector3;
  /** Positive rotation raises the bone toward the body's up. */
  liftAxis: THREE.Vector3;
}

const _q = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _inverse = new THREE.Quaternion();
const _scratchQuat = new THREE.Quaternion();
const _modelUp = new THREE.Vector3(0, 1, 0);
const _headAxis = new THREE.Vector3();

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
  headRadius = 0.12;

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
    this.headRadius = template.headRadius;
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

      // Body directions expressed in this bone's parent space.
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(_inverse).normalize();
      const left = new THREE.Vector3(1, 0, 0).applyQuaternion(_inverse).normalize();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(_inverse).normalize();

      // Direction this bone points, in its parent's space.
      const childBone = bone.children.find((child) => (child as THREE.Bone).isBone) as
        | THREE.Bone
        | undefined;
      const boneDir = childBone
        ? childBone.position.clone().applyQuaternion(bone.quaternion)
        : up.clone().negate();
      if (boneDir.lengthSq() < 1e-9) boneDir.copy(up).negate();
      boneDir.normalize();

      // Each cross product degenerates when the bone is parallel to that body
      // direction, so fall back to a sane perpendicular in those cases.
      const swingAxis = new THREE.Vector3().crossVectors(boneDir, forward);
      if (swingAxis.lengthSq() < 1e-6) swingAxis.copy(left);
      swingAxis.normalize();

      const spreadAxis = new THREE.Vector3().crossVectors(boneDir, left);
      if (spreadAxis.lengthSq() < 1e-6) spreadAxis.copy(forward);
      spreadAxis.normalize();

      const liftAxis = new THREE.Vector3().crossVectors(boneDir, up);
      if (liftAxis.lengthSq() < 1e-6) liftAxis.copy(swingAxis);
      liftAxis.normalize();

      this.bones.set(key, {
        bone,
        restQuaternion: bone.quaternion.clone(),
        swingAxis,
        spreadAxis,
        liftAxis,
      });
    }
  }

  /** Rotates a bone about one of its anatomical axes, relative to rest. */
  private rotate(
    key: BoneKey,
    axis: 'swing' | 'spread' | 'lift',
    angle: number,
    additive = false,
  ): void {
    const rig = this.bones.get(key);
    if (!rig) return;
    const vector =
      axis === 'swing' ? rig.swingAxis : axis === 'spread' ? rig.spreadAxis : rig.liftAxis;
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

    // Hit volumes follow the same non-uniform scale the mesh got, so the
    // headshot sphere stays glued to where the head actually renders.
    const verticalScale = def.scale * lerp(1, p.bodyHeight, 0.4);
    const horizontalScale = def.scale * lerp(1, p.bodyWidth, 0.55);
    this.headHeight = template!.headHeight * verticalScale;
    this.headRadius = template!.headRadius * Math.max(verticalScale, horizontalScale);
    this.bodyRadius = 0.26 * horizontalScale;

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
    // Uneven drive between the legs reads instantly as a limp.
    const limp = 1 + swing * 0.16 * wobble;

    // --- Legs --------------------------------------------------------------
    // Positive swing carries a limb forward whichever way it points, so the
    // two legs simply take opposite signs.
    const legAmp = lerp(0.22, 0.85, stride);
    this.rotate('thighL', 'swing', swing * legAmp * limp);
    this.rotate('thighR', 'swing', -swing * legAmp);
    // A little stance width so the legs never scissor through each other.
    this.rotate('thighL', 'spread', 0.07, true);
    this.rotate('thighR', 'spread', -0.07, true);

    // Knees only bend backward, and peak just after the leg passes under the
    // hips - hence the phase offset rather than a raw half-wave.
    const kneeAmp = lerp(0.35, 1.5, stride);
    this.rotate('calfL', 'swing', -Math.max(0, -Math.sin(phase + 0.9)) * kneeAmp);
    this.rotate('calfR', 'swing', -Math.max(0, Math.sin(phase + 0.9)) * kneeAmp);

    // Ankles roll through the step.
    this.rotate('footL', 'swing', -swing * 0.28 * stride);
    this.rotate('footR', 'swing', swing * 0.28 * stride);

    // --- Hips + spine ------------------------------------------------------
    const pelvis = this.bones.get('pelvis');
    if (pelvis) {
      const bob = Math.abs(swing2) * 0.03 * stride * wobble - Math.max(0, swing) * 0.016 * wobble;
      pelvis.bone.position.y = this.restPelvisY + bob / Math.max(0.001, this.orient.scale.y);
      this.rotate('pelvis', 'spread', -swing * 0.06 * wobble * stride);
    }

    // Forward lean grows with speed; sprinting zombies pitch right over.
    const lean = lerp(0.05, 0.4, stride);
    this.rotate('spine', 'swing', lean * 0.42);
    this.rotate('spine1', 'swing', lean * 0.3);
    this.rotate('spine2', 'swing', lean * 0.2);
    this.rotate('spine4', 'swing', lean * 0.12);

    // --- Head --------------------------------------------------------------
    // Counter the torso lean so the head stays up and locked on the player.
    this.rotate('neck', 'swing', -lean * 0.75 + swing2 * 0.05 * stride);
    this.rotate('head', 'swing', -lean * 0.35);
    this.rotate('head', 'spread', Math.sin(phase * 0.5) * 0.08 * wobble, true);

    // Yaw the head toward the player about the body's true up axis.
    const headRig = this.bones.get('head');
    if (headRig) {
      const headTurn = THREE.MathUtils.clamp(state.lookOffset, -0.8, 0.8) * 0.5;
      _headAxis.copy(_modelUp).applyQuaternion(headRig.bone.getWorldQuaternion(_scratchQuat).invert());
      _q.setFromAxisAngle(_headAxis.normalize(), headTurn);
      headRig.bone.quaternion.multiply(_q);
    }

    // --- Arms --------------------------------------------------------------
    if (state.attackWindup > 0) {
      this.poseAttackWindup(state);
    } else if (state.isAttacking) {
      this.poseAttacking(state);
    } else {
      this.poseArmsRunning(swing, stride, wobble);
    }
  }

  /**
   * Running arms.
   *
   * The model is T-posed, so the arms start pointing straight out sideways.
   * A positive swing of ~1.2 rad brings them round to the front - which is
   * both the classic zombie reach and the base pose the run pumps around.
   */
  private poseArmsRunning(swing: number, stride: number, wobble: number): void {
    // Shamblers hold their arms low and loose; sprinters carry them high.
    const reach = lerp(0.95, 1.3, stride);
    const pump = swing * lerp(0.1, 0.5, stride);

    this.rotate('clavicleL', 'lift', 0.08);
    this.rotate('clavicleR', 'lift', 0.08);

    // Arms swing in opposition to the legs.
    this.rotate('upperArmL', 'swing', reach + pump);
    this.rotate('upperArmR', 'swing', reach - pump);
    // Raise toward horizontal and tuck slightly inward as the pace rises.
    this.rotate('upperArmL', 'lift', lerp(-0.25, 0.12, stride) + swing * 0.05 * wobble, true);
    this.rotate('upperArmR', 'lift', lerp(-0.25, 0.12, stride) - swing * 0.05 * wobble, true);

    // Elbows stay bent, tightening as the pace picks up.
    const elbow = lerp(0.35, 0.95, stride);
    this.rotate('forearmL', 'swing', elbow + Math.max(0, pump) * 0.45);
    this.rotate('forearmR', 'swing', elbow + Math.max(0, -pump) * 0.45);

    // Hands hang loose, fingers trailing.
    this.rotate('handL', 'swing', 0.3);
    this.rotate('handR', 'swing', 0.3);
  }

  /** Arms rear up and back, coiling before the strike. */
  private poseAttackWindup(state: ZombieAnimationState): void {
    const t = 1 - clamp01(state.attackWindup / Math.max(0.001, state.attackWindupDuration));
    const raise = Math.sin(t * Math.PI);

    // Swing round to the front, then lift high overhead.
    this.rotate('upperArmL', 'swing', 1.3 + raise * 0.5);
    this.rotate('upperArmR', 'swing', 1.3 + raise * 0.5);
    this.rotate('upperArmL', 'lift', 0.35 + raise * 1.15, true);
    this.rotate('upperArmR', 'lift', 0.35 + raise * 1.15, true);

    this.rotate('forearmL', 'swing', 0.75 + raise * 0.5);
    this.rotate('forearmR', 'swing', 0.75 + raise * 0.5);
    this.rotate('handL', 'swing', 0.5);
    this.rotate('handR', 'swing', 0.5);

    // The torso coils back with the arms, then whips forward.
    this.rotate('spine1', 'swing', -raise * 0.22, true);
    this.rotate('spine2', 'swing', -raise * 0.14, true);
    this.rotate('neck', 'swing', raise * 0.2, true);
  }

  /** Clawing at the player at contact range. */
  private poseAttacking(state: ZombieAnimationState): void {
    const claw = Math.sin(state.elapsed * 11 + state.phaseOffset) * 0.22;

    this.rotate('upperArmL', 'swing', 1.5 + claw);
    this.rotate('upperArmR', 'swing', 1.5 - claw);
    this.rotate('upperArmL', 'lift', 0.2 - claw * 0.4, true);
    this.rotate('upperArmR', 'lift', 0.2 + claw * 0.4, true);

    this.rotate('forearmL', 'swing', 0.85 - claw * 0.5);
    this.rotate('forearmR', 'swing', 0.85 + claw * 0.5);
    this.rotate('handL', 'swing', 0.75);
    this.rotate('handR', 'swing', 0.75);

    this.rotate('spine1', 'swing', 0.18, true);
  }

  /** Collapse: knees buckle, spine folds, arms go slack. */
  private poseDeath(state: ZombieAnimationState): void {
    const t = clamp01(state.deathProgress);
    const fold = Math.min(1, t * 1.6);

    this.rotate('thighL', 'swing', fold * 0.8);
    this.rotate('thighR', 'swing', fold * 0.6);
    this.rotate('calfL', 'swing', -fold * 1.8);
    this.rotate('calfR', 'swing', -fold * 1.6);

    const pelvis = this.bones.get('pelvis');
    if (pelvis) {
      pelvis.bone.position.y =
        this.restPelvisY - (fold * 0.3) / Math.max(0.001, this.orient.scale.y);
    }

    this.rotate('spine', 'swing', fold * 0.45);
    this.rotate('spine1', 'swing', fold * 0.35);
    this.rotate('spine2', 'swing', fold * 0.3);
    this.rotate('neck', 'swing', fold * 0.45);
    this.rotate('head', 'swing', fold * 0.6);

    // Arms drop and splay outward.
    this.rotate('upperArmL', 'swing', fold * 0.4);
    this.rotate('upperArmR', 'swing', fold * 0.4);
    this.rotate('upperArmL', 'lift', -fold * 0.9, true);
    this.rotate('upperArmR', 'lift', -fold * 0.9, true);
    this.rotate('forearmL', 'swing', fold * 0.5);
    this.rotate('forearmR', 'swing', fold * 0.5);
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
