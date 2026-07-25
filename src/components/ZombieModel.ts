import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { toonRampTexture } from '../textures/ProceduralTextures';
import { zombieSkin } from '../textures/ZombieSkin';
import { applyStylizedShading } from '../textures/StylizedMaterial';
import type { ZombieTypeDef } from './ZombieTypes';
import type { ZombieAnimationState, ZombieVisual } from './ZombieVisual';

/**
 * Procedural zombie rig.
 *
 * A single generic rig serves all five classes: the *proportions* in each type
 * definition rescale the shared parts into wildly different silhouettes. This
 * means one geometry set in memory, and a pooled zombie can be recycled as any
 * class without rebuilding meshes.
 *
 * Part count is deliberately held to 8 meshes — both eyes are merged into one
 * geometry, as are both pupils — because with 60 zombies on screen every extra
 * mesh is 60 more draw calls (120 with shadows).
 */

export interface ZombieRig {
  root: THREE.Group;
  /** Bobs and leans; everything else hangs off it. */
  body: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Group;
  skull: THREE.Mesh;
  eyes: THREE.Mesh;
  pupils: THREE.Mesh;
  brow: THREE.Mesh;
  armLeft: THREE.Group;
  armRight: THREE.Group;
  legLeft: THREE.Group;
  legRight: THREE.Group;
  /** Crown / hat / belly glow, depending on class. */
  accessory: THREE.Mesh;
  /** Per-instance materials so hit flashes affect only this zombie. */
  skinMaterial: THREE.MeshToonMaterial;
  accentMaterial: THREE.MeshToonMaterial;
  /** Crown / fuse tip — kept separate so the dark face accent stays dark. */
  accessoryMaterial: THREE.MeshToonMaterial;
  /** Cached list of meshes that can be hidden at distance. */
  detailMeshes: THREE.Object3D[];
  allMeshes: THREE.Mesh[];
}

// --- Shared geometry ---------------------------------------------------------

interface SharedGeometry {
  torso: THREE.BufferGeometry;
  skull: THREE.BufferGeometry;
  eyes: THREE.BufferGeometry;
  pupils: THREE.BufferGeometry;
  brow: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  crown: THREE.BufferGeometry;
}

let sharedGeometry: SharedGeometry | null = null;

const EYE_SEPARATION = 0.19;
const EYE_FORWARD = -0.3;
const EYE_HEIGHT = 0.05;

