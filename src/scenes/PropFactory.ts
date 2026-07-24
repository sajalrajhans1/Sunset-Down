import * as THREE from 'three';
import { MeshBatcher, Primitives } from './MeshBatcher';
import { MATERIAL_IMPACT_COLOR, materials, type MaterialKey } from './MaterialLibrary';
import type { CollisionWorld } from '../systems/CollisionWorld';
import { signTexture } from '../textures/ProceduralTextures';
import { stylizedStandard } from '../textures/StylizedMaterial';
import { TAU } from '../utilities/MathUtils';

/**
 * Builders for every piece of set dressing in the village.
 *
 * Each builder writes static geometry into the batcher, registers the collision
 * volumes it needs, and (for a handful of hero props) returns an animated node.
 * Nothing here touches the scene graph directly — the Village owns assembly.
 */

export interface BuildContext {
  batcher: MeshBatcher;
  collision: CollisionWorld;
  /** Seeded RNG so the town is laid out identically every session. */
  rand: () => number;
  /** Container for props that animate and therefore can't be batched. */
  dynamic: THREE.Group;
  /** Requested point lights; the Village keeps only the best N for the preset. */
  lightRequests: LightRequest[];
}

export interface LightRequest {
  position: THREE.Vector3;
  color: number;
  intensity: number;
  distance: number;
  /** Higher priority lights survive when the budget is tight. */
  priority: number;
}

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();

/** Queues a primitive with a full TRS transform. */
function place(
  ctx: BuildContext,
  material: MaterialKey,
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  rotY = 0,
  rotX = 0,
  rotZ = 0,
): void {
  _euler.set(rotX, rotY, rotZ, 'YXZ');
  _quat.setFromEuler(_euler);
  _pos.set(x, y, z);
  _scale.set(sx, sy, sz);
  _matrix.compose(_pos, _quat, _scale);
  ctx.batcher.add(material, geometry, _matrix);
}

