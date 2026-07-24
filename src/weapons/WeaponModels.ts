import * as THREE from 'three';
import { metalTexture, woodPlankTexture } from '../textures/ProceduralTextures';
import { applyStylizedShading } from '../textures/StylizedMaterial';
import type { WeaponId } from './WeaponDefs';

/**
 * Procedural weapon viewmodels.
 *
 * Every gun is assembled from rounded boxes and cylinders in a deliberately
 * chunky, toy-like silhouette — oversized muzzles, fat grips, candy-coloured
 * accents — so they sit alongside the zombies rather than looking like military
 * hardware dropped into a storybook.
 *
 * Each model exposes named sub-objects (slide, pump, bolt, magazine) that the
 * runtime animates for firing and reloading.
 */

export interface WeaponModel {
  root: THREE.Group;
  /** World anchor for muzzle flash, smoke and tracers. */
  muzzle: THREE.Object3D;
  /** Where spent casings are ejected from. */
  ejectPort: THREE.Object3D;
  /** Reciprocates on every shot (pistol slide, rifle bolt carrier). */
  slide?: THREE.Object3D;
  /** Detaches and drops during a magazine reload. */
  magazine?: THREE.Object3D;
  /** Pumped between shots (shotgun) or cycled manually (sniper bolt). */
  action?: THREE.Object3D;
  /** Scope body, hidden while the sniper is aimed so the overlay reads clean. */
  scope?: THREE.Object3D;
}

// --- Shared materials --------------------------------------------------------

let cachedMaterials: Record<string, THREE.Material> | null = null;

function weaponMaterials(): Record<string, THREE.Material> {
  if (cachedMaterials) return cachedMaterials;

  const stylize = (mat: THREE.MeshStandardMaterial, rim = 0.75): THREE.Material =>
    applyStylizedShading(mat, { rimColor: 0xffd0a0, rimStrength: rim, rimPower: 2.0 });

  cachedMaterials = {
    body: stylize(
      new THREE.MeshStandardMaterial({ map: metalTexture(0x4a4d59), roughness: 0.42, metalness: 0.65 }),
    ),
    dark: stylize(
      new THREE.MeshStandardMaterial({ map: metalTexture(0x2c2e38), roughness: 0.5, metalness: 0.55 }),
    ),
    accent: stylize(new THREE.MeshStandardMaterial({ color: 0xff8a5c, roughness: 0.35, metalness: 0.2 }), 1.0),
    accentCool: stylize(new THREE.MeshStandardMaterial({ color: 0x5fc8e8, roughness: 0.35, metalness: 0.2 }), 1.0),
    gold: stylize(
      new THREE.MeshStandardMaterial({ map: metalTexture(0xe0ab4d), roughness: 0.24, metalness: 0.9 }),
      1.1,
    ),
    grip: stylize(new THREE.MeshStandardMaterial({ color: 0x3a3340, roughness: 0.85, metalness: 0.05 }), 0.5),
    wood: stylize(
      new THREE.MeshStandardMaterial({ map: woodPlankTexture(0x9a6438, 3), roughness: 0.7, metalness: 0 }),
      0.6,
    ),
    glass: new THREE.MeshStandardMaterial({
      color: 0x88ddff,
      roughness: 0.06,
      metalness: 0.2,
      emissive: 0x225577,
      emissiveIntensity: 0.6,
    }),
  };
  return cachedMaterials;
}

// --- Geometry helpers --------------------------------------------------------

/** Rounded box via a heavily-segmented, slightly inflated box. */
function roundedBox(w: number, h: number, d: number, radius = 0.012): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const half = new THREE.Vector3(w * 0.5, h * 0.5, d * 0.5);
  const v = new THREE.Vector3();

  // Pull each corner vertex toward the inner box, then push it back out along
  // the diagonal — a cheap approximation of a filleted edge.
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const inner = new THREE.Vector3(
      THREE.MathUtils.clamp(v.x, -half.x + radius, half.x - radius),
      THREE.MathUtils.clamp(v.y, -half.y + radius, half.y - radius),
      THREE.MathUtils.clamp(v.z, -half.z + radius, half.z - radius),
    );
    const offset = v.clone().sub(inner);
    if (offset.lengthSq() > 1e-9) {
      offset.setLength(radius);
      v.copy(inner).add(offset);
      position.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

function part(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  rotX = 0,
  rotY = 0,
  rotZ = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rotX, rotY, rotZ);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

function anchor(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  const obj = new THREE.Object3D();
  obj.position.set(x, y, z);
  parent.add(obj);
  return obj;
}

function cyl(radius: number, height: number, segments = 12): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(radius, radius, height, segments);
}

