import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import handsUrl from '../assets/hands.glb';
import { applyStylizedShading } from '../textures/StylizedMaterial';
import { clamp, clamp01 } from '../utilities/MathUtils';
import type { WeaponModel } from './WeaponModels';

/**
 * First-person hands.
 *
 * The supplied rig is a Blender-style FPS arm pair — clavicle → upper arm →
 * forearm → hand, with full three-joint finger chains — and, like the zombie,
 * ships with no animation clips.
 *
 * Rather than hand-authoring a pose per weapon, each weapon exposes two grip
 * anchors and the arms **solve two-bone IK** onto them every frame. That means
 * the hands automatically follow the gun through recoil, reload swings and the
 * shotgun's travelling pump, and a new weapon only needs two anchor positions
 * rather than a bespoke animation.
 */

interface HandsTemplate {
  scene: THREE.Group;
  /** Scale that brings the rig into viewmodel proportions. */
  normalizeScale: number;
}

let templatePromise: Promise<HandsTemplate> | null = null;
let template: HandsTemplate | null = null;

/** Distance from shoulder to wrist in the rest pose, used to size the rig. */
const TARGET_ARM_LENGTH = 0.62;

/**
 * Bone name stems.
 *
 * Written with underscores because Three's GLTFLoader runs every node name
 * through `PropertyBinding.sanitizeNodeName`, which replaces dots with
 * underscores so names are usable as animation property paths. The source
 * rig's "forearm.R.001" therefore arrives as "forearm_R_001".
 */
const BONES = {
  upperArmR: 'upper_armR',
  // The elbow. "forearmR001" is a wrist twist bone sitting almost on top of
  // the hand, so using it as the IK mid-joint gives a near-zero lower bone
  // length and the solver refuses to run.
  forearmR: 'forearmR',
  wristR: 'forearmR001',
  handR: 'handR',
  upperArmL: 'upper_armL',
  forearmL: 'forearmL',
  wristL: 'forearmL001',
  handL: 'handL',
} as const;

/** Finger chains, curled to grip. Indexed by side. */
const FINGER_PREFIXES = ['f_index', 'f_middle', 'f_ring', 'f_pinky'] as const;

export function loadHandsModel(): Promise<HandsTemplate> {
  if (templatePromise) return templatePromise;

  templatePromise = new Promise<HandsTemplate>((resolve, reject) => {
    new GLTFLoader().load(
      handsUrl,
      (gltf) => {
        const scene = gltf.scene;
        scene.updateMatrixWorld(true);
        reconnectArms(scene);

        // Size from the arm itself rather than the mesh bounds: sleeves and
        // stray geometry make a bounding box a poor proxy for scale.
        const shoulder = findBone(scene, BONES.upperArmR);
        const wrist = findBone(scene, BONES.handR);
        let normalizeScale = 1;
        if (shoulder && wrist) {
          const length = shoulder
            .getWorldPosition(new THREE.Vector3())
            .distanceTo(wrist.getWorldPosition(new THREE.Vector3()));
          if (length > 1e-4) normalizeScale = TARGET_ARM_LENGTH / length;
        }

        scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          // Viewmodel geometry is always in front of the camera; culling it
          // against a stale skinned bounding volume makes it flicker out.
          mesh.frustumCulled = false;
          mesh.renderOrder = 9;

          const source = mesh.material as THREE.MeshStandardMaterial;
          const material = source.clone() as THREE.MeshStandardMaterial;
          // Warm the skin toward the village's golden light so the hands don't
          // look like they were lit on a different set.
          material.color.multiplyScalar(1.05);
          material.roughness = Math.min(1, (material.roughness ?? 0.8) + 0.1);
          applyStylizedShading(material, {
            rimColor: 0xffc98a,
            rimStrength: 0.5,
            rimPower: 2.4,
            subsurfaceColor: 0xff8a6a,
            subsurfaceStrength: 0.5,
          });
          mesh.material = material;
        });

        if (import.meta.env.DEV) {
          const found = Object.values(BONES).filter((key) => findBone(scene, key));
          console.info(
            '[Hands] scale=%s bones=%d/%d',
            normalizeScale.toFixed(3),
            found.length,
            Object.keys(BONES).length,
          );
        }

        template = { scene, normalizeScale };
        resolve(template);
      },
      undefined,
      (error) => reject(error),
    );
  });

  return templatePromise;
}

export function areHandsReady(): boolean {
  return template !== null;
}