function buildSharedGeometry(): SharedGeometry {
  if (sharedGeometry) return sharedGeometry;

  // Torso: a rounded barrel, wider at the belly. Origin at the hips.
  const torso = new THREE.SphereGeometry(0.36, 14, 12);
  torso.scale(1, 1.25, 0.86);
  torso.translate(0, 0.42, 0);

  // Skull: squashed sphere with a slight forward tilt, origin at the neck.
  const skull = new THREE.SphereGeometry(0.34, 16, 14);
  skull.scale(1, 0.94, 0.96);

  // Eyes are deliberately small — big round eyes read as cute, small hot
  // points sunk into dark sockets read as predatory.
  const eyeLeft = new THREE.SphereGeometry(0.088, 10, 8);
  eyeLeft.translate(-EYE_SEPARATION, EYE_HEIGHT, EYE_FORWARD);
  const eyeRight = new THREE.SphereGeometry(0.088, 10, 8);
  eyeRight.translate(EYE_SEPARATION, EYE_HEIGHT, EYE_FORWARD);
  const eyes = mergeGeometries([eyeLeft, eyeRight], false)!;
  eyeLeft.dispose();
  eyeRight.dispose();

  // Narrow slit pupils rather than round dots.
  const pupilLeft = new THREE.SphereGeometry(0.05, 8, 6);
  pupilLeft.scale(0.5, 1.15, 0.6);
  pupilLeft.translate(-EYE_SEPARATION, EYE_HEIGHT, EYE_FORWARD - 0.055);
  const pupilRight = pupilLeft.clone();
  pupilRight.translate(EYE_SEPARATION * 2, 0, 0);
  const pupils = mergeGeometries([pupilLeft, pupilRight], false)!;
  pupilLeft.dispose();
  pupilRight.dispose();

  // The "face" mesh: heavy angled brow, sunken eye sockets and a snarling
  // mouth, all merged into a single geometry sharing the dark accent material.
  // Merging them keeps the whole face to one draw call, which matters when
  // sixty of these are on screen.
  const faceParts: THREE.BufferGeometry[] = [];

  for (const side of [-1, 1]) {
    // Brow angled sharply down toward the nose — the universal shorthand for
    // "angry", and the single biggest contributor to a menacing read.
    const brow = new THREE.BoxGeometry(0.26, 0.08, 0.09);
    brow.rotateZ(side * 0.46);
    brow.translate(side * EYE_SEPARATION, EYE_HEIGHT + 0.16, EYE_FORWARD - 0.04);
    faceParts.push(brow);

    // Recessed socket sitting just behind the eye, so the glow appears to come
    // from inside a hollow rather than from a ball stuck on the face.
    const socket = new THREE.SphereGeometry(0.125, 10, 8);
    socket.scale(1, 0.85, 0.6);
    socket.translate(side * EYE_SEPARATION, EYE_HEIGHT, EYE_FORWARD + 0.035);
    faceParts.push(socket);
  }

  // Jagged snarl: a dark slit with a few angular teeth biting into it.
  const mouth = new THREE.BoxGeometry(0.3, 0.075, 0.08);
  mouth.rotateX(0.12);
  mouth.translate(0, EYE_HEIGHT - 0.3, EYE_FORWARD + 0.02);
  faceParts.push(mouth);

  for (let i = 0; i < 5; i++) {
    const tooth = new THREE.ConeGeometry(0.022, 0.06, 4);
    // Alternate teeth point up and down across the mouth line.
    const down = i % 2 === 0;
    tooth.rotateX(down ? Math.PI : 0);
    tooth.translate(-0.11 + i * 0.055, EYE_HEIGHT - 0.3 + (down ? 0.03 : -0.03), EYE_FORWARD - 0.02);
    faceParts.push(tooth);
  }

  const brow = mergeGeometries(faceParts, false)!;
  for (const part of faceParts) part.dispose();

  // Limbs: capsules with the origin at the shoulder/hip so rotation pivots
  // correctly for the walk cycle.
  const arm = new THREE.CapsuleGeometry(0.1, 0.42, 4, 8);
  arm.translate(0, -0.31, 0);

  const leg = new THREE.CapsuleGeometry(0.115, 0.38, 4, 8);
  leg.translate(0, -0.29, 0);

  // Accessory: a simple crown/party-hat cone reused across classes.
  const crown = new THREE.ConeGeometry(0.26, 0.34, 8);

  sharedGeometry = { torso, skull, eyes, pupils, brow, arm, leg, crown };
  return sharedGeometry;
}

// --- Shared eye materials ----------------------------------------------------

let eyeWhiteMaterial: THREE.MeshBasicMaterial | null = null;
let pupilMaterial: THREE.MeshBasicMaterial | null = null;

function sharedEyeMaterials(): { white: THREE.MeshBasicMaterial; pupil: THREE.MeshBasicMaterial } {
  if (!eyeWhiteMaterial) {
    // Hot, self-lit eyes. Bright enough to punch through the bloom threshold
    // so they visibly glow in shadow and at distance — menacing without a drop
    // of gore, and the loudest signal that these are not friendly.
    eyeWhiteMaterial = new THREE.MeshBasicMaterial({ color: 0xffd257, toneMapped: false });
    pupilMaterial = new THREE.MeshBasicMaterial({ color: 0x1a0a06, toneMapped: false });
  }
  return { white: eyeWhiteMaterial, pupil: pupilMaterial! };
}

// --- Rig construction --------------------------------------------------------

/**
 * Builds one zombie rig with its own skin materials. Called once per pooled
 * entity at load, never during gameplay.
 */