function impactColorFor(material: MaterialKey): number {
  return MATERIAL_IMPACT_COLOR[material] ?? 0xd8c8b0;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export interface CottageOptions {
  x: number;
  z: number;
  rotation: number;
  width: number;
  depth: number;
  storeys: number;
  plaster: MaterialKey;
  roof: MaterialKey;
  awning?: MaterialKey;
  sign?: { text: string; bg: number; fg: number };
  /** Slight lean makes the town read as hand-built rather than CAD-perfect. */
  lean?: number;
}

/**
 * A half-timbered storybook cottage: plaster body, exposed dark beams, scalloped
 * roof with a generous overhang, glowing windows, and optional awning + sign.
 */
export function buildCottage(ctx: BuildContext, options: CottageOptions): void {
  const {
    x,
    z,
    rotation,
    width,
    depth,
    storeys,
    plaster,
    roof,
    awning,
    sign,
    lean = 0,
  } = options;

  const storeyHeight = 2.9;
  const bodyHeight = storeys * storeyHeight;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  /** Maps a point in the cottage's local frame into world space. */
  const toWorld = (lx: number, lz: number): [number, number] => [
    x + lx * cos - lz * sin,
    z + lx * sin + lz * cos,
  ];

  // --- Body ---------------------------------------------------------------
  place(ctx, plaster, Primitives.boxBase, x, 0, z, width, bodyHeight, depth, rotation, 0, lean);

  // Upper storeys jetty outward, a signature of the timber-framed look.
  if (storeys > 1) {
    place(
      ctx,
      plaster,
      Primitives.boxBase,
      x,
      storeyHeight,
      z,
      width * 1.09,
      bodyHeight - storeyHeight,
      depth * 1.09,
      rotation,
      0,
      lean,
    );
  }

  // --- Timber frame -------------------------------------------------------
  const beam = 0.19;
  const halfW = width * 0.5;
  const halfD = depth * 0.5;

  // Corner posts.
  for (const [ox, oz] of [
    [-halfW, -halfD],
    [halfW, -halfD],
    [-halfW, halfD],
    [halfW, halfD],
  ]) {
    const [wx, wz] = toWorld(ox, oz);
    place(ctx, 'timber.dark', Primitives.boxBase, wx, 0, wz, beam * 1.6, bodyHeight, beam * 1.6, rotation);
  }

  // Horizontal bands at every floor line and under the eaves.
  for (let s = 1; s <= storeys; s++) {
    const y = s * storeyHeight - 0.12;
    const w = s > 1 ? width * 1.1 : width * 1.01;
    const d = s > 1 ? depth * 1.1 : depth * 1.01;
    place(ctx, 'timber.dark', Primitives.boxBase, x, y, z, w, 0.26, d, rotation);
  }

  // Decorative diagonals on the front face.
  const frontZ = -halfD - 0.02;
  for (let s = 0; s < storeys; s++) {
    const baseY = s * storeyHeight + 0.3;
    const braceLen = storeyHeight * 0.82;
    for (const dir of [-1, 1]) {
      const [wx, wz] = toWorld(dir * width * 0.3, frontZ);
      place(
        ctx,
        'timber.dark',
        Primitives.boxBase,
        wx,
        baseY,
        wz,
        beam,
        braceLen,
        beam,
        rotation,
        0,
        dir * 0.42,
      );
    }
  }

  // --- Roof ---------------------------------------------------------------
  const roofHeight = 1.5 + depth * 0.2;
  const overhang = 0.55;
  const roofWidth = (storeys > 1 ? width * 1.09 : width) + overhang * 2;
  const roofDepth = (storeys > 1 ? depth * 1.09 : depth) + overhang * 2;

  place(ctx, roof, Primitives.prism, x, bodyHeight, z, roofWidth, roofHeight, roofDepth, rotation, 0, lean);

  // Ridge cap and eave trim.
  place(
    ctx,
    'timber.dark',
    Primitives.boxBase,
    x,
    bodyHeight + roofHeight - 0.08,
    z,
    0.22,
    0.16,
    roofDepth * 0.98,
    rotation,
  );
  place(ctx, 'wood.light', Primitives.boxBase, x, bodyHeight - 0.16, z, roofWidth, 0.17, roofDepth, rotation);

  // --- Chimney ------------------------------------------------------------
  if (ctx.rand() < 0.75) {
    const chimneyOffsetX = (ctx.rand() - 0.5) * width * 0.5;
    const chimneyOffsetZ = (ctx.rand() - 0.5) * depth * 0.35;
    const [cxw, czw] = toWorld(chimneyOffsetX, chimneyOffsetZ);
    const chimneyH = roofHeight + 0.9;
    place(ctx, 'stone.pale', Primitives.boxBase, cxw, bodyHeight - 0.4, czw, 0.75, chimneyH, 0.68, rotation);
    place(ctx, 'stone.dark', Primitives.boxBase, cxw, bodyHeight - 0.4 + chimneyH, czw, 0.92, 0.18, 0.85, rotation);
  }

  // --- Door ---------------------------------------------------------------
  const [doorX, doorZ] = toWorld(0, frontZ);
  place(ctx, 'wood.warm', Primitives.boxBase, doorX, 0, doorZ, 1.05, 2.05, 0.16, rotation);
  place(ctx, 'timber.dark', Primitives.boxBase, doorX, 0, doorZ, 1.25, 2.2, 0.1, rotation);
  place(ctx, 'metal.gold', Primitives.sphere, doorX + 0.34 * cos, 1.05, doorZ + 0.34 * sin, 0.11, 0.11, 0.11, rotation);

  // --- Windows ------------------------------------------------------------
  const windowsPerStorey = width > 5 ? 2 : 1;
  for (let s = 0; s < storeys; s++) {
    const y = s * storeyHeight + 1.35;
    const isGround = s === 0;
    for (let i = 0; i < windowsPerStorey; i++) {
      const spread = windowsPerStorey === 1 ? 0 : (i === 0 ? -1 : 1) * width * 0.26;
      // Ground floor keeps the centre clear for the door.
      const lx = isGround ? (windowsPerStorey === 1 ? width * 0.3 : spread) : spread;

      for (const face of [-1, 1] as const) {
        // Only the front and back faces get windows; sides stay plain.
        if (face === 1 && ctx.rand() < 0.45) continue;
        const lz = face * (halfD * (s > 0 ? 1.09 : 1) + 0.06);
        const [wx, wz] = toWorld(lx, lz);
        place(ctx, 'window.glow', Primitives.plane, wx, y, wz, 1.0, 1.15, 1, rotation + (face === 1 ? Math.PI : 0));
        // Frame + shutters.
        place(ctx, 'wood.light', Primitives.boxBase, wx, y - 0.62, wz, 1.22, 0.12, 0.16, rotation);
        for (const side of [-1, 1]) {
          const [sx2, sz2] = toWorld(lx + side * 0.72, lz);
          place(ctx, face === 1 ? 'wood.warm' : 'plaster.mint', Primitives.boxBase, sx2, y - 0.55, sz2, 0.34, 1.1, 0.09, rotation);
        }
        // Flower box under ground-floor windows.
        if (isGround && ctx.rand() < 0.7) {
          const [fx, fz] = toWorld(lx, lz + face * 0.16);
          place(ctx, 'wood.warm', Primitives.boxBase, fx, y - 0.78, fz, 1.05, 0.28, 0.32, rotation);
          const flowerMats: MaterialKey[] = ['flower.pink', 'flower.yellow', 'flower.violet'];
          for (let f = 0; f < 5; f++) {
            const [bx, bz] = toWorld(lx - 0.4 + f * 0.2, lz + face * 0.16);
            place(
              ctx,
              flowerMats[(ctx.rand() * flowerMats.length) | 0],
              Primitives.sphereLow,
              bx,
              y - 0.52,
              bz,
              0.22,
              0.2,
              0.22,
              rotation,
            );
          }
        }
      }
    }
  }

  // Warm spill from the ground-floor windows onto the street.
  const [spillX, spillZ] = toWorld(0, frontZ - 1.2);
  ctx.lightRequests.push({
    position: new THREE.Vector3(spillX, 2.1, spillZ),
    color: 0xffb066,
    intensity: 2.2,
    distance: 11,
    priority: 2,
  });

  // --- Awning -------------------------------------------------------------
  if (awning) {
    const [ax, az] = toWorld(0, frontZ - 0.75);
    place(ctx, awning, Primitives.plane, ax, 2.55, az, width * 0.92, 1.7, 1, rotation, -Math.PI * 0.28);
    for (const side of [-1, 1]) {
      const [px, pz] = toWorld(side * width * 0.42, frontZ - 1.4);
      place(ctx, 'wood.warm', Primitives.boxBase, px, 0, pz, 0.11, 2.35, 0.11, rotation);
    }
  }

  // --- Hanging sign -------------------------------------------------------
  if (sign) {
    const [sx, sz] = toWorld(width * 0.34, frontZ - 0.9);
    place(ctx, 'metal.iron', Primitives.boxBase, sx, 2.6, sz, 0.07, 0.5, 0.07, rotation);
    const signMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.85),
      stylizedStandard(
        { map: signTexture(sign.text, sign.bg, sign.fg), side: THREE.DoubleSide, roughness: 0.8 },
        { rimStrength: 0.4 },
      ),
    );
    signMesh.position.set(sx, 2.25, sz);
    signMesh.rotation.y = rotation;
    signMesh.castShadow = true;
    signMesh.userData.swing = { phase: ctx.rand() * TAU, amplitude: 0.06 + ctx.rand() * 0.05 };
    ctx.dynamic.add(signMesh);
  }

  // --- Collision ----------------------------------------------------------
  ctx.collision.addBox({
    x,
    z,
    hx: width * 0.5 * (storeys > 1 ? 1.09 : 1),
    hz: depth * 0.5 * (storeys > 1 ? 1.09 : 1),
    rotation,
    baseY: 0,
    height: bodyHeight + roofHeight,
    solid: true,
    impactColor: impactColorFor(plaster),
  });
}

