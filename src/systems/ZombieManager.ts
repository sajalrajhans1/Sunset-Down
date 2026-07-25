import * as THREE from 'three';
import { Zombie, type ZombieHitResult, type ZombieUpdateContext } from '../components/Zombie';
import type { ZombieTypeId } from '../components/ZombieTypes';
import { ObjectPool } from '../utilities/ObjectPool';
import type { NavGrid } from './NavGrid';
import type { CollisionWorld } from './CollisionWorld';
import { TAU } from '../utilities/MathUtils';

export interface ZombieRayHit {
  zombie: Zombie;
  distance: number;
  point: THREE.Vector3;
  /** True when the ray struck the head sphere rather than the body. */
  headshot: boolean;
}

export interface SpawnRequest {
  type: ZombieTypeId;
  position: THREE.Vector3;
  healthMultiplier: number;
  speedMultiplier: number;
  damageMultiplier: number;
}

/**
 * Owns the zombie pool, their per-frame update, crowd separation and all
 * bullet/explosion hit testing.
 *
 * Every zombie is allocated up front — spawning during a wave never touches the
 * allocator, which is what keeps frame times flat when 40 zombies arrive at
 * once.
 */
export class ZombieManager {
  readonly group = new THREE.Group();

  private pool: ObjectPool<Zombie>;
  private readonly active: Zombie[] = [];
  private capacity: number;

  /** Uniform grid for neighbour queries, rebuilt each frame. */
  private readonly cellSize = 2.4;
  private readonly grid = new Map<number, Zombie[]>();

  /** Round-robin counter that hands out encirclement slots. */
  private slotCounter = 0;

  /** Cap on simultaneous shadow casters, refreshed each frame. */
  private shadowBudget = 12;

  onZombieKilled: ((zombie: Zombie) => void) | null = null;
  onZombieAttack: ((zombie: Zombie, damage: number) => void) | null = null;
  onZombieExploded: ((zombie: Zombie) => void) | null = null;

  constructor(capacity: number) {
    this.group.name = 'Zombies';
    this.capacity = capacity;
    this.pool = this.createPool(capacity);
  }

  private createPool(capacity: number): ObjectPool<Zombie> {
    return new ObjectPool<Zombie>({
      maxSize: capacity,
      initialSize: Math.min(capacity, 16),
      factory: () => {
        const zombie = new Zombie();
        this.group.add(zombie.container);
        zombie.onAttack = (z, damage) => this.onZombieAttack?.(z, damage);
        zombie.onDeath = (z) => this.onZombieKilled?.(z);
        zombie.onExplode = (z) => this.onZombieExploded?.(z);
        zombie.onRemoved = (z) => this.handleRemoved(z);
        return zombie;
      },
    });
  }

  /** Resizes the pool when the graphics preset changes. */
  setCapacity(capacity: number): void {
    if (capacity === this.capacity) return;
    this.capacity = capacity;
    // Trim any excess live zombies rather than rebuilding the pool mid-run.
    while (this.active.length > capacity) {
      this.active[this.active.length - 1].despawnSilently();
      break;
    }
  }

  get aliveCount(): number {
    let count = 0;
    for (const zombie of this.active) if (zombie.isAlive) count++;
    return count;
  }

  get activeCount(): number {
    return this.active.length;
  }

  get activeZombies(): readonly Zombie[] {
    return this.active;
  }