export function createZombieRig(): ZombieRig {
  const geo = buildSharedGeometry();
  const gradientMap = toonRampTexture();
  const { white, pupil } = sharedEyeMaterials();

  const skin = zombieSkin();

  // Painted flesh over the toon ramp: the texture supplies pores, veins and
  // stitching, the per-class colour tints it, and a cold rim light replaces
  // the warm one so the zombies never feel lit by the same friendly sunset as
  // the village behind them.
  const skinMaterial = applyStylizedShading(
    new THREE.MeshToonMaterial({
      color: 0x8fce8a,
      map: skin.albedo,
      normalMap: skin.normal,
      normalScale: new THREE.Vector2(0.85, 0.85),
      gradientMap,
    }),
    {
      rimColor: 0xa8d8ff,
      rimStrength: 0.5,
      rimPower: 2.6,
      subsurfaceColor: 0x6a8f5a,
      subsurfaceStrength: 0.35,
    },
  );

  // Brow, sockets, mouth and teeth. Kept very dark so the face reads as
  // hollows and shadow rather than as painted-on features.
  const accentMaterial = applyStylizedShading(
    new THREE.MeshToonMaterial({ color: 0x1f1a24, gradientMap }),
    { rimColor: 0x9ab8d8, rimStrength: 0.35 },
  );

  const root = new THREE.Group();
  root.name = 'zombie';

  const body = new THREE.Group();
  root.add(body);

  const torso = new THREE.Mesh(geo.torso, skinMaterial);
  torso.castShadow = true;
  body.add(torso);

  // Head assembly.
  const head = new THREE.Group();
  head.position.y = 1.02;
  body.add(head);

  const skull = new THREE.Mesh(geo.skull, skinMaterial);
  skull.castShadow = true;
  head.add(skull);

  const eyes = new THREE.Mesh(geo.eyes, white);
  head.add(eyes);

  const pupils = new THREE.Mesh(geo.pupils, pupil);
  head.add(pupils);

  const brow = new THREE.Mesh(geo.brow, accentMaterial);
  head.add(brow);

  const accessoryMaterial = applyStylizedShading(
    new THREE.MeshToonMaterial({ color: 0xffc861, gradientMap }),
    { rimColor: 0xffe6b0, rimStrength: 0.9 },
  );

  const accessory = new THREE.Mesh(geo.crown, accessoryMaterial);
  accessory.position.y = 0.42;
  accessory.visible = false;
  head.add(accessory);

  // Limbs.
  const makeLimb = (geometry: THREE.BufferGeometry, x: number, y: number): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(geometry, skinMaterial);
    mesh.castShadow = true;
    pivot.add(mesh);
    body.add(pivot);
    return pivot;
  };

  const armLeft = makeLimb(geo.arm, -0.42, 0.82);
  const armRight = makeLimb(geo.arm, 0.42, 0.82);
  const legLeft = makeLimb(geo.leg, -0.19, 0.36);
  const legRight = makeLimb(geo.leg, 0.19, 0.36);

  const allMeshes: THREE.Mesh[] = [
    torso,
    skull,
    eyes,
    pupils,
    brow,
    accessory,
    armLeft.children[0] as THREE.Mesh,
    armRight.children[0] as THREE.Mesh,
    legLeft.children[0] as THREE.Mesh,
    legRight.children[0] as THREE.Mesh,
  ];

  return {
    root,
    body,
    torso,
    head,
    skull,
    eyes,
    pupils,
    brow,
    armLeft,
    armRight,
    legLeft,
    legRight,
    accessory,
    skinMaterial,
    accentMaterial,
    accessoryMaterial,
    detailMeshes: [eyes, pupils, brow, accessory],
    allMeshes,
  };
}

/**
 * Reshapes a rig into a given class and colour variant.
 * Called every time a pooled zombie is respawned.
 */