// ---------------------------------------------------------------------------
// Carnival structures
// ---------------------------------------------------------------------------

/** Big-top style tent: a striped cone on a cylindrical wall, with bunting. */
export function buildTent(
  ctx: BuildContext,
  x: number,
  z: number,
  radius: number,
  stripe: MaterialKey,
): void {
  const wallHeight = 2.3;
  const roofHeight = radius * 1.05;

  place(ctx, stripe, Primitives.cylinderSmooth, x, 0, z, radius * 2, wallHeight, radius * 2);
  place(ctx, stripe, Primitives.cone, x, wallHeight, z, radius * 2.25, roofHeight, radius * 2.25);

  // Scalloped valance where the roof meets the wall.
  const scallops = 14;
  for (let i = 0; i < scallops; i++) {
    const a = (i / scallops) * TAU;
    place(
      ctx,
      'fabric.cream',
      Primitives.sphereLow,
      x + Math.cos(a) * radius * 1.09,
      wallHeight - 0.1,
      z + Math.sin(a) * radius * 1.09,
      0.42,
      0.32,
      0.2,
      -a,
    );
  }

  // Finial + pennant.
  place(ctx, 'metal.gold', Primitives.sphere, x, wallHeight + roofHeight, z, 0.3, 0.42, 0.3);
  place(ctx, 'canvas.red', Primitives.plane, x + 0.42, wallHeight + roofHeight + 0.35, z, 0.85, 0.42, 1);

  // Entrance posts framing a gap in the wall.
  for (const side of [-1, 1]) {
    place(
      ctx,
      'wood.warm',
      Primitives.boxBase,
      x + side * radius * 0.42,
      0,
      z - radius * 0.98,
      0.16,
      wallHeight + 0.4,
      0.16,
    );
  }

  ctx.lightRequests.push({
    position: new THREE.Vector3(x, wallHeight + 0.6, z),
    color: 0xffc27a,
    intensity: 3.0,
    distance: 16,
    priority: 4,
  });

  ctx.collision.addCylinder({
    x,
    z,
    radius: radius * 1.02,
    baseY: 0,
    height: wallHeight + roofHeight,
    solid: true,
    impactColor: 0xe8836f,
  });
}