// --- Individual weapons ------------------------------------------------------

function buildPistol(): WeaponModel {
  const m = weaponMaterials();
  const root = new THREE.Group();

  // Grip, angled back like a real pistol frame.
  part(root, roundedBox(0.062, 0.15, 0.07), m.grip, 0, -0.09, 0.026, 0.24);
  part(root, roundedBox(0.05, 0.02, 0.062), m.gold, 0, -0.164, 0.038, 0.24);

  // Frame + trigger guard.
  part(root, roundedBox(0.06, 0.05, 0.2), m.dark, 0, -0.012, -0.03);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.008, 6, 14, Math.PI), m.dark);
  guard.rotation.set(Math.PI * 0.5, 0, Math.PI);
  guard.position.set(0, -0.052, -0.005);
  root.add(guard);
  part(root, roundedBox(0.012, 0.03, 0.012), m.gold, 0, -0.048, -0.005, -0.2);

  // Reciprocating slide.
  const slide = new THREE.Group();
  root.add(slide);
  part(slide, roundedBox(0.066, 0.058, 0.28), m.body, 0, 0.032, -0.06);
  // Cocking serrations.
  for (let i = 0; i < 5; i++) {
    part(slide, roundedBox(0.07, 0.04, 0.007, 0.002), m.dark, 0, 0.032, 0.045 - i * 0.016);
  }
  part(slide, roundedBox(0.05, 0.012, 0.09), m.accent, 0, 0.062, -0.14);
  // Sights.
  part(slide, roundedBox(0.01, 0.014, 0.012), m.gold, 0, 0.068, -0.185);
  part(slide, roundedBox(0.026, 0.014, 0.012), m.dark, 0, 0.068, 0.05);

  // Barrel poking out of the slide.
  part(slide, cyl(0.017, 0.075), m.gold, 0, 0.032, -0.222, Math.PI * 0.5);
  part(slide, cyl(0.024, 0.02, 14), m.accent, 0, 0.032, -0.252, Math.PI * 0.5);

  const magazine = new THREE.Group();
  root.add(magazine);
  part(magazine, roundedBox(0.05, 0.13, 0.055), m.dark, 0, -0.095, 0.028, 0.24);

  return {
    root,
    muzzle: anchor(root, 0, 0.032, -0.27),
    ejectPort: anchor(root, 0.04, 0.05, -0.02),
    slide,
    magazine,
  };
}

function buildSmg(): WeaponModel {
  const m = weaponMaterials();
  const root = new THREE.Group();

  part(root, roundedBox(0.07, 0.085, 0.34), m.body, 0, 0, -0.08);
  part(root, roundedBox(0.075, 0.022, 0.3), m.accentCool, 0, 0.05, -0.08);
  part(root, roundedBox(0.058, 0.14, 0.06), m.grip, 0, -0.1, 0.05, 0.3);

  // Collapsible wire stock.
  for (const side of [-1, 1]) {
    part(root, cyl(0.008, 0.16, 6), m.dark, side * 0.026, 0.01, 0.16, Math.PI * 0.5);
  }
  part(root, roundedBox(0.07, 0.06, 0.03), m.grip, 0, 0.01, 0.235);

  // Foregrip.
  part(root, roundedBox(0.035, 0.09, 0.045), m.grip, 0, -0.07, -0.16, -0.18);

  // Barrel shroud with cooling holes suggested by rings.
  part(root, cyl(0.024, 0.16, 12), m.dark, 0, 0.012, -0.3, Math.PI * 0.5);
  for (let i = 0; i < 4; i++) {
    part(root, cyl(0.029, 0.012, 12), m.accentCool, 0, 0.012, -0.25 - i * 0.032, Math.PI * 0.5);
  }
  part(root, cyl(0.03, 0.026, 14), m.accentCool, 0, 0.012, -0.386, Math.PI * 0.5);

  const slide = new THREE.Group();
  root.add(slide);
  part(slide, roundedBox(0.02, 0.02, 0.07), m.gold, 0.042, 0.036, -0.02);

  const magazine = new THREE.Group();
  root.add(magazine);
  part(magazine, roundedBox(0.042, 0.2, 0.07), m.dark, 0, -0.14, -0.05, -0.12);
  part(magazine, roundedBox(0.046, 0.02, 0.072), m.accentCool, 0, -0.235, -0.038, -0.12);

  part(root, roundedBox(0.012, 0.02, 0.012), m.gold, 0, 0.07, -0.22);
  part(root, roundedBox(0.03, 0.022, 0.012), m.dark, 0, 0.07, 0.03);

  return {
    root,
    muzzle: anchor(root, 0, 0.012, -0.4),
    ejectPort: anchor(root, 0.045, 0.036, -0.02),
    slide,
    magazine,
  };
}