/**
 * Mirrors `THREE.PropertyBinding.sanitizeNodeName`, which GLTFLoader applies to
 * every node it creates: whitespace becomes an underscore and the characters
 * reserved for animation property paths are **deleted**. So the rig's
 * "forearm.R.001" arrives in the scene as "forearmR001" — the dots are gone
 * entirely, not converted.
 */
function normalizeName(name: string): string {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

function findBone(root: THREE.Object3D, key: string): THREE.Bone | null {
  const wanted = normalizeName(key);
  let found: THREE.Bone | null = null;

  // Exact stem plus a numeric suffix, so "forearm_R" can't shadow
  // "forearm_R_001".
  root.traverse((object) => {
    if (found) return;
    const name = normalizeName(object.name);
    if (name.startsWith(wanted) && /^_?\d*$/.test(name.slice(wanted.length))) {
      found = object as THREE.Bone;
    }
  });

  if (!found) {
    root.traverse((object) => {
      if (!found && normalizeName(object.name).includes(wanted)) found = object as THREE.Bone;
    });
  }
  return found;
}

/**
 * Reconnects the arm chains.
 *
 * The source rig is split: `forearm_R_001` (which owns the hand and fingers)
 * hangs off the skeleton root as a *sibling* of the arm rather than a child of
 * `forearm_R`. Left alone, rotating the shoulder would not move the hand at
 * all. `attach` re-parents while preserving the world transform, so the bind
 * pose — and therefore the skinning — is untouched.
 */
function reconnectArms(root: THREE.Object3D): void {
  const pairs: [string, string][] = [
    [BONES.wristR, BONES.forearmR],
    [BONES.wristL, BONES.forearmL],
  ];

  for (const [childKey, parentKey] of pairs) {
    const child = findBone(root, childKey);
    const parent = findBone(root, parentKey);
    if (!child || !parent || child === parent) continue;
    if (child.parent === parent) continue;
    parent.attach(child);
  }
  root.updateMatrixWorld(true);
}

// --- Two-bone IK -------------------------------------------------------------

const _rootPos = new THREE.Vector3();
const _midPos = new THREE.Vector3();
const _endPos = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _toEnd = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _worldQuat = new THREE.Quaternion();

/**
 * Classic analytic two-bone IK.
 *
 * Aims the chain at the target, then bends the elbow by the angle the law of
 * cosines says is needed to make the two bone lengths span the distance. Cheap,
 * exact, and stable — no iteration, so it can't jitter.
 */
function solveTwoBoneIK(
  root: THREE.Object3D,
  mid: THREE.Object3D,
  end: THREE.Object3D,
  targetWorld: THREE.Vector3,
  poleAxis: THREE.Vector3,
): void {
  root.updateWorldMatrix(true, false);
  mid.updateWorldMatrix(true, false);
  end.updateWorldMatrix(true, false);

  _rootPos.setFromMatrixPosition(root.matrixWorld);
  _midPos.setFromMatrixPosition(mid.matrixWorld);
  _endPos.setFromMatrixPosition(end.matrixWorld);

  const upperLength = _rootPos.distanceTo(_midPos);
  const lowerLength = _midPos.distanceTo(_endPos);
  if (upperLength < 1e-5 || lowerLength < 1e-5) return;

  const maxReach = (upperLength + lowerLength) * 0.999;
  _toTarget.subVectors(targetWorld, _rootPos);
  const targetDistance = clamp(_toTarget.length(), Math.abs(upperLength - lowerLength) + 1e-4, maxReach);
  if (targetDistance < 1e-5) return;
  _toTarget.normalize();

  // --- 1. Point the whole chain at the target ---
  _toEnd.subVectors(_endPos, _rootPos).normalize();
  _quat.setFromUnitVectors(_toEnd, _toTarget);
  applyWorldRotation(root, _quat);

  // --- 2. Bend the elbow by the law of cosines ---
  root.updateWorldMatrix(true, false);
  mid.updateWorldMatrix(true, false);
  _rootPos.setFromMatrixPosition(root.matrixWorld);
  _midPos.setFromMatrixPosition(mid.matrixWorld);

  const cosRoot = clamp(
    (upperLength * upperLength + targetDistance * targetDistance - lowerLength * lowerLength) /
      (2 * upperLength * targetDistance),
    -1,
    1,
  );
  const rootAngle = Math.acos(cosRoot);

  const cosMid = clamp(
    (upperLength * upperLength + lowerLength * lowerLength - targetDistance * targetDistance) /
      (2 * upperLength * lowerLength),
    -1,
    1,
  );
  const midAngle = Math.PI - Math.acos(cosMid);

  // Bend axis: perpendicular to the limb, biased by the pole so the elbow
  // always breaks the same way instead of flipping.
  _axis.copy(poleAxis).cross(_toTarget);
  if (_axis.lengthSq() < 1e-8) _axis.set(0, 1, 0).cross(_toTarget);
  _axis.normalize();

  _quat.setFromAxisAngle(_axis, -rootAngle);
  applyWorldRotation(root, _quat);

  _quat.setFromAxisAngle(_axis, midAngle);
  applyWorldRotation(mid, _quat);
}

/** Applies a world-space rotation to a bone's local quaternion. */
function applyWorldRotation(bone: THREE.Object3D, worldRotation: THREE.Quaternion): void {
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_parentQuat);
    _parentQuat.invert();
    bone.getWorldQuaternion(_worldQuat);
    _worldQuat.premultiply(worldRotation);
    bone.quaternion.copy(_parentQuat).multiply(_worldQuat);
  } else {
    bone.quaternion.premultiply(worldRotation);
  }
  bone.updateWorldMatrix(false, false);
}