/** Market stall: counter, striped canopy, produce crates. */
export function buildMarketStall(
  ctx: BuildContext,
  x: number,
  z: number,
  rotation: number,
  stripe: MaterialKey,
): void {
  const width = 2.8;
  const depth = 1.5;

  place(ctx, 'wood.warm', Primitives.boxBase, x, 0, z, width, 1.05, depth, rotation);
  place(ctx, 'wood.light', Primitives.boxBase, x, 1.05, z, width + 0.24, 0.14, depth + 0.24, rotation);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = sx * width * 0.44;
      const lz = sz * depth * 0.4;
      place(
        ctx,
        'wood.warm',
        Primitives.boxBase,
        x + lx * Math.cos(rotation) - lz * Math.sin(rotation),
        0,
        z + lx * Math.sin(rotation) + lz * Math.cos(rotation),
        0.1,
        2.4,
        0.1,
      );
    }
  }

  place(ctx, stripe, Primitives.plane, x, 2.55, z, width + 0.7, depth + 1.5, 1, rotation, -Math.PI * 0.5);

  // Produce heaped on the counter.
  const produce: MaterialKey[] = ['flower.yellow', 'foliage.crimson', 'foliage.green', 'flower.violet'];
  for (let i = 0; i < 9; i++) {
    const lx = (ctx.rand() - 0.5) * width * 0.8;
    const lz = (ctx.rand() - 0.5) * depth * 0.6;
    place(
      ctx,
      produce[(ctx.rand() * produce.length) | 0],
      Primitives.sphereLow,
      x + lx * Math.cos(rotation) - lz * Math.sin(rotation),
      1.14,
      z + lx * Math.sin(rotation) + lz * Math.cos(rotation),
      0.22,
      0.2,
      0.22,
    );
  }

  ctx.collision.addBox({
    x,
    z,
    hx: width * 0.5,
    hz: depth * 0.5,
    rotation,
    baseY: 0,
    height: 1.2,
    solid: true,
    impactColor: 0x9c6b42,
  });
}

// ---------------------------------------------------------------------------
// Small props
// ---------------------------------------------------------------------------

export function buildBarrel(ctx: BuildContext, x: number, z: number, tipped = false): void {
  const height = 1.05;
  const radius = 0.42;
  if (tipped) {
    place(ctx, 'wood.warm', Primitives.cylinder, x, radius, z, radius * 2, height, radius * 2, 0, 0, Math.PI * 0.5);
    ctx.collision.addCylinder({ x, z, radius: radius * 1.1, baseY: 0, height: radius * 2, impactColor: 0x9c6b42 });
    return;
  }
  place(ctx, 'wood.warm', Primitives.cylinder, x, 0, z, radius * 2.05, height, radius * 2.05);
  for (const y of [0.18, 0.82]) {
    place(ctx, 'metal.iron', Primitives.cylinder, x, height * y, z, radius * 2.2, 0.1, radius * 2.2);
  }
  place(ctx, 'wood.light', Primitives.cylinder, x, height, z, radius * 1.9, 0.07, radius * 1.9);
  ctx.collision.addCylinder({ x, z, radius: radius * 1.05, baseY: 0, height, impactColor: 0x9c6b42 });
}

export function buildCrateStack(ctx: BuildContext, x: number, z: number, count: number): void {
  let y = 0;
  for (let i = 0; i < count; i++) {
    const size = 0.85 - i * 0.06;
    const jitterX = (ctx.rand() - 0.5) * 0.18;
    const jitterZ = (ctx.rand() - 0.5) * 0.18;
    const rot = (ctx.rand() - 0.5) * 0.5;
    place(ctx, 'wood.crate', Primitives.boxBase, x + jitterX, y, z + jitterZ, size, size, size, rot);
    // Cross-bracing on the crate faces.
    place(ctx, 'wood.warm', Primitives.boxBase, x + jitterX, y + size * 0.5, z + jitterZ, size * 1.02, 0.08, size * 1.02, rot);
    y += size;
  }
  ctx.collision.addBox({ x, z, hx: 0.48, hz: 0.48, rotation: 0, baseY: 0, height: y, impactColor: 0xb98b56 });
}

export function buildHayBale(ctx: BuildContext, x: number, z: number, rotation: number): void {
  place(ctx, 'flower.yellow', Primitives.cylinder, x, 0.5, z, 1.05, 1.25, 1.05, rotation, 0, Math.PI * 0.5);
  place(ctx, 'wood.warm', Primitives.torus, x, 0.5, z, 1.1, 1.1, 1.35, rotation + Math.PI * 0.5);
  ctx.collision.addCylinder({ x, z, radius: 0.6, baseY: 0, height: 1.05, impactColor: 0xe8c86a });
}