function buildShotgun(): WeaponModel {
  const m = weaponMaterials();
  const root = new THREE.Group();

  // Receiver.
  part(root, roundedBox(0.075, 0.095, 0.26), m.body, 0, 0, -0.02);
  part(root, roundedBox(0.08, 0.02, 0.22), m.accent, 0, 0.056, -0.02);

  // Wooden furniture: stock and grip.
  part(root, roundedBox(0.062, 0.11, 0.26), m.wood, 0, -0.045, 0.22, 0.12);
  part(root, roundedBox(0.066, 0.055, 0.05), m.dark, 0, -0.082, 0.345, 0.12);

  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.008, 6, 14, Math.PI), m.dark);
  guard.rotation.set(Math.PI * 0.5, 0, Math.PI);
  guard.position.set(0, -0.056, 0.03);
  root.add(guard);
  part(root, roundedBox(0.012, 0.03, 0.012), m.gold, 0, -0.05, 0.03, -0.2);

  // Twin tubes: barrel over magazine.
  part(root, cyl(0.026, 0.52, 14), m.dark, 0, 0.028, -0.36, Math.PI * 0.5);
  part(root, cyl(0.022, 0.44, 12), m.body, 0, -0.026, -0.32, Math.PI * 0.5);
  part(root, cyl(0.034, 0.03, 16), m.accent, 0, 0.028, -0.61, Math.PI * 0.5);

  // Sliding pump.
  const action = new THREE.Group();
  root.add(action);
  part(action, roundedBox(0.058, 0.06, 0.14, 0.02), m.wood, 0, -0.024, -0.28);
  for (let i = 0; i < 4; i++) {
    part(action, roundedBox(0.062, 0.05, 0.008, 0.002), m.dark, 0, -0.024, -0.34 + i * 0.03);
  }

  part(root, roundedBox(0.012, 0.018, 0.012), m.gold, 0, 0.06, -0.55);

  return {
    root,
    muzzle: anchor(root, 0, 0.028, -0.63),
    ejectPort: anchor(root, 0.045, 0.02, 0.02),
    action,
  };
}

function buildRifle(): WeaponModel {
  const m = weaponMaterials();
  const root = new THREE.Group();

  part(root, roundedBox(0.072, 0.1, 0.32), m.body, 0, 0, -0.04);
  part(root, roundedBox(0.078, 0.024, 0.44), m.dark, 0, 0.062, -0.12);

  // Carry handle / optic riser.
  part(root, roundedBox(0.03, 0.05, 0.12), m.dark, 0, 0.098, -0.02);
  part(root, roundedBox(0.05, 0.02, 0.05), m.accent, 0, 0.122, -0.02);

  part(root, roundedBox(0.06, 0.145, 0.062), m.grip, 0, -0.105, 0.055, 0.28);
  part(root, roundedBox(0.068, 0.085, 0.24), m.grip, 0, -0.01, 0.22, 0.04);
  part(root, roundedBox(0.072, 0.1, 0.04), m.dark, 0, -0.02, 0.345, 0.04);

  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.008, 6, 14, Math.PI), m.dark);
  guard.rotation.set(Math.PI * 0.5, 0, Math.PI);
  guard.position.set(0, -0.058, 0.04);
  root.add(guard);

  // Handguard with vent slots.
  part(root, roundedBox(0.06, 0.062, 0.24), m.dark, 0, 0.006, -0.28);
  for (let i = 0; i < 5; i++) {
    part(root, roundedBox(0.066, 0.012, 0.03), m.accent, 0, 0.006, -0.2 - i * 0.042);
  }

  part(root, cyl(0.019, 0.2, 12), m.body, 0, 0.006, -0.48, Math.PI * 0.5);
  // Chunky muzzle brake.
  part(root, cyl(0.032, 0.06, 14), m.accent, 0, 0.006, -0.59, Math.PI * 0.5);
  for (let i = 0; i < 2; i++) {
    part(root, roundedBox(0.07, 0.012, 0.012), m.dark, 0, 0.006, -0.575 - i * 0.025);
  }

  const slide = new THREE.Group();
  root.add(slide);
  part(slide, roundedBox(0.022, 0.022, 0.075), m.gold, 0.044, 0.04, 0.02);

  const magazine = new THREE.Group();
  root.add(magazine);
  const mag = part(magazine, roundedBox(0.045, 0.19, 0.078), m.dark, 0, -0.13, -0.06, -0.1);
  mag.rotation.x = -0.1;
  part(magazine, roundedBox(0.05, 0.02, 0.082), m.accent, 0, -0.224, -0.05, -0.1);

  part(root, roundedBox(0.012, 0.024, 0.012), m.gold, 0, 0.086, -0.42);

  return {
    root,
    muzzle: anchor(root, 0, 0.006, -0.62),
    ejectPort: anchor(root, 0.048, 0.04, 0.02),
    slide,
    magazine,
  };
}

