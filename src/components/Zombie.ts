import * as THREE from 'three';
import { ProceduralZombieVisual } from './ZombieModel';
import { GlbZombieVisual, isZombieModelReady } from './GlbZombieVisual';
import { GlbBossVisual, isBossModelReady } from './GlbBossVisual';
import type { ZombieAnimationState, ZombieVisual } from './ZombieVisual';
import { ZOMBIE_TYPES, type ZombieTypeDef, type ZombieTypeId } from './ZombieTypes';
import type { NavGrid } from '../systems/NavGrid';
import type { CollisionWorld } from '../systems/CollisionWorld';
import { audio } from '../audio/AudioManager';
import { clamp01, damp, dampAngle, lerp, randRange, TAU } from '../utilities/MathUtils';
import { Easing } from '../utilities/Easing';

export type ZombieState = 'inactive' | 'spawning' | 'chasing' | 'attacking' | 'priming' | 'dying';

export interface ZombieSpawnOptions {
  type: ZombieTypeId;
  position: THREE.Vector3;
  healthMultiplier: number;
  speedMultiplier: number;
  damageMultiplier: number;
  colorIndex: number;
  /** Preferred approach angle so the horde encircles rather than queues up. */
  slotAngle: number;
}

export interface ZombieUpdateContext {
  dt: number;
  elapsed: number;
  playerPosition: THREE.Vector3;
  playerCenter: THREE.Vector3;
  playerAlive: boolean;
  navGrid: NavGrid;
  collision: CollisionWorld;
  /** Rises each wave: tighter encirclement and shorter attack windups. */
  aggression: number;
  /** Crowd-avoidance push computed by the manager's spatial hash. */
  separationX: number;
  separationZ: number;
  /** Distance from the camera, used for LOD. */
  cameraDistance: number;
  shadowBudgetRemaining: number;
}

export interface ZombieHitResult {
  damage: number;
  killed: boolean;
  headshot: boolean;
  critical: boolean;
  position: THREE.Vector3;
}

const _flow = { x: 0, z: 0 };
const _toPlayer = new THREE.Vector3();

/**
 * One zombie.
 *
 * Steering blends four influences, in priority order:
 *   1. flow field  — global routing around buildings
 *   2. direct line — takes over at close range where the grid is too coarse
 *   3. encirclement — a per-zombie slot angle so the horde surrounds you
 *   4. separation  — keeps bodies from occupying the same space
 *
 * The walk cycle is entirely procedural: a handful of sine waves driven by a
 * phase that advances with actual ground speed, so a staggered or slowed zombie
 * automatically animates slower without any extra code.
 */
export class Zombie {
  /**
   * Scene node the entity owns. The active visual's root is parented here, so
   * a pooled zombie can switch between the skinned character and the boss's
   * procedural rig without touching the scene graph above it.
   */
  readonly container = new THREE.Group();

  /** Lazily built, then cached — most pooled entities only ever need one. */
  private glbVisual: GlbZombieVisual | null = null;
  private bossVisual: GlbBossVisual | null = null;
  private proceduralVisual: ProceduralZombieVisual | null = null;
  private visual!: ZombieVisual;

  state: ZombieState = 'inactive';
  def: ZombieTypeDef = ZOMBIE_TYPES.normal;

  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  health = 100;
  maxHealth = 100;
  damage = 12;
  speed = 2.5;
  radius = 0.36;
  headHeight = 1.4;
  /** Radius of the headshot sphere, taken from the active body. */
  headRadius = 0.34;

  private facing = 0;
  private gaitPhase = 0;
  private attackTimer = 0;
  private attackWindup = 0;
  private stateTimer = 0;
  private hitFlash = 0;
  private staggerTimer = 0;
  private slotAngle = 0;
  private growlTimer = 0;
  private primeTimer = 0;
  private primeBeepStep = 0;
  private deathSpin = 0;
  private lodLevel = -1;
  private shadowsEnabled = false;
  private idlePhase = 0;

  /** Set by the manager each frame so damage numbers can find their anchor. */
  readonly worldCenter = new THREE.Vector3();

  onAttack: ((zombie: Zombie, damage: number) => void) | null = null;
  onExplode: ((zombie: Zombie) => void) | null = null;
  onDeath: ((zombie: Zombie) => void) | null = null;
  onRemoved: ((zombie: Zombie) => void) | null = null;

  private readonly animState: ZombieAnimationState = {
    dt: 0,
    elapsed: 0,
    stride: 0,
    speed: 0,
    run: 0,
    gaitPhase: 0,
    attackWindup: 0,
    attackWindupDuration: 0.34,
    isAttacking: false,
    deathProgress: 0,
    lookOffset: 0,
    phaseOffset: 0,
  };