/** Wrought-iron lamp post with a glowing globe — a key light source at dusk. */
export function buildLampPost(ctx: BuildContext, x: number, z: number): void {
  const height = 3.7;
  place(ctx, 'metal.dark', Primitives.cylinder, x, 0, z, 0.34, 0.22, 0.34);
  place(ctx, 'metal.dark', Primitives.cylinder, x, 0.22, z, 0.14, height, 0.14);
  place(ctx, 'metal.dark', Primitives.cylinder, x, height * 0.55, z, 0.22, 0.14, 0.22);

  // Lantern housing.
  place(ctx, 'metal.dark', Primitives.cone, x, height + 0.42, z, 0.62, 0.42, 0.62);
  place(ctx, 'bulb.glow', Primitives.sphere, x, height + 0.2, z, 0.44, 0.5, 0.44);
  place(ctx, 'metal.gold', Primitives.sphere, x, height + 0.86, z, 0.14, 0.18, 0.14);

  ctx.lightRequests.push({
    position: new THREE.Vector3(x, height + 0.2, z),
    color: 0xffc078,
    intensity: 7.0,
    distance: 17,
    priority: 8,
  });

  ctx.collision.addCylinder({ x, z, radius: 0.22, baseY: 0, height, impactColor: 0x9aa0aa });
}

/**
 * Catenary string of festoon bulbs between two anchor points — the single most
 * recognisable motif from the reference art.
 */
export function buildStringLights(
  ctx: BuildContext,
  from: THREE.Vector3,
  to: THREE.Vector3,
  bulbs = 12,
  sag = 1.1,
): void {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= bulbs; i++) {
    const t = i / bulbs;
    // Parabolic approximation of a hanging cable.
    const droop = Math.sin(t * Math.PI) * sag;
    points.push(
      new THREE.Vector3(
        THREE.MathUtils.lerp(from.x, to.x, t),
        THREE.MathUtils.lerp(from.y, to.y, t) - droop,
        THREE.MathUtils.lerp(from.z, to.z, t),
      ),
    );
  }

  // Wire segments.
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const mid = a.clone().lerp(b, 0.5);
    const delta = b.clone().sub(a);
    const length = delta.length();
    const yaw = Math.atan2(delta.x, delta.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(delta.y / (length || 1), -1, 1));
    place(ctx, 'metal.dark', Primitives.box, mid.x, mid.y, mid.z, 0.035, 0.035, length, yaw, -pitch);
  }

  // Bulbs hanging from every interior node.
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    place(ctx, 'metal.dark', Primitives.box, p.x, p.y - 0.06, p.z, 0.05, 0.12, 0.05);
    place(ctx, 'bulb.glow', Primitives.sphere, p.x, p.y - 0.24, p.z, 0.17, 0.21, 0.17);
  }

  // One shared light for the whole strand rather than one per bulb.
  const centre = points[Math.floor(points.length / 2)];
  ctx.lightRequests.push({
    position: centre.clone().add(new THREE.Vector3(0, -0.4, 0)),
    color: 0xffcf8a,
    intensity: 3.4,
    distance: 14,
    priority: 5,
  });
}

/** Stylised autumn tree: tapered trunk, branches, clustered foliage blobs. */
export function buildTree(
  ctx: BuildContext,
  x: number,
  z: number,
  scale: number,
  foliage: MaterialKey,
): void {
  const trunkHeight = 3.0 * scale;
  const trunkRadius = 0.26 * scale;

  place(ctx, 'timber.dark', Primitives.cylinder, x, 0, z, trunkRadius * 2.4, trunkHeight * 0.4, trunkRadius * 2.4);
  place(ctx, 'timber.dark', Primitives.cylinder, x, trunkHeight * 0.38, z, trunkRadius * 1.7, trunkHeight * 0.68, trunkRadius * 1.7);

  // Two or three branches reaching into the canopy.
  const branches = 2 + ((ctx.rand() * 2) | 0);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * TAU + ctx.rand();
    const len = 1.1 * scale;
    place(
      ctx,
      'timber.dark',
      Primitives.cylinder,
      x + Math.cos(a) * 0.25 * scale,
      trunkHeight * 0.72,
      z + Math.sin(a) * 0.25 * scale,
      trunkRadius,
      len,
      trunkRadius,
      -a,
      0,
      0.65,
    );
  }

  // Canopy: overlapping icosahedron blobs of graduated size.
  const canopyY = trunkHeight * 0.98;
  const canopyRadius = 1.85 * scale;
  place(ctx, foliage, Primitives.blob, x, canopyY, z, canopyRadius * 2, canopyRadius * 1.7, canopyRadius * 2);
  const clumps = 5;
  for (let i = 0; i < clumps; i++) {
    const a = (i / clumps) * TAU + ctx.rand() * 0.6;
    const r = canopyRadius * (0.55 + ctx.rand() * 0.35);
    const size = canopyRadius * (0.72 + ctx.rand() * 0.42);
    place(
      ctx,
      foliage,
      Primitives.blob,
      x + Math.cos(a) * r,
      canopyY + (ctx.rand() - 0.35) * canopyRadius * 0.55,
      z + Math.sin(a) * r,
      size,
      size * 0.86,
      size,
      ctx.rand() * TAU,
    );
  }

  ctx.collision.addCylinder({
    x,
    z,
    radius: trunkRadius * 2.1,
    baseY: 0,
    height: trunkHeight,
    impactColor: 0x6b4630,
  });
}

