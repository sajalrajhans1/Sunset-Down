import * as THREE from 'three';
import { WORLD } from '../game/Config';

/**
 * Analytic collision world.
 *
 * Rather than raycasting against the village's thousands of triangles, we keep a
 * parallel set of simple volumes (oriented boxes and cylinders). Bullet traces,
 * player movement and zombie steering all query these instead — which turns a
 * potentially multi-millisecond BVH walk into a handful of arithmetic ops.
 */

export interface BoxCollider {
  kind: 'box';
  x: number;
  z: number;
  /** Half extents along the collider's local axes. */
  hx: number;
  hz: number;
  rotation: number;
  baseY: number;
  height: number;
  /** Blocks navigation/movement. Decorative volumes can still be shot. */
  solid: boolean;
  /**
   * Switched off entirely — neither blocks nor stops bullets. Used by the
   * buyable gates, which have to stop existing the moment they are opened
   * without disturbing the broadphase every other collider is binned into.
   */
  enabled: boolean;
  /** Surface tint sampled for impact particles. */
  impactColor: number;
}

export interface CylinderCollider {
  kind: 'cylinder';
  x: number;
  z: number;
  radius: number;
  baseY: number;
  height: number;
  solid: boolean;
  enabled: boolean;
  impactColor: number;
}

export type Collider = BoxCollider | CylinderCollider;

/** `solid` and `impactColor` have sensible defaults, so callers may omit them. */
export type BoxColliderInput = Omit<BoxCollider, 'kind' | 'solid' | 'enabled' | 'impactColor'> &
  Partial<Pick<BoxCollider, 'solid' | 'enabled' | 'impactColor'>>;

export type CylinderColliderInput = Omit<
  CylinderCollider,
  'kind' | 'solid' | 'enabled' | 'impactColor'
> &
  Partial<Pick<CylinderCollider, 'solid' | 'enabled' | 'impactColor'>>;

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  impactColor: number;
  isGround: boolean;
}

const _tmpVec = new THREE.Vector3();

export class CollisionWorld {
  readonly colliders: Collider[] = [];

  /** Uniform-grid broadphase. Cell size is tuned to typical prop footprints. */
  private readonly cellSize = 6;
  private readonly buckets = new Map<number, number[]>();
  private built = false;

  addBox(options: BoxColliderInput): BoxCollider {
    const collider: BoxCollider = {
      kind: 'box',
      x: options.x,
      z: options.z,
      hx: options.hx,
      hz: options.hz,
      rotation: options.rotation,
      baseY: options.baseY,
      height: options.height,
      solid: options.solid ?? true,
      enabled: options.enabled ?? true,
      impactColor: options.impactColor ?? 0xd8c8b0,
    };
    this.colliders.push(collider);
    this.built = false;
    return collider;
  }

  addCylinder(options: CylinderColliderInput): CylinderCollider {
    const collider: CylinderCollider = {
      kind: 'cylinder',
      x: options.x,
      z: options.z,
      radius: options.radius,
      baseY: options.baseY,
      height: options.height,
      solid: options.solid ?? true,
      enabled: options.enabled ?? true,
      impactColor: options.impactColor ?? 0xb08a60,
    };
    this.colliders.push(collider);
    this.built = false;
    return collider;
  }

  clear(): void {
    this.colliders.length = 0;
    this.buckets.clear();
    this.built = false;
  }

  private hashKey(cx: number, cz: number): number {
    // Pack two signed 16-bit cell coordinates into one integer key.
    return ((cx + 4096) << 13) | (cz + 4096);
  }