// --- Runtime -----------------------------------------------------------------

interface ArmChain {
  upper: THREE.Object3D;
  fore: THREE.Object3D;
  hand: THREE.Object3D;
  pole: THREE.Vector3;
}

export class FirstPersonHands {
  readonly root = new THREE.Group();

  private readonly model: THREE.Group;
  private right: ArmChain | null = null;
  private left: ArmChain | null = null;
  private readonly restQuaternions = new Map<THREE.Object3D, THREE.Quaternion>();
  private readonly fingerBones: { bone: THREE.Object3D; rest: THREE.Quaternion; curl: number }[] = [];

  private triggerPull = 0;
  private visible = true;

  private readonly _gripR = new THREE.Vector3();
  private readonly _gripL = new THREE.Vector3();
  private readonly _handQuat = new THREE.Quaternion();

  constructor() {
    if (!template) throw new Error('Hands requested before loadHandsModel() resolved.');

    // Must be SkeletonUtils.clone, not Object3D.clone: the latter duplicates
    // the bone hierarchy but leaves the SkinnedMesh bound to the *original*
    // skeleton, so posing the copy's bones would deform nothing.
    this.model = cloneSkinned(template.scene) as THREE.Group;
    this.model.scale.setScalar(template.normalizeScale);
    this.root.add(this.model);

    this.captureChains();
    this.anchorShoulders();
    this.captureFingers();
  }

  private captureChains(): void {
    const build = (upperKey: string, foreKey: string, handKey: string, pole: THREE.Vector3): ArmChain | null => {
      const upper = findBone(this.model, upperKey);
      const fore = findBone(this.model, foreKey);
      const hand = findBone(this.model, handKey);
      if (!upper || !fore || !hand) return null;
      for (const bone of [upper, fore, hand]) {
        this.restQuaternions.set(bone, bone.quaternion.clone());
      }
      return { upper, fore, hand, pole };
    };

    // Elbows break downward and outward, as they do when shouldering a weapon.
    this.right = build(BONES.upperArmR, BONES.forearmR, BONES.handR, new THREE.Vector3(0.4, -1, -0.2).normalize());
    this.left = build(BONES.upperArmL, BONES.forearmL, BONES.handL, new THREE.Vector3(-0.4, -1, -0.2).normalize());
  }

  /**
   * Places the rig so the shoulders sit where the player's shoulders would be.
   *
   * The source rig's origin is arbitrary — after normalising the arm to 0.62 m
   * the shoulders can end up metres from the weapon, far outside IK reach.
   * Measuring the actual shoulder midpoint and offsetting the model puts them
   * behind and below the gun, where arms can comfortably reach the grips.
   */
  private anchorShoulders(): void {
    if (!this.right || !this.left) return;

    this.root.updateMatrixWorld(true);
    const rightShoulder = this.right.upper.getWorldPosition(new THREE.Vector3());
    const leftShoulder = this.left.upper.getWorldPosition(new THREE.Vector3());
    const midpoint = rightShoulder.add(leftShoulder).multiplyScalar(0.5);

    // Convert to the rig root's space and shift the model by the difference.
    this.root.worldToLocal(midpoint);
    this.model.position.sub(midpoint).add(SHOULDER_ANCHOR);
    this.root.updateMatrixWorld(true);
  }