  constructor() {
    this.container.visible = false;
  }

  /** Body tint, used to colour hit and death particles. */
  get bodyColor(): number {
    return this.visual?.bodyColor ?? 0x7d9c6e;
  }

  /**
   * Picks the renderable body for a class and parents it under the container.
   *
   * Bosses get the sculpted character mesh, everything else the skinned one.
   * Either can fall back to the primitive rig if its model failed to download,
   * so a bad network can never break a wave — the player just gets the
   * stylised stand-in instead of nothing at all.
   */
  private selectVisual(def: ZombieTypeDef): ZombieVisual {
    const wantsBoss = def.isBoss && isBossModelReady();
    const wantsGlb = !def.isBoss && isZombieModelReady();

    let next: ZombieVisual;
    if (wantsBoss) {
      if (!this.bossVisual) this.bossVisual = new GlbBossVisual();
      next = this.bossVisual;
    } else if (wantsGlb) {
      if (!this.glbVisual) this.glbVisual = new GlbZombieVisual();
      next = this.glbVisual;
    } else {
      if (!this.proceduralVisual) this.proceduralVisual = new ProceduralZombieVisual();
      next = this.proceduralVisual;
    }

    if (this.visual !== next) {
      if (this.visual) this.container.remove(this.visual.root);
      this.container.add(next.root);
      this.visual = next;
    }

    // Only one boss is ever alive, but every pooled body that has *ever* been
    // one would otherwise hold on to its own copy of the sculpted mesh and its
    // materials for the rest of the run. Bosses come round once every five
    // waves, so rebuilding one is far cheaper than keeping dozens resident.
    if (!wantsBoss && this.bossVisual) {
      this.bossVisual.dispose();
      this.bossVisual = null;
    }

    return next;
  }

  get isAlive(): boolean {
    return this.state !== 'inactive' && this.state !== 'dying';
  }

  get isActive(): boolean {
    return this.state !== 'inactive';
  }

  get healthFraction(): number {
    return clamp01(this.health / this.maxHealth);
  }

  // -------------------------------------------------------------------------
  // Spawning / despawning
  // -------------------------------------------------------------------------

  spawn(options: ZombieSpawnOptions): void {
    const def = ZOMBIE_TYPES[options.type];
    this.def = def;

    const visual = this.selectVisual(def);
    visual.applyType(def, options.colorIndex);

    this.maxHealth = def.health * options.healthMultiplier;
    this.health = this.maxHealth;
    this.damage = def.damage * options.damageMultiplier;
    this.speed = def.speed * options.speedMultiplier;
    this.radius = visual.bodyRadius;
    this.headHeight = visual.headHeight;
    this.headRadius = visual.headRadius;
    this.slotAngle = options.slotAngle;

    this.position.copy(options.position);
    this.position.y = 0;
    this.velocity.set(0, 0, 0);
    this.facing = Math.random() * TAU;

    this.state = 'spawning';
    this.stateTimer = 0.62;
    this.attackTimer = 0;
    this.attackWindup = 0;
    this.hitFlash = 0;
    this.staggerTimer = 0;
    this.primeTimer = 0;
    this.primeBeepStep = 0;
    this.deathSpin = 0;
    this.gaitPhase = Math.random() * TAU;
    this.idlePhase = Math.random() * TAU;
    this.growlTimer = randRange(0.4, 3.2);

    this.animState.phaseOffset = Math.random() * TAU;
    visual.resetPose();
    visual.setPrimingGlow(0);
    visual.setHitFlash(0);

    this.container.visible = true;
    this.container.position.copy(this.position);
    this.container.rotation.set(0, this.facing, 0);
    this.container.scale.setScalar(0.001);
    this.setLodLevel(0, true);
  }