  /** Bins every collider into the broadphase grid. Call once after building the map. */
  build(): void {
    this.buckets.clear();
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      // Bounding radius: the cylinder's radius, or the box's corner distance.
      const extent = c.kind === 'cylinder' ? c.radius : Math.hypot(c.hx, c.hz);
      const minX = Math.floor((c.x - extent) / this.cellSize);
      const maxX = Math.floor((c.x + extent) / this.cellSize);
      const minZ = Math.floor((c.z - extent) / this.cellSize);
      const maxZ = Math.floor((c.z + extent) / this.cellSize);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const key = this.hashKey(cx, cz);
          let bucket = this.buckets.get(key);
          if (!bucket) {
            bucket = [];
            this.buckets.set(key, bucket);
          }
          bucket.push(i);
        }
      }
    }
    this.built = true;
  }

  /** Monotonically increasing stamp used to de-duplicate broadphase results. */
  private queryStamp = 0;
  private visited = new Int32Array(0);

  /** Collects collider indices near a world-space point (no duplicates). */
  private queryNear(x: number, z: number, radius: number, out: number[]): void {
    out.length = 0;
    if (!this.built) this.build();
    if (this.visited.length < this.colliders.length) {
      this.visited = new Int32Array(this.colliders.length + 64);
    }
    const stamp = ++this.queryStamp;

    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize);
    const maxZ = Math.floor((z + radius) / this.cellSize);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.buckets.get(this.hashKey(cx, cz));
        if (!bucket) continue;
        for (const idx of bucket) {
          if (this.visited[idx] === stamp) continue;
          this.visited[idx] = stamp;
          out.push(idx);
        }
      }
    }
  }

  private readonly _queryScratch: number[] = [];

  /**
   * Pushes a vertical capsule (approximated as a circle in XZ) out of any solid
   * collider it overlaps. Returns true if the position was modified.
   *
   * Iterated twice so corners resolve cleanly instead of jittering.
   */
  resolveCircle(position: THREE.Vector3, radius: number, feetY: number, bodyHeight: number): boolean {
    let moved = false;
    for (let iteration = 0; iteration < 2; iteration++) {
      this.queryNear(position.x, position.z, radius + 2, this._queryScratch);
      let iterationMoved = false;

      for (const idx of this._queryScratch) {
        const c = this.colliders[idx];
        if (!c.solid || !c.enabled) continue;
        // Vertical overlap test — lets the player walk over low kerbs and
        // under raised awnings without being blocked.
        const top = c.baseY + c.height;
        if (feetY >= top - 0.02 || feetY + bodyHeight <= c.baseY) continue;

        if (c.kind === 'cylinder') {
          const dx = position.x - c.x;
          const dz = position.z - c.z;
          const distSq = dx * dx + dz * dz;
          const minDist = radius + c.radius;
          if (distSq >= minDist * minDist || distSq === 0) continue;
          const dist = Math.sqrt(distSq);
          const push = minDist - dist;
          position.x += (dx / dist) * push;
          position.z += (dz / dist) * push;
          iterationMoved = true;
        } else {
          // Transform into the box's local frame, clamp, transform back.
          const cos = Math.cos(-c.rotation);
          const sin = Math.sin(-c.rotation);
          const relX = position.x - c.x;
          const relZ = position.z - c.z;
          const localX = relX * cos - relZ * sin;
          const localZ = relX * sin + relZ * cos;

          const clampedX = Math.max(-c.hx, Math.min(c.hx, localX));
          const clampedZ = Math.max(-c.hz, Math.min(c.hz, localZ));
          let deltaX = localX - clampedX;
          let deltaZ = localZ - clampedZ;
          let distSq = deltaX * deltaX + deltaZ * deltaZ;

          if (distSq > radius * radius) continue;

          if (distSq > 1e-8) {
            // Outside the box: push straight out along the closest-point normal.
            const dist = Math.sqrt(distSq);
            const push = radius - dist;
            deltaX = (deltaX / dist) * push;
            deltaZ = (deltaZ / dist) * push;
          } else {
            // Centre is inside the box: eject along the shallowest axis.
            const overlapX = c.hx - Math.abs(localX);
            const overlapZ = c.hz - Math.abs(localZ);
            if (overlapX < overlapZ) {
              deltaX = Math.sign(localX || 1) * (overlapX + radius);
              deltaZ = 0;
            } else {
              deltaX = 0;
              deltaZ = Math.sign(localZ || 1) * (overlapZ + radius);
            }
          }

          const back = Math.cos(c.rotation);
          const backSin = Math.sin(c.rotation);
          position.x += deltaX * back - deltaZ * backSin;
          position.z += deltaX * backSin + deltaZ * back;
          iterationMoved = true;
        }
      }

      moved = moved || iterationMoved;
      if (!iterationMoved) break;
    }

    // Keep everyone inside the playable bounds.
    const limit = WORLD.halfSize - radius;
    if (position.x < -limit) {
      position.x = -limit;
      moved = true;
    } else if (position.x > limit) {
      position.x = limit;
      moved = true;
    }
    if (position.z < -limit) {
      position.z = -limit;
      moved = true;
    } else if (position.z > limit) {
      position.z = limit;
      moved = true;
    }

    return moved;
  }

  /** True if a circle at this spot would intersect anything solid. */
  isBlocked(x: number, z: number, radius: number, testY = 0.5): boolean {
    this.queryNear(x, z, radius + 1, this._queryScratch);
    for (const idx of this._queryScratch) {
      const c = this.colliders[idx];
      if (!c.solid || !c.enabled) continue;
      if (testY >= c.baseY + c.height || testY < c.baseY - 0.5) continue;

      if (c.kind === 'cylinder') {
        const dx = x - c.x;
        const dz = z - c.z;
        const minDist = radius + c.radius;
        if (dx * dx + dz * dz < minDist * minDist) return true;
      } else {
        const cos = Math.cos(-c.rotation);
        const sin = Math.sin(-c.rotation);
        const relX = x - c.x;
        const relZ = z - c.z;
        const localX = relX * cos - relZ * sin;
        const localZ = relX * sin + relZ * cos;
        const dx = Math.max(Math.abs(localX) - c.hx, 0);
        const dz = Math.max(Math.abs(localZ) - c.hz, 0);
        if (dx * dx + dz * dz < radius * radius) return true;
      }
    }
    return false;
  }

  /**
   * Analytic ray cast against colliders plus the ground plane.
   * Returns the nearest hit, or null when the ray escapes the map.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): RayHit | null {
    let bestDist = maxDistance;
    let bestNormal: THREE.Vector3 | null = null;
    let bestColor = 0xd8c8b0;
    let bestIsGround = false;

    // Ground plane at y = 0.
    if (direction.y < -1e-5) {
      const t = (WORLD.groundY - origin.y) / direction.y;
      if (t > 0 && t < bestDist) {
        bestDist = t;
        bestNormal = _tmpVec.set(0, 1, 0).clone();
        bestColor = 0xa89a86;
        bestIsGround = true;
      }
    }

    for (const c of this.colliders) {
      if (!c.enabled) continue;
      const hit =
        c.kind === 'cylinder'
          ? rayVsCylinder(origin, direction, c, bestDist)
          : rayVsOrientedBox(origin, direction, c, bestDist);
      if (hit) {
        bestDist = hit.t;
        bestNormal = hit.normal;
        bestColor = c.impactColor;
        bestIsGround = false;
      }
    }

    if (!bestNormal) return null;
    return {
      point: new THREE.Vector3(
        origin.x + direction.x * bestDist,
        origin.y + direction.y * bestDist,
        origin.z + direction.z * bestDist,
      ),
      normal: bestNormal,
      distance: bestDist,
      impactColor: bestColor,
      isGround: bestIsGround,
    };
  }
}

interface PrimitiveHit {
  t: number;
  normal: THREE.Vector3;
}

/** Slab test in the box's local frame, with the Y slab handled in world space. */
function rayVsOrientedBox(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  box: BoxCollider,
  maxDistance: number,
): PrimitiveHit | null {
  const cos = Math.cos(-box.rotation);
  const sin = Math.sin(-box.rotation);

  const relX = origin.x - box.x;
  const relZ = origin.z - box.z;
  const ox = relX * cos - relZ * sin;
  const oz = relX * sin + relZ * cos;
  const oy = origin.y - (box.baseY + box.height * 0.5);

  const dx = direction.x * cos - direction.z * sin;
  const dz = direction.x * sin + direction.z * cos;
  const dy = direction.y;

  const hy = box.height * 0.5;

  let tMin = 0;
  let tMax = maxDistance;
  let hitAxis = 0;
  let hitSign = 1;

  const axes: [number, number, number][] = [
    [ox, dx, box.hx],
    [oy, dy, hy],
    [oz, dz, box.hz],
  ];

  for (let axis = 0; axis < 3; axis++) {
    const [o, d, h] = axes[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < -h || o > h) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (-h - o) * inv;
    let t2 = (h - o) * inv;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      hitAxis = axis;
      hitSign = sign;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  if (tMin <= 1e-4 || tMin >= maxDistance) return null;

  // Local-space normal, rotated back into world space.
  const local = [0, 0, 0];
  local[hitAxis] = hitSign;
  const backCos = Math.cos(box.rotation);
  const backSin = Math.sin(box.rotation);
  const normal = new THREE.Vector3(
    local[0] * backCos - local[2] * backSin,
    local[1],
    local[0] * backSin + local[2] * backCos,
  );
  return { t: tMin, normal };
}

/** Infinite-cylinder solve, clipped to the collider's vertical extent. */
function rayVsCylinder(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  cyl: CylinderCollider,
  maxDistance: number,
): PrimitiveHit | null {
  const ox = origin.x - cyl.x;
  const oz = origin.z - cyl.z;
  const a = direction.x * direction.x + direction.z * direction.z;
  if (a < 1e-8) return null;
  const b = 2 * (ox * direction.x + oz * direction.z);
  const c = ox * ox + oz * oz - cyl.radius * cyl.radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  let t = (-b - sqrtDisc) / (2 * a);
  if (t <= 1e-4) t = (-b + sqrtDisc) / (2 * a);
  if (t <= 1e-4 || t >= maxDistance) return null;

  const y = origin.y + direction.y * t;
  if (y < cyl.baseY || y > cyl.baseY + cyl.height) return null;

  const nx = origin.x + direction.x * t - cyl.x;
  const nz = origin.z + direction.z * t - cyl.z;
  const len = Math.hypot(nx, nz) || 1;
  return { t, normal: new THREE.Vector3(nx / len, 0, nz / len) };
}