export function buildBush(ctx: BuildContext, x: number, z: number, scale: number, foliage: MaterialKey): void {
  const clumps = 3;
  for (let i = 0; i < clumps; i++) {
    const a = (i / clumps) * TAU + ctx.rand();
    const r = 0.32 * scale;
    const size = scale * (0.8 + ctx.rand() * 0.4);
    place(
      ctx,
      foliage,
      Primitives.blob,
      x + Math.cos(a) * r,
      size * 0.32,
      z + Math.sin(a) * r,
      size,
      size * 0.82,
      size,
      ctx.rand() * TAU,
    );
  }
  // Flower highlights on top.
  const flowers: MaterialKey[] = ['flower.pink', 'flower.yellow', 'flower.violet'];
  for (let i = 0; i < 4; i++) {
    place(
      ctx,
      flowers[(ctx.rand() * flowers.length) | 0],
      Primitives.sphereLow,
      x + (ctx.rand() - 0.5) * scale,
      scale * (0.6 + ctx.rand() * 0.2),
      z + (ctx.rand() - 0.5) * scale,
      0.16,
      0.16,
      0.16,
    );
  }
  ctx.collision.addCylinder({ x, z, radius: scale * 0.6, baseY: 0, height: scale * 0.8, impactColor: 0x7ba85c });
}

/** Picket fence run between two points, with posts and two rails. */
export function buildFence(ctx: BuildContext, ax: number, az: number, bx: number, bz: number): void {
  const dx = bx - ax;
  const dz = bz - az;
  const length = Math.hypot(dx, dz);
  const angle = Math.atan2(dx, dz);
  const posts = Math.max(2, Math.round(length / 1.05));
  const height = 1.15;

  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    const px = ax + dx * t;
    const pz = az + dz * t;
    place(ctx, 'wood.light', Primitives.boxBase, px, 0, pz, 0.13, height * (0.9 + ctx.rand() * 0.2), 0.13, angle);
    // Pointed picket cap.
    place(ctx, 'wood.light', Primitives.cone, px, height, pz, 0.19, 0.2, 0.19, angle);
  }
  for (const railY of [0.38, 0.86]) {
    place(ctx, 'wood.light', Primitives.box, ax + dx * 0.5, railY, az + dz * 0.5, 0.07, 0.11, length, angle);
  }

  ctx.collision.addBox({
    x: ax + dx * 0.5,
    z: az + dz * 0.5,
    hx: 0.14,
    hz: length * 0.5,
    rotation: angle,
    baseY: 0,
    height,
    impactColor: 0xc9a173,
  });
}

/** Stone well with a shingled canopy and a bucket on a rope. */
export function buildWell(ctx: BuildContext, x: number, z: number): void {
  place(ctx, 'stone.pale', Primitives.cylinderSmooth, x, 0, z, 2.1, 1.05, 2.1);
  place(ctx, 'stone.dark', Primitives.cylinderSmooth, x, 1.05, z, 2.25, 0.16, 2.25);
  place(ctx, 'stone.dark', Primitives.cylinderSmooth, x, 0.9, z, 1.6, 0.16, 1.6);

  for (const side of [-1, 1]) {
    place(ctx, 'wood.warm', Primitives.boxBase, x + side * 0.85, 1.05, z, 0.16, 1.9, 0.16);
  }
  place(ctx, 'roof.red', Primitives.prism, x, 2.95, z, 2.7, 0.85, 2.1);
  place(ctx, 'wood.warm', Primitives.box, x, 2.75, z, 1.9, 0.12, 0.12, Math.PI * 0.5);
  place(ctx, 'wood.crate', Primitives.cylinder, x, 1.75, z, 0.42, 0.42, 0.42);
  place(ctx, 'metal.dark', Primitives.box, x, 2.2, z, 0.03, 0.55, 0.03);

  ctx.collision.addCylinder({ x, z, radius: 1.12, baseY: 0, height: 1.2, impactColor: 0xd6cbb8 });
}