  /**
   * Curls the fingers once into a static grip. Only the trigger finger is
   * animated afterwards, so this costs nothing per frame.
   */
  private captureFingers(): void {
    this.model.traverse((object) => {
      // Strip the exporter's trailing "_NNN" index so the joint number in the
      // middle of the name ("f_pinky02R") can be read unambiguously.
      const name = normalizeName(object.name).replace(/_\d+$/, '');
      const isFinger = FINGER_PREFIXES.some((prefix) => name.startsWith(prefix));
      const isThumb = name.startsWith('thumb');
      if (!isFinger && !isThumb) return;
      if (name.includes('end')) return;

      // Joints further down the finger curl harder, which is what makes a fist
      // read as a grip rather than a claw.
      const segment = name.includes('02') ? 1 : name.includes('03') ? 2 : 0;
      const base = isThumb ? 0.42 : 0.72;
      const curl = base * (segment === 0 ? 1 : segment === 1 ? 1.15 : 0.9);

      const rest = object.quaternion.clone();
      this.restQuaternions.set(object, rest);
      this.fingerBones.push({ bone: object, rest, curl });
    });

    this.applyFingerCurl(0);
  }

  private applyFingerCurl(triggerPull: number): void {
    for (const entry of this.fingerBones) {
      const indexName = normalizeName(entry.bone.name).replace(/_\d+$/, '');
      const isIndexRight = indexName.startsWith('f_index') && indexName.endsWith('R');
      // The trigger finger straightens slightly, then squeezes on firing.
      const amount = isIndexRight ? entry.curl * (0.55 + triggerPull * 0.6) : entry.curl;
      _quat.setFromAxisAngle(FINGER_AXIS, amount);
      entry.bone.quaternion.copy(entry.rest).multiply(_quat);
    }
  }

  /**
   * Poses both arms onto the active weapon's grips.
   * Called every frame after the weapon's own animation has run.
   */
  update(weapon: WeaponModel | null, dt: number, firing: number, sprintLower: number): void {
    if (!weapon || !this.visible) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    // Trigger squeeze decays after each shot.
    this.triggerPull = Math.max(firing, this.triggerPull - dt * 6);
    this.applyFingerCurl(clamp01(this.triggerPull));

    // Hands tuck away as the weapon lowers for a sprint, so they don't float
    // free of the gun during the transition.
    const reach = 1 - sprintLower * 0.35;

    weapon.gripRight.getWorldPosition(this._gripR);
    weapon.gripLeft.getWorldPosition(this._gripL);

    if (this.right) {
      solveTwoBoneIK(this.right.upper, this.right.fore, this.right.hand, this._gripR, this.right.pole);
      this.matchHandOrientation(this.right.hand, weapon.gripRight, 1);
    }
    if (this.left) {
      // Support hand blends toward the body when the weapon is lowered.
      this._gripL.lerp(this._gripR, 1 - reach);
      solveTwoBoneIK(this.left.upper, this.left.fore, this.left.hand, this._gripL, this.left.pole);
      this.matchHandOrientation(this.left.hand, weapon.gripLeft, -1);
    }
  }

  /** Rolls the wrist so the palm wraps the grip rather than facing anywhere. */
  private matchHandOrientation(hand: THREE.Object3D, grip: THREE.Object3D, side: number): void {
    grip.getWorldQuaternion(this._handQuat);
    _quat.setFromAxisAngle(HAND_ROLL_AXIS, side * 1.35);
    this._handQuat.multiply(_quat);

    if (hand.parent) {
      hand.parent.getWorldQuaternion(_parentQuat);
      _parentQuat.invert();
      hand.quaternion.copy(_parentQuat).multiply(this._handQuat);
    } else {
      hand.quaternion.copy(this._handQuat);
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  dispose(): void {
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.root.clear();
  }
}

/**
 * Where the shoulders sit relative to the weapon, in viewmodel space: a little
 * below the gun and well behind it, roughly at chest height for the camera.
 */
const SHOULDER_ANCHOR = new THREE.Vector3(0, -0.16, 0.42);

const FINGER_AXIS = new THREE.Vector3(0, 0, 1);
const HAND_ROLL_AXIS = new THREE.Vector3(0, 0, 1);