  get isFull(): boolean {
    return this.active.length >= this.capacity;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  spawn(request: SpawnRequest): Zombie | null {
    const zombie = this.pool.acquire();
    if (!zombie) return null;

    // Spread encirclement slots evenly using the golden angle, so any number of
    // simultaneously-alive zombies stays well distributed around the player.
    const slotAngle = (this.slotCounter++ * 2.39996) % TAU;
    const colorIndex = Math.floor(Math.random() * 4);

    zombie.spawn({
      type: request.type,
      position: request.position,
      healthMultiplier: request.healthMultiplier,
      speedMultiplier: request.speedMultiplier,
      damageMultiplier: request.damageMultiplier,
      colorIndex,
      slotAngle,
    });

    this.active.push(zombie);
    return zombie;
  }

  private handleRemoved(zombie: Zombie): void {
    const index = this.active.indexOf(zombie);
    if (index >= 0) this.active.splice(index, 1);
    this.pool.release(zombie);
  }

  /** Clears the field — used on wave reset and when returning to the menu. */
  clear(): void {
    for (const zombie of [...this.active]) zombie.deactivate();
    this.active.length = 0;
    this.slotCounter = 0;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(
    dt: number,
    elapsed: number,
    playerPosition: THREE.Vector3,
    playerCenter: THREE.Vector3,
    playerAlive: boolean,
    navGrid: NavGrid,
    collision: CollisionWorld,
    aggression: number,
    cameraPosition: THREE.Vector3,
  ): void {
    this.rebuildSpatialGrid();
    this.shadowBudget = 12;

    // Iterate a snapshot: zombies may deactivate themselves mid-update.
    const snapshot = this.active.slice();

    const ctx: ZombieUpdateContext = {
      dt,
      elapsed,
      playerPosition,
      playerCenter,
      playerAlive,
      navGrid,
      collision,
      aggression,
      separationX: 0,
      separationZ: 0,
      cameraDistance: 0,
      shadowBudgetRemaining: this.shadowBudget,
    };

    for (const zombie of snapshot) {
      if (!zombie.isActive) continue;

      const dx = zombie.position.x - cameraPosition.x;
      const dz = zombie.position.z - cameraPosition.z;
      ctx.cameraDistance = Math.hypot(dx, dz);
      ctx.shadowBudgetRemaining = this.shadowBudget;
      if (ctx.cameraDistance < 32 && this.shadowBudget > 0) this.shadowBudget--;

      if (zombie.isAlive) {
        this.computeSeparation(zombie, ctx);
      } else {
        ctx.separationX = 0;
        ctx.separationZ = 0;
      }

      zombie.update(ctx);
    }
  }

  private cellKey(x: number, z: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    return ((cx + 2048) << 12) | (cz + 2048);
  }

  private rebuildSpatialGrid(): void {
    this.grid.clear();
    for (const zombie of this.active) {
      if (!zombie.isAlive) continue;
      const key = this.cellKey(zombie.position.x, zombie.position.z);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(zombie);
    }
  }

  /**
   * Boids-style separation over the 3x3 neighbourhood. Push strength falls off
   * with distance and scales with body size, so a Bruiser bullies its way
   * through a pack of Shamblers rather than getting stuck in one.
   */
  private computeSeparation(zombie: Zombie, ctx: ZombieUpdateContext): void {
    let pushX = 0;
    let pushZ = 0;

    const baseCx = Math.floor(zombie.position.x / this.cellSize);
    const baseCz = Math.floor(zombie.position.z / this.cellSize);

    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const key = ((baseCx + ox + 2048) << 12) | (baseCz + oz + 2048);
        const bucket = this.grid.get(key);
        if (!bucket) continue;

        for (const other of bucket) {
          if (other === zombie) continue;
          const dx = zombie.position.x - other.position.x;
          const dz = zombie.position.z - other.position.z;
          const distSq = dx * dx + dz * dz;
          const minDist = (zombie.radius + other.radius) * 1.15;
          if (distSq >= minDist * minDist || distSq < 1e-6) continue;

          const dist = Math.sqrt(distSq);
          const strength = (1 - dist / minDist) * (other.radius / zombie.radius);
          pushX += (dx / dist) * strength;
          pushZ += (dz / dist) * strength;
        }
      }
    }

    // Cap the push so a dense crowd can't fling anyone across the map.
    const magnitude = Math.hypot(pushX, pushZ);
    if (magnitude > 1.6) {
      pushX = (pushX / magnitude) * 1.6;
      pushZ = (pushZ / magnitude) * 1.6;
    }

    ctx.separationX = pushX * 1.25;
    ctx.separationZ = pushZ * 1.25;
  }

  // -------------------------------------------------------------------------
  // Hit testing
  // -------------------------------------------------------------------------