export function buildBench(ctx: BuildContext, x: number, z: number, rotation: number): void {
  place(ctx, 'wood.light', Primitives.boxBase, x, 0.44, z, 1.9, 0.11, 0.55, rotation);
  place(ctx, 'wood.light', Primitives.boxBase, x, 0.55, z, 1.9, 0.62, 0.09, rotation, 0, 0);
  for (const side of [-1, 1]) {
    place(
      ctx,
      'metal.dark',
      Primitives.boxBase,
      x + side * 0.82 * Math.cos(rotation),
      0,
      z + side * 0.82 * Math.sin(rotation),
      0.1,
      0.46,
      0.5,
      rotation,
    );
  }
  ctx.collision.addBox({ x, z, hx: 0.95, hz: 0.3, rotation, baseY: 0, height: 0.6, impactColor: 0xc9a173 });
}

/** Free-standing painted signpost. */
export function buildSignpost(
  ctx: BuildContext,
  x: number,
  z: number,
  rotation: number,
  text: string,
  bg: number,
  fg: number,
): void {
  place(ctx, 'wood.warm', Primitives.boxBase, x, 0, z, 0.16, 2.5, 0.16);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 0.95),
    stylizedStandard(
      { map: signTexture(text, bg, fg), side: THREE.DoubleSide, roughness: 0.82 },
      { rimStrength: 0.4 },
    ),
  );
  sign.position.set(x, 2.15, z);
  sign.rotation.y = rotation;
  sign.castShadow = true;
  sign.userData.swing = { phase: ctx.rand() * TAU, amplitude: 0.03 };
  ctx.dynamic.add(sign);

  ctx.collision.addCylinder({ x, z, radius: 0.16, baseY: 0, height: 2.5, impactColor: 0x9c6b42 });
}

// ---------------------------------------------------------------------------
// Hero props (animated — these live outside the batcher)
// ---------------------------------------------------------------------------

/** Rotating carousel. Returns the spinning node for the Village to animate. */
export function buildCarousel(ctx: BuildContext, x: number, z: number, radius: number): THREE.Object3D {
  const root = new THREE.Group();
  root.position.set(x, 0, z);

  // --- Static base (batched) ---
  place(ctx, 'wood.warm', Primitives.cylinderSmooth, x, 0, z, radius * 2.1, 0.55, radius * 2.1);
  place(ctx, 'stripe.goldWhite', Primitives.cylinderSmooth, x, 0.55, z, radius * 2.05, 0.22, radius * 2.05);

  // --- Spinning assembly ---
  const spinner = new THREE.Group();
  spinner.position.y = 0.77;
  root.add(spinner);

  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 0.18, 28),
    materials.get('wood.light'),
  );
  platform.castShadow = true;
  platform.receiveShadow = true;
  spinner.add(platform);

  const centralPost = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 3.4, 14),
    materials.get('metal.gold'),
  );
  centralPost.position.y = 1.7;
  centralPost.castShadow = true;
  spinner.add(centralPost);

  // Canopy: a striped cone with a scalloped fringe.
  const canopy = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 1.16, 1.5, 20),
    materials.get('stripe.redWhite'),
  );
  canopy.position.y = 4.0;
  canopy.castShadow = true;
  spinner.add(canopy);

  const fringe = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 1.1, 0.14, 6, 24),
    materials.get('stripe.goldWhite'),
  );
  fringe.rotation.x = Math.PI * 0.5;
  fringe.position.y = 3.32;
  spinner.add(fringe);

  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), materials.get('metal.gold'));
  finial.position.y = 4.9;
  spinner.add(finial);

  // Horses on brass poles.
  const horseCount = 6;
  const poleGeometry = new THREE.CylinderGeometry(0.055, 0.055, 3.1, 8);
  const bodyGeometry = new THREE.BoxGeometry(0.85, 0.5, 0.32);
  const headGeometry = new THREE.BoxGeometry(0.34, 0.42, 0.26);
  const legGeometry = new THREE.BoxGeometry(0.12, 0.55, 0.12);
  const horseMaterials: THREE.Material[] = [
    materials.get('paint.white'),
    materials.get('flower.pink'),
    materials.get('plaster.butter'),
  ];

  for (let i = 0; i < horseCount; i++) {
    const a = (i / horseCount) * TAU;
    const hx = Math.cos(a) * radius * 0.72;
    const hz = Math.sin(a) * radius * 0.72;

    const pole = new THREE.Mesh(poleGeometry, materials.get('metal.gold'));
    pole.position.set(hx, 1.7, hz);
    spinner.add(pole);

    const horse = new THREE.Group();
    horse.position.set(hx, 1.35, hz);
    horse.rotation.y = -a + Math.PI * 0.5;
    const mat = horseMaterials[i % horseMaterials.length];

    const body = new THREE.Mesh(bodyGeometry, mat);
    body.castShadow = true;
    horse.add(body);

    const head = new THREE.Mesh(headGeometry, mat);
    head.position.set(0.5, 0.3, 0);
    head.rotation.z = -0.35;
    horse.add(head);

    for (const [lx, lz] of [
      [0.3, 0.12],
      [0.3, -0.12],
      [-0.3, 0.12],
      [-0.3, -0.12],
    ]) {
      const leg = new THREE.Mesh(legGeometry, mat);
      leg.position.set(lx, -0.42, lz);
      leg.rotation.x = lx > 0 ? 0.3 : -0.3;
      horse.add(leg);
    }

    // Bob offset so the horses rise and fall out of phase.
    horse.userData.bobPhase = (i / horseCount) * TAU;
    horse.userData.baseY = 1.35;
    spinner.add(horse);
  }

  root.userData.spinner = spinner;
  ctx.dynamic.add(root);

  ctx.lightRequests.push({
    position: new THREE.Vector3(x, 3.2, z),
    color: 0xffd08a,
    intensity: 9.0,
    distance: 24,
    priority: 10,
  });

  ctx.collision.addCylinder({ x, z, radius: radius * 1.02, baseY: 0, height: 4.6, impactColor: 0xd9a441 });
  return root;
}