  deactivate(): void {
    this.state = 'inactive';
    this.container.visible = false;
    this.onRemoved?.(this);
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  /**
   * Applies a hit.
   *
   * `headshot` comes from the ray test against the head sphere. Callers that
   * have no ray (explosions) pass `undefined` and we fall back to a height
   * test against the neck line.
   */
  takeDamage(
    amount: number,
    hitPoint: THREE.Vector3,
    critical: boolean,
    headshotMultiplier: number,
    headshotOverride?: boolean,
  ): ZombieHitResult {
    const headThreshold = this.position.y + this.headHeight - 0.28 * this.def.scale;
    const headshot = headshotOverride ?? hitPoint.y >= headThreshold;

    let finalDamage = amount;
    if (headshot) finalDamage *= headshotMultiplier * (this.def.headshotMultiplier / 2.3);
    if (critical) finalDamage *= 2;

    this.health -= finalDamage;
    this.hitFlash = 1;

    // Light knockback and stagger — weight-scaled so tanks barely flinch.
    const massFactor = 1 / (0.6 + this.def.scale * 1.4);
    this.staggerTimer = Math.max(this.staggerTimer, 0.09 * massFactor);

    const killed = this.health <= 0;
    if (killed && this.state !== 'dying') {
      this.beginDeath();
    } else if (!killed && Math.random() < 0.4) {
      audio.sfx.zombieHurt(this.def.voicePitch, this.position);
    }

    return {
      damage: finalDamage,
      killed,
      headshot,
      critical,
      position: hitPoint.clone(),
    };
  }

  private beginDeath(): void {
    this.state = 'dying';
    this.stateTimer = 0.85;
    this.health = 0;
    this.deathSpin = randRange(-1, 1);
    audio.sfx.zombieDeath(this.def.voicePitch, this.position);
    this.onDeath?.(this);

    // A dying exploder still goes off — that's the whole point of the class.
    if (this.def.explodes) this.onExplode?.(this);
  }

  /** Instantly removes a zombie without rewarding a kill (wave cleanup). */
  despawnSilently(): void {
    this.state = 'dying';
    this.stateTimer = 0.3;
    this.health = 0;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(ctx: ZombieUpdateContext): void {
    const { dt } = ctx;
    if (this.state === 'inactive') return;

    this.hitFlash = Math.max(0, this.hitFlash - dt * 6);
    this.staggerTimer = Math.max(0, this.staggerTimer - dt);
    this.idlePhase += dt;

    this.updateLod(ctx);

    switch (this.state) {
      case 'spawning':
        this.updateSpawning(ctx);
        break;
      case 'chasing':
      case 'attacking':
        this.updateChase(ctx);
        break;
      case 'priming':
        this.updatePriming(ctx);
        break;
      case 'dying':
        this.updateDying(ctx);
        return;
    }

    this.updateVocalisation(ctx);
    this.applyTransform();
    this.animate(ctx);
    this.applyHitFlash();
  }

  /** Grow-in pop when a zombie arrives. */
  private updateSpawning(ctx: ZombieUpdateContext): void {
    this.stateTimer -= ctx.dt;
    const t = clamp01(1 - this.stateTimer / 0.62);
    this.container.scale.setScalar(Math.max(0.001, Easing.backOut(t)));

    // Face the player as it rises.
    _toPlayer.subVectors(ctx.playerPosition, this.position);
    this.facing = dampAngle(this.facing, Math.atan2(_toPlayer.x, _toPlayer.z), 6, ctx.dt);

    if (this.stateTimer <= 0) {
      this.state = 'chasing';
      this.container.scale.setScalar(1);
      audio.sfx.zombieGrowl(this.def.voicePitch, 0.7, this.position);
    }
  }

  private updateChase(ctx: ZombieUpdateContext): void {
    const { dt } = ctx;

    _toPlayer.subVectors(ctx.playerPosition, this.position);
    _toPlayer.y = 0;
    const distance = _toPlayer.length();
    const contactRange = this.def.attackRange + this.radius;

    // --- Exploders arm themselves instead of swinging ----------------------
    if (this.def.explodes && distance <= this.def.explosionRadius * 0.46 && ctx.playerAlive) {
      this.state = 'priming';
      this.primeTimer = 1.15 - ctx.aggression * 0.25;
      this.primeBeepStep = 0;
      return;
    }

    // --- Attack ------------------------------------------------------------
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    const inRange = distance <= contactRange;

    if (inRange && ctx.playerAlive) {
      this.state = 'attacking';
      if (this.attackTimer <= 0 && this.attackWindup <= 0) {
        // Windup shortens as waves progress, so late waves feel relentless.
        this.attackWindup = lerp(0.34, 0.18, clamp01(ctx.aggression));
      }
    } else if (this.state === 'attacking' && this.attackWindup <= 0) {
      this.state = 'chasing';
    }

    if (this.attackWindup > 0) {
      this.attackWindup -= dt;
      if (this.attackWindup <= 0) {
        // Only lands if the player is still in range at the swing's apex,
        // which makes backpedalling a genuinely effective defence.
        if (distance <= contactRange + 0.35 && ctx.playerAlive) {
          this.onAttack?.(this, this.damage);
        }
        this.attackTimer = this.def.attackInterval;
      }
    }

    // --- Steering ----------------------------------------------------------
    let dirX = 0;
    let dirZ = 0;

    const useDirect = distance < 7.5;
    if (useDirect && distance > 0.001) {
      dirX = _toPlayer.x / distance;
      dirZ = _toPlayer.z / distance;
    } else if (ctx.navGrid.sampleDirection(this.position.x, this.position.z, _flow)) {
      dirX = _flow.x;
      dirZ = _flow.z;
    } else if (distance > 0.001) {
      // No field data (shouldn't happen) — fall back to a direct line.
      dirX = _toPlayer.x / distance;
      dirZ = _toPlayer.z / distance;
    }

    // Encirclement: steer toward this zombie's assigned slot on a ring around
    // the player, blending out as it closes so the final approach stays direct.
    if (distance > contactRange * 1.2) {
      const ringRadius = lerp(3.2, 1.9, clamp01(ctx.aggression));
      const slotX = ctx.playerPosition.x + Math.cos(this.slotAngle) * ringRadius;
      const slotZ = ctx.playerPosition.z + Math.sin(this.slotAngle) * ringRadius;
      const sx = slotX - this.position.x;
      const sz = slotZ - this.position.z;
      const slotDist = Math.hypot(sx, sz);
      if (slotDist > 0.01) {
        const blend = clamp01((distance - contactRange) / 9) * 0.45;
        dirX = lerp(dirX, sx / slotDist, blend);
        dirZ = lerp(dirZ, sz / slotDist, blend);
      }
    }

    // Separation from neighbours.
    dirX += ctx.separationX;
    dirZ += ctx.separationZ;

    const dirLength = Math.hypot(dirX, dirZ);
    if (dirLength > 0.001) {
      dirX /= dirLength;
      dirZ /= dirLength;
    }

    // --- Speed -------------------------------------------------------------
    let speed = this.speed;
    if (this.state === 'attacking' || this.attackWindup > 0) speed *= 0.16;
    if (this.staggerTimer > 0) speed *= 0.35;
    // Ease off at the very last moment so they don't shove the player around.
    if (distance < contactRange) speed *= 0.25;

    const targetVx = dirX * speed;
    const targetVz = dirZ * speed;
    // Heavier classes accelerate more slowly — momentum you can play around.
    const accel = lerp(14, 5, clamp01((this.def.scale - 0.8) / 2));
    this.velocity.x = damp(this.velocity.x, targetVx, accel, dt);
    this.velocity.z = damp(this.velocity.z, targetVz, accel, dt);

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    ctx.collision.resolveCircle(this.position, this.radius * 0.85, 0, 1.4);

    // --- Facing ------------------------------------------------------------
    const targetFacing =
      distance < 5
        ? Math.atan2(_toPlayer.x, _toPlayer.z)
        : Math.atan2(this.velocity.x, this.velocity.z);
    if (Math.hypot(this.velocity.x, this.velocity.z) > 0.15 || distance < 5) {
      this.facing = dampAngle(this.facing, targetFacing, 7, dt);
    }
  }

  /** Exploder countdown: pulsing, beeping, then detonation. */
  private updatePriming(ctx: ZombieUpdateContext): void {
    this.primeTimer -= ctx.dt;
    this.velocity.multiplyScalar(Math.max(0, 1 - 6 * ctx.dt));
    this.position.x += this.velocity.x * ctx.dt;
    this.position.z += this.velocity.z * ctx.dt;

    // Beeps accelerate as it gets closer to going off.
    const beepInterval = lerp(0.09, 0.3, clamp01(this.primeTimer / 1.15));
    if (ctx.elapsed - this.primeBeepStep > beepInterval) {
      this.primeBeepStep = ctx.elapsed;
      audio.sfx.exploderBeep(clamp01(1 - this.primeTimer / 1.15) * 6, this.position);
    }

    // Swell and flash while priming.
    const pulse = 1 + Math.sin(ctx.elapsed * 26) * 0.09 * (1 - this.primeTimer / 1.15);
    const swell = lerp(1, 1.35, clamp01(1 - this.primeTimer / 1.15));
    this.container.scale.setScalar(pulse * swell);
    this.visual.setPrimingGlow(clamp01(1 - this.primeTimer / 1.15));

    if (this.primeTimer <= 0) {
      this.health = 0;
      this.beginDeath();
    }
  }

  private updateDying(ctx: ZombieUpdateContext): void {
    this.stateTimer -= ctx.dt;
    const t = clamp01(1 - this.stateTimer / 0.85);

    // Topple over, spin a little, then shrink away in a puff.
    const fall = Easing.quadIn(clamp01(t * 1.5));
    const shrink = t < 0.6 ? 1 : 1 - Easing.cubicIn((t - 0.6) / 0.4);

    this.container.position.set(this.position.x, this.position.y + fall * 0.06, this.position.z);
    // Topple backward and away, with a little spin.
    this.container.rotation.set(fall * Math.PI * 0.42, this.facing, this.deathSpin * fall * 0.7);
    this.container.scale.setScalar(Math.max(0.001, shrink));

    // The skeleton buckles while the whole body falls.
    this.animState.dt = ctx.dt;
    this.animState.elapsed = ctx.elapsed;
    this.animState.deathProgress = t;
    this.visual.animate(this.animState);

    if (this.stateTimer <= 0) this.deactivate();
  }

  private updateVocalisation(ctx: ZombieUpdateContext): void {
    this.growlTimer -= ctx.dt;
    if (this.growlTimer > 0) return;
    // Growl more often the closer and more aggressive they are; skip entirely
    // for distant zombies so the mix never turns to mud.
    if (ctx.cameraDistance < 34) {
      audio.sfx.zombieGrowl(
        this.def.voicePitch * randRange(0.92, 1.1),
        randRange(0.45, 0.95),
        this.position,
      );
    }
    this.growlTimer = randRange(2.6, 6.5) / (1 + ctx.aggression * 0.6);
  }

  private applyTransform(): void {
    this.container.position.copy(this.position);
    this.container.rotation.set(0, this.facing, 0);
    this.worldCenter.set(this.position.x, this.position.y + this.headHeight * 0.72, this.position.z);
  }

  /**
   * Advances the walk cycle and hands the resulting pose to the active visual.
   *
   * The entity only computes *numbers* — stride, phase, windup, look angle —
   * and never touches bones or meshes. That's what lets a skinned glTF body
   * and the boss's primitive rig be driven by exactly the same gameplay code.
   */
  private animate(ctx: ZombieUpdateContext): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const stride = clamp01(speed / Math.max(0.5, this.speed));

    // Walking below ~2.8 m/s, unmistakably running by ~5.5. Smoothstepped so a
    // zombie hovering around the threshold doesn't flicker between gaits.
    const runT = clamp01((speed - 2.8) / 2.7);
    const run = runT * runT * (3 - 2 * runT);

    // Cadence rises with the run blend as well as the stride, so a sprinter's
    // legs turn over visibly faster than a shambler at its own top speed.
    this.gaitPhase += ctx.dt * this.def.gaitFrequency * (4.2 + stride * 3.4 + run * 2.6);

    // Signed yaw from where the body faces to where the player actually is.
    const toPlayerAngle = Math.atan2(
      ctx.playerPosition.x - this.position.x,
      ctx.playerPosition.z - this.position.z,
    );
    let lookOffset = toPlayerAngle - this.facing;
    lookOffset = ((lookOffset + Math.PI) % TAU + TAU) % TAU - Math.PI;

    const state = this.animState;
    state.dt = ctx.dt;
    state.elapsed = ctx.elapsed;
    state.stride = stride;
    state.speed = speed;
    state.run = run;
    state.gaitPhase = this.gaitPhase;
    state.attackWindup = this.attackWindup;
    state.attackWindupDuration = lerp(0.34, 0.18, clamp01(ctx.aggression));
    state.isAttacking = this.state === 'attacking';
    state.deathProgress = 0;
    state.lookOffset = lookOffset;

    this.visual.animate(state);
  }

  /** White flash on hit. */
  private applyHitFlash(): void {
    if (this.state === 'priming') return;
    this.visual.setHitFlash(this.hitFlash);
  }

  /**
   * Distance-based detail reduction. For the skinned character this throttles
   * how often the 114-bone skeleton is re-posed, which is by far the largest
   * per-zombie CPU cost.
   */
  private updateLod(ctx: ZombieUpdateContext): void {
    const distance = ctx.cameraDistance;
    const level = distance < 24 ? 0 : distance < 48 ? 1 : 2;
    this.setLodLevel(level, false, ctx.shadowBudgetRemaining > 0 && distance < 32);
  }

  private setLodLevel(level: number, force: boolean, allowShadows = true): void {
    const wantShadow = level === 0 && allowShadows;
    if (level !== this.lodLevel || force) {
      this.lodLevel = level;
      this.visual.setLod(level);
    }
    if (wantShadow !== this.shadowsEnabled || force) {
      this.shadowsEnabled = wantShadow;
      this.visual.setShadowsEnabled(wantShadow);
    }
  }

  dispose(): void {
    this.glbVisual?.dispose();
    this.proceduralVisual?.dispose();
    this.glbVisual = null;
    this.proceduralVisual = null;
  }
}