  /**
   * Nearest zombie intersected by a ray. Each zombie is approximated by a
   * vertical body cylinder plus a head sphere, which gives precise headshots
   * without any mesh-level raycasting.
   */
  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    ignore?: Set<Zombie>,
  ): ZombieRayHit | null {
    let best: ZombieRayHit | null = null;

    for (const zombie of this.active) {
      if (!zombie.isAlive) continue;
      if (ignore?.has(zombie)) continue;

      // Cheap rejection: is the zombie roughly along the ray at all?
      const toX = zombie.position.x - origin.x;
      const toZ = zombie.position.z - origin.z;
      const along = toX * direction.x + toZ * direction.z;
      if (along < -2 || along > maxDistance + 2) continue;

      const headRadius = 0.34 * zombie.def.proportions.head * zombie.def.scale;
      const bodyTop = zombie.headHeight - headRadius * 0.5;

      // --- Head sphere ---
      const headHit = raySphere(
        origin,
        direction,
        zombie.position.x,
        zombie.position.y + zombie.headHeight,
        zombie.position.z,
        headRadius * 1.05,
        maxDistance,
      );

      // --- Body cylinder ---
      const bodyHit = rayCylinder(
        origin,
        direction,
        zombie.position.x,
        zombie.position.z,
        zombie.radius * 1.05,
        zombie.position.y,
        bodyTop,
        maxDistance,
      );

      let distance = Infinity;
      let headshot = false;
      if (headHit !== null && headHit < distance) {
        distance = headHit;
        headshot = true;
      }
      if (bodyHit !== null && bodyHit < distance) {
        distance = bodyHit;
        headshot = false;
      }
      if (!Number.isFinite(distance)) continue;

      if (!best || distance < best.distance) {
        best = {
          zombie,
          distance,
          headshot,
          point: new THREE.Vector3(
            origin.x + direction.x * distance,
            origin.y + direction.y * distance,
            origin.z + direction.z * distance,
          ),
        };
      }
    }

    return best;
  }

  /**
   * Applies radial damage. Falls off linearly to the edge of the radius so
   * standing at the fringe of a blast is survivable.
   */
  applyExplosion(
    center: THREE.Vector3,
    radius: number,
    damage: number,
    exclude: Zombie | null,
    onHit: (zombie: Zombie, result: ZombieHitResult) => void,
  ): void {
    const hitPoint = new THREE.Vector3();
    for (const zombie of [...this.active]) {
      if (!zombie.isAlive || zombie === exclude) continue;
      const dx = zombie.position.x - center.x;
      const dz = zombie.position.z - center.z;
      const distance = Math.hypot(dx, dz);
      if (distance > radius + zombie.radius) continue;

      const falloff = 1 - Math.min(1, distance / radius);
      hitPoint.set(zombie.position.x, zombie.position.y + zombie.headHeight * 0.6, zombie.position.z);
      const result = zombie.takeDamage(damage * falloff, hitPoint, false, 1);
      onHit(zombie, result);
    }
  }

  /** Nearest living zombie to a point, used for boss HUD tracking. */
  findBoss(): Zombie | null {
    for (const zombie of this.active) {
      if (zombie.isAlive && zombie.def.isBoss) return zombie;
    }
    return null;
  }

  /** Count of living zombies within a radius — feeds the music intensity. */
  countNear(position: THREE.Vector3, radius: number): number {
    let count = 0;
    const radiusSq = radius * radius;
    for (const zombie of this.active) {
      if (!zombie.isAlive) continue;
      const dx = zombie.position.x - position.x;
      const dz = zombie.position.z - position.z;
      if (dx * dx + dz * dz <= radiusSq) count++;
    }
    return count;
  }

  dispose(): void {
    for (const zombie of this.pool.drain()) {
      zombie.dispose();
      this.group.remove(zombie.container);
    }
    this.active.length = 0;
    this.grid.clear();
    this.group.clear();
  }
}

// --- Analytic intersection helpers ------------------------------------------

function raySphere(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  maxDistance: number,
): number | null {
  const ox = origin.x - cx;
  const oy = origin.y - cy;
  const oz = origin.z - cz;
  const b = 2 * (ox * direction.x + oy * direction.y + oz * direction.z);
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  let t = (-b - sqrtDisc) / 2;
  if (t < 0) t = (-b + sqrtDisc) / 2;
  if (t < 0 || t > maxDistance) return null;
  return t;
}

function rayCylinder(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  cx: number,
  cz: number,
  radius: number,
  baseY: number,
  topY: number,
  maxDistance: number,
): number | null {
  const ox = origin.x - cx;
  const oz = origin.z - cz;
  const a = direction.x * direction.x + direction.z * direction.z;
  if (a < 1e-8) return null;
  const b = 2 * (ox * direction.x + oz * direction.z);
  const c = ox * ox + oz * oz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const inv = 1 / (2 * a);
  let t = (-b - sqrtDisc) * inv;
  let y = origin.y + direction.y * t;
  if (t < 0 || y < baseY || y > topY) {
    t = (-b + sqrtDisc) * inv;
    y = origin.y + direction.y * t;
    if (t < 0 || y < baseY || y > topY) return null;
  }
  if (t > maxDistance) return null;
  return t;
}