/** Ferris wheel — the town's silhouette landmark. Rotates slowly. */
export function buildFerrisWheel(ctx: BuildContext, x: number, z: number, radius: number): THREE.Object3D {
  const root = new THREE.Group();
  root.position.set(x, 0, z);
  const hubHeight = radius + 1.6;

  // A-frame legs (batched — they never move).
  for (const side of [-1, 1]) {
    for (const lean of [-1, 1]) {
      place(
        ctx,
        'metal.iron',
        Primitives.boxBase,
        x + lean * radius * 0.42,
        0,
        z + side * 1.5,
        0.32,
        hubHeight * 1.08,
        0.32,
        0,
        0,
        -lean * 0.38,
      );
    }
  }
  place(ctx, 'metal.iron', Primitives.box, x, hubHeight, z, 0.34, 0.34, 3.4);

  // --- Rotating wheel ---
  const wheel = new THREE.Group();
  wheel.position.set(0, hubHeight, 0);
  root.add(wheel);

  const rimGeometry = new THREE.TorusGeometry(radius, 0.16, 8, 40);
  for (const offset of [-1.1, 1.1]) {
    const rim = new THREE.Mesh(rimGeometry, materials.get('metal.iron'));
    rim.position.z = offset;
    rim.castShadow = true;
    wheel.add(rim);
  }

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.6, 12), materials.get('metal.gold'));
  hub.rotation.x = Math.PI * 0.5;
  wheel.add(hub);

  const spokeGeometry = new THREE.BoxGeometry(0.09, radius * 2, 0.09);
  const gondolaGeometry = new THREE.BoxGeometry(1.0, 0.85, 1.5);
  const gondolaRoofGeometry = new THREE.ConeGeometry(0.85, 0.45, 4);
  const gondolaColors: THREE.Material[] = [
    materials.get('canvas.red'),
    materials.get('plaster.mint'),
    materials.get('plaster.butter'),
    materials.get('plaster.sky'),
    materials.get('flower.pink'),
  ];

  const spokes = 10;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI;
    const spoke = new THREE.Mesh(spokeGeometry, materials.get('metal.iron'));
    spoke.rotation.z = a;
    wheel.add(spoke);
  }

  // Gondolas hang from pivots so they stay level as the wheel turns.
  for (let i = 0; i < spokes * 2; i++) {
    const a = (i / (spokes * 2)) * TAU;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(a) * radius, Math.sin(a) * radius, 0);
    pivot.userData.isGondolaPivot = true;
    wheel.add(pivot);

    const car = new THREE.Group();
    car.position.y = -0.8;

    const body = new THREE.Mesh(gondolaGeometry, gondolaColors[i % gondolaColors.length]);
    body.castShadow = true;
    car.add(body);

    const roof = new THREE.Mesh(gondolaRoofGeometry, materials.get('metal.gold'));
    roof.position.y = 0.62;
    roof.rotation.y = Math.PI * 0.25;
    car.add(roof);

    pivot.add(car);
  }

  root.userData.wheel = wheel;
  ctx.dynamic.add(root);

  ctx.collision.addBox({
    x,
    z,
    hx: radius * 0.5,
    hz: 2.2,
    rotation: 0,
    baseY: 0,
    height: 3.0,
    impactColor: 0x6a6a72,
  });

  return root;
}