export function applyZombieType(rig: ZombieRig, def: ZombieTypeDef, colorIndex: number): void {
  const p = def.proportions;

  rig.root.scale.setScalar(def.scale);

  rig.torso.scale.set(p.bodyWidth, p.bodyHeight, p.bodyWidth);

  rig.head.position.y = 0.42 + 0.6 * p.bodyHeight + p.neck;
  rig.head.scale.setScalar(p.head);

  rig.eyes.scale.setScalar(p.eye);
  rig.pupils.scale.setScalar(p.eye);
  rig.brow.scale.set(p.eye, p.eye, p.eye);

  // Shoulders ride on the torso; hips stay near the origin.
  const shoulderY = 0.42 + 0.44 * p.bodyHeight;
  const shoulderX = 0.34 * p.bodyWidth + 0.08;
  rig.armLeft.position.set(-shoulderX, shoulderY, 0);
  rig.armRight.position.set(shoulderX, shoulderY, 0);
  rig.armLeft.scale.set(p.armThickness, p.armLength, p.armThickness);
  rig.armRight.scale.set(p.armThickness, p.armLength, p.armThickness);

  const hipX = 0.16 * p.bodyWidth;
  rig.legLeft.position.set(-hipX, 0.36, 0);
  rig.legRight.position.set(hipX, 0.36, 0);
  rig.legLeft.scale.set(p.legThickness, p.legLength, p.legThickness);
  rig.legRight.scale.set(p.legThickness, p.legLength, p.legThickness);

  const color = def.colors[colorIndex % def.colors.length];
  rig.skinMaterial.color.setHex(color);
  rig.skinMaterial.emissive.setHex(0x000000);
  // The face accent stays permanently dark — it represents hollows and
  // shadow, not a class colour.
  rig.accessoryMaterial.color.setHex(def.accentColor);
  rig.accessoryMaterial.emissive.setHex(0x000000);

  // The boss gets a crown; the exploder gets a glowing fuse-tip on its head.
  if (def.isBoss) {
    rig.accessory.visible = true;
    rig.accessory.scale.set(1.1, 1.2, 1.1);
    rig.accessory.position.y = 0.4;
    rig.accessoryMaterial.emissive.setHex(0x4a3200);
    rig.accessoryMaterial.emissiveIntensity = 0.6;
  } else if (def.explodes) {
    rig.accessory.visible = true;
    rig.accessory.scale.set(0.5, 0.7, 0.5);
    rig.accessory.position.y = 0.36;
    rig.accessoryMaterial.emissive.setHex(0xff5a1e);
    rig.accessoryMaterial.emissiveIntensity = 1.2;
  } else {
    rig.accessory.visible = false;
    rig.accessoryMaterial.emissiveIntensity = 0;
  }
}

/** Height of the zombie's head centre in local space — used for headshots. */
export function headHeightFor(def: ZombieTypeDef): number {
  const p = def.proportions;
  return (0.42 + 0.6 * p.bodyHeight + p.neck) * def.scale;
}

/** Approximate body radius for collision and hit detection. */
export function bodyRadiusFor(def: ZombieTypeDef): number {
  return 0.36 * def.proportions.bodyWidth * def.scale;
}

/**
 * The original primitive-based rig, wrapped behind the shared visual
 * interface. Still used by the boss, which keeps its stylised look while every
 * other class uses the skinned glTF character.
 */
export class ProceduralZombieVisual implements ZombieVisual {
  readonly rig: ZombieRig;
  readonly root: THREE.Object3D;

  bodyColor = 0x8fce8a;
  headHeight = 1.4;
  bodyRadius = 0.36;

  private def: ZombieTypeDef | null = null;
  private lod = -1;

  constructor() {
    this.rig = createZombieRig();
    this.root = this.rig.root;
    this.root.visible = true;
  }

  applyType(def: ZombieTypeDef, colorIndex: number): void {
    this.def = def;
    applyZombieType(this.rig, def, colorIndex);
    this.bodyColor = def.colors[colorIndex % def.colors.length];
    this.headHeight = headHeightFor(def);
    this.bodyRadius = bodyRadiusFor(def);
    // The entity owns the root's scale for spawn/death, so the rig's own
    // per-class scale is folded into the body node instead.
    this.rig.root.scale.setScalar(1);
    this.rig.body.scale.setScalar(def.scale);
  }

  resetPose(): void {
    this.rig.body.position.set(0, 0, 0);
    this.rig.body.rotation.set(0, 0, 0);
  }