function buildSniper(): WeaponModel {
  const m = weaponMaterials();
  const root = new THREE.Group();

  part(root, roundedBox(0.07, 0.095, 0.36), m.body, 0, 0, -0.02);
  part(root, roundedBox(0.062, 0.15, 0.065), m.grip, 0, -0.105, 0.08, 0.26);
  part(root, roundedBox(0.07, 0.11, 0.3), m.wood, 0, -0.02, 0.28, 0.05);
  part(root, roundedBox(0.074, 0.12, 0.04), m.dark, 0, -0.035, 0.42, 0.05);
  // Cheek riser.
  part(root, roundedBox(0.06, 0.045, 0.16), m.grip, 0, 0.062, 0.24);

  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.008, 6, 14, Math.PI), m.dark);
  guard.rotation.set(Math.PI * 0.5, 0, Math.PI);
  guard.position.set(0, -0.055, 0.06);
  root.add(guard);

  // Long fluted barrel.
  part(root, cyl(0.022, 0.62, 14), m.dark, 0, 0.01, -0.5, Math.PI * 0.5);
  for (let i = 0; i < 6; i++) {
    part(root, cyl(0.026, 0.014, 14), m.body, 0, 0.01, -0.3 - i * 0.07, Math.PI * 0.5);
  }
  part(root, cyl(0.036, 0.07, 16), m.gold, 0, 0.01, -0.83, Math.PI * 0.5);

  // Scope assembly.
  const scope = new THREE.Group();
  root.add(scope);
  part(scope, cyl(0.038, 0.3, 16), m.dark, 0, 0.115, -0.1, Math.PI * 0.5);
  part(scope, cyl(0.05, 0.07, 16), m.dark, 0, 0.115, -0.24, Math.PI * 0.5);
  part(scope, cyl(0.045, 0.05, 16), m.dark, 0, 0.115, 0.03, Math.PI * 0.5);
  part(scope, cyl(0.046, 0.006, 16), m.glass, 0, 0.115, -0.276, Math.PI * 0.5);
  part(scope, cyl(0.041, 0.006, 16), m.glass, 0, 0.115, 0.056, Math.PI * 0.5);
  // Turrets + rings.
  part(scope, cyl(0.018, 0.03, 10), m.gold, 0, 0.156, -0.1);
  part(scope, cyl(0.018, 0.03, 10), m.gold, 0.038, 0.115, -0.1, 0, 0, Math.PI * 0.5);
  for (const z of [-0.19, -0.01]) {
    part(scope, roundedBox(0.05, 0.06, 0.024), m.body, 0, 0.085, z);
  }

  // Folding bipod.
  for (const side of [-1, 1]) {
    part(root, cyl(0.008, 0.16, 6), m.dark, side * 0.03, -0.06, -0.52, 0, 0, side * 0.42);
  }

  // Bolt handle — cycled after every shot.
  const action = new THREE.Group();
  root.add(action);
  part(action, cyl(0.011, 0.09, 8), m.gold, 0.05, 0.036, 0.06, 0, 0, Math.PI * 0.5);
  part(action, new THREE.SphereGeometry(0.019, 10, 8), m.gold, 0.092, 0.036, 0.06);

  return {
    root,
    muzzle: anchor(root, 0, 0.01, -0.87),
    ejectPort: anchor(root, 0.05, 0.05, 0.05),
    action,
    scope,
  };
}

const BUILDERS: Record<WeaponId, () => WeaponModel> = {
  pistol: buildPistol,
  smg: buildSmg,
  shotgun: buildShotgun,
  rifle: buildRifle,
  sniper: buildSniper,
};

/** Builds the viewmodel for a weapon. Called once per weapon on first equip. */
export function createWeaponModel(id: WeaponId): WeaponModel {
  const model = BUILDERS[id]();
  model.root.name = `weapon:${id}`;
  // Viewmodels render after the world with a dedicated near clip so they can
  // never poke through walls.
  model.root.traverse((obj) => {
    obj.renderOrder = 10;
    obj.frustumCulled = false;
  });
  return model;
}

export function disposeWeaponModel(model: WeaponModel): void {
  model.root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    // Materials are shared across all weapons, so only geometry is disposed.
    mesh.geometry?.dispose();
  });
}