  animate(state: ZombieAnimationState): void {
    const { rig } = this;
    const def = this.def;
    if (!def) return;

    const stride = state.stride;
    const phase = state.gaitPhase + state.phaseOffset;
    const swing = Math.sin(phase);
    const swing2 = Math.sin(phase * 2);
    const amp = 0.55 + stride * 0.55;
    const wobble = def.gaitWobble;

    if (state.deathProgress > 0) {
      const fall = Math.min(1, state.deathProgress * 1.5);
      rig.armLeft.rotation.set(-fall * 1.6, 0, -fall * 0.9);
      rig.armRight.rotation.set(-fall * 1.6, 0, fall * 0.9);
      rig.legLeft.rotation.set(fall * 0.9, 0, 0);
      rig.legRight.rotation.set(fall * 0.6, 0, 0);
      return;
    }

    rig.legLeft.rotation.x = swing * amp * 0.9;
    rig.legRight.rotation.x = -swing * amp * 0.9;
    rig.legLeft.rotation.z = 0.06 * wobble;
    rig.legRight.rotation.z = -0.06 * wobble;

    rig.body.position.y = Math.abs(swing2) * 0.07 * stride * wobble;
    rig.body.rotation.z = -swing * 0.1 * wobble * stride;
    rig.body.rotation.x = 0.13 + stride * 0.12;
    rig.body.rotation.y = swing * 0.09 * stride;

    if (state.attackWindup > 0) {
      const w = 1 - Math.max(0, state.attackWindup / Math.max(0.001, state.attackWindupDuration));
      const raise = Math.sin(w * Math.PI) * 1.5;
      rig.armLeft.rotation.set(-1.4 - raise, 0, 0.35);
      rig.armRight.rotation.set(-1.4 - raise, 0, -0.35);
      rig.body.rotation.x = 0.13 - raise * 0.18;
    } else if (state.isAttacking) {
      const grab = Math.sin(state.elapsed * 9 + state.phaseOffset) * 0.16;
      rig.armLeft.rotation.set(-1.5 + grab, 0, 0.28);
      rig.armRight.rotation.set(-1.5 - grab, 0, -0.28);
    } else {
      const reach = -0.55 + (-1.35 + 0.55) * stride;
      rig.armLeft.rotation.set(reach - swing * 0.42 * amp, 0, 0.2 + swing * 0.12 * wobble);
      rig.armRight.rotation.set(reach + swing * 0.42 * amp, 0, -0.2 + swing * 0.12 * wobble);
    }

    const headBob = Math.sin(phase * 2 + 0.7) * 0.13 * stride * wobble;
    rig.head.rotation.z = -rig.body.rotation.z * 1.4 + headBob * 0.4;
    rig.head.rotation.x = -rig.body.rotation.x * 0.75 + headBob * 0.35;
    rig.head.rotation.y = -swing * 0.14 * stride;

    rig.pupils.position.x = Math.max(-0.7, Math.min(0.7, state.lookOffset)) * 0.045;
  }

  setHitFlash(amount: number): void {
    const flash = amount * amount;
    if (flash > 0.001) {
      this.rig.skinMaterial.emissive.setRGB(flash, flash * 0.85, flash * 0.7);
      this.rig.skinMaterial.emissiveIntensity = 1;
    } else if (this.rig.skinMaterial.emissiveIntensity !== 0) {
      this.rig.skinMaterial.emissive.setRGB(0, 0, 0);
      this.rig.skinMaterial.emissiveIntensity = 0;
    }
  }

  setPrimingGlow(amount: number): void {
    if (amount <= 0.001) return;
    this.rig.skinMaterial.emissive.setRGB(1, 0.45, 0.15);
    this.rig.skinMaterial.emissiveIntensity = amount * 1.4;
  }

  setShadowsEnabled(enabled: boolean): void {
    this.rig.torso.castShadow = enabled;
    this.rig.skull.castShadow = enabled;
    (this.rig.armLeft.children[0] as THREE.Mesh).castShadow = enabled;
    (this.rig.armRight.children[0] as THREE.Mesh).castShadow = enabled;
    (this.rig.legLeft.children[0] as THREE.Mesh).castShadow = enabled;
    (this.rig.legRight.children[0] as THREE.Mesh).castShadow = enabled;
  }

  setLod(level: number): void {
    if (level === this.lod) return;
    this.lod = level;
    for (const mesh of this.rig.detailMeshes) {
      if (mesh === this.rig.accessory) continue;
      mesh.visible = level <= 1;
    }
    this.rig.brow.visible = level === 0;
  }

  dispose(): void {
    this.rig.skinMaterial.dispose();
    this.rig.accentMaterial.dispose();
    this.rig.accessoryMaterial.dispose();
  }
}

export function disposeSharedZombieAssets(): void {
  if (sharedGeometry) {
    for (const geometry of Object.values(sharedGeometry)) geometry.dispose();
    sharedGeometry = null;
  }
  eyeWhiteMaterial?.dispose();
  pupilMaterial?.dispose();
  eyeWhiteMaterial = null;
  pupilMaterial = null;
}
