import * as THREE from 'three';
import {
  applyZombieType,
  bodyRadiusFor,
  createZombieRig,
  headHeightFor,
  type ZombieRig,
} from './ZombieModel';
import { ZOMBIE_TYPES, type ZombieTypeDef, type ZombieTypeId } from './ZombieTypes';
import type { NavGrid } from '../systems/NavGrid';
import type { CollisionWorld } from '../systems/CollisionWorld';
import { audio } from '../audio/AudioManager';
import { clamp, clamp01, damp, dampAngle, lerp, randRange, TAU } from '../utilities/MathUtils';
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
  readonly rig: ZombieRig;

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
  private lodLevel = 0;
  private idlePhase = 0;

  /** Set by the manager each frame so damage numbers can find their anchor. */
  readonly worldCenter = new THREE.Vector3();

  onAttack: ((zombie: Zombie, damage: number) => void) | null = null;
  onExplode: ((zombie: Zombie) => void) | null = null;
  onDeath: ((zombie: Zombie) => void) | null = null;
  onRemoved: ((zombie: Zombie) => void) | null = null;

  constructor() {
    this.rig = createZombieRig();
    this.rig.root.visible = false;
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

    applyZombieType(this.rig, def, options.colorIndex);

    this.maxHealth = def.health * options.healthMultiplier;
    this.health = this.maxHealth;
    this.damage = def.damage * options.damageMultiplier;
    this.speed = def.speed * options.speedMultiplier;
    this.radius = bodyRadiusFor(def);
    this.headHeight = headHeightFor(def);
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

    this.rig.root.visible = true;
    this.rig.root.position.copy(this.position);
    this.rig.root.scale.setScalar(0.001);
    this.setLodLevel(0, true);
  }

  deactivate(): void {
    this.state = 'inactive';
    this.rig.root.visible = false;
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
    const scale = Easing.backOut(t) * this.def.scale;
    this.rig.root.scale.setScalar(Math.max(0.001, scale));

    // Face the player as it rises.
    _toPlayer.subVectors(ctx.playerPosition, this.position);
    this.facing = dampAngle(this.facing, Math.atan2(_toPlayer.x, _toPlayer.z), 6, ctx.dt);

    if (this.stateTimer <= 0) {
      this.state = 'chasing';
      this.rig.root.scale.setScalar(this.def.scale);
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
    this.rig.root.scale.setScalar(this.def.scale * pulse * swell);
    this.rig.skinMaterial.emissive.setRGB(1, 0.45, 0.15);
    this.rig.skinMaterial.emissiveIntensity = (1 - this.primeTimer / 1.15) * 1.4;

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

    this.rig.root.position.set(this.position.x, this.position.y + fall * 0.1, this.position.z);
    this.rig.root.rotation.set(fall * Math.PI * 0.48, this.facing, this.deathSpin * fall * 0.8);
    this.rig.root.scale.setScalar(Math.max(0.001, this.def.scale * shrink));

    // Legs and arms flail outward as it falls.
    this.rig.armLeft.rotation.set(-fall * 1.6, 0, -fall * 0.9);
    this.rig.armRight.rotation.set(-fall * 1.6, 0, fall * 0.9);
    this.rig.legLeft.rotation.set(fall * 0.9, 0, 0);
    this.rig.legRight.rotation.set(fall * 0.6, 0, 0);

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
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.set(0, this.facing, 0);
    this.worldCenter.set(this.position.x, this.position.y + this.headHeight * 0.72, this.position.z);
  }

  /**
   * The funny walk. Everything is driven off `gaitPhase`, which advances with
   * real ground speed so the animation always matches the movement.
   */
  private animate(ctx: ZombieUpdateContext): void {
    const { rig, def } = this;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const stride = clamp01(speed / Math.max(0.5, this.speed));

    this.gaitPhase += ctx.dt * def.gaitFrequency * (4.2 + stride * 3.4);

    const swing = Math.sin(this.gaitPhase);
    const swing2 = Math.sin(this.gaitPhase * 2);
    const amp = 0.55 + stride * 0.55;
    const wobble = def.gaitWobble;

    // --- Legs: alternating pendulum with a slight knee-less kick ------------
    rig.legLeft.rotation.x = swing * amp * 0.9;
    rig.legRight.rotation.x = -swing * amp * 0.9;
    rig.legLeft.rotation.z = 0.06 * wobble;
    rig.legRight.rotation.z = -0.06 * wobble;

    // --- Body: bob, sway and lean ------------------------------------------
    const bobHeight = Math.abs(swing2) * 0.07 * stride * wobble;
    const idleBreath = Math.sin(this.idlePhase * 2.1) * 0.012;
    rig.body.position.y = bobHeight + idleBreath;
    rig.body.rotation.z = -swing * 0.1 * wobble * stride;
    rig.body.rotation.x = 0.13 + stride * 0.12;
    rig.body.rotation.y = swing * 0.09 * stride;

    // --- Arms ---------------------------------------------------------------
    if (this.attackWindup > 0) {
      // Wind up overhead, then slam down.
      const w = 1 - clamp01(this.attackWindup / 0.34);
      const raise = Math.sin(w * Math.PI) * 1.5;
      rig.armLeft.rotation.x = -1.4 - raise;
      rig.armRight.rotation.x = -1.4 - raise;
      rig.armLeft.rotation.z = 0.35;
      rig.armRight.rotation.z = -0.35;
      rig.body.rotation.x = 0.13 - raise * 0.18;
    } else if (this.state === 'attacking') {
      // Reaching forward, hands grabbing.
      const grab = Math.sin(ctx.elapsed * 9 + this.idlePhase) * 0.16;
      rig.armLeft.rotation.x = -1.5 + grab;
      rig.armRight.rotation.x = -1.5 - grab;
      rig.armLeft.rotation.z = 0.28;
      rig.armRight.rotation.z = -0.28;
    } else {
      // Classic outstretched zombie arms, swaying opposite to the legs.
      const reach = lerp(-0.55, -1.35, stride);
      rig.armLeft.rotation.x = reach - swing * 0.42 * amp;
      rig.armRight.rotation.x = reach + swing * 0.42 * amp;
      rig.armLeft.rotation.z = 0.2 + swing * 0.12 * wobble;
      rig.armRight.rotation.z = -0.2 + swing * 0.12 * wobble;
    }

    // --- Head: lags the body, bobbles, and locks onto the player ------------
    const headBob = Math.sin(this.gaitPhase * 2 + 0.7) * 0.13 * stride * wobble;
    rig.head.rotation.z = -rig.body.rotation.z * 1.4 + headBob * 0.4;
    rig.head.rotation.x = -rig.body.rotation.x * 0.75 + headBob * 0.35;
    rig.head.rotation.y = -swing * 0.14 * stride;

    // Pupils track the player: a tiny detail that makes them feel alive.
    const toPlayerLocal = Math.atan2(
      ctx.playerPosition.x - this.position.x,
      ctx.playerPosition.z - this.position.z,
    );
    let lookOffset = toPlayerLocal - this.facing;
    lookOffset = ((lookOffset + Math.PI) % TAU + TAU) % TAU - Math.PI;
    rig.pupils.position.x = clamp(lookOffset, -0.7, 0.7) * 0.045;
    rig.pupils.position.y = Math.sin(this.idlePhase * 1.3) * 0.006;

    // Blink: pupils squash briefly at random intervals.
    const blink = Math.sin(this.idlePhase * 0.9 + this.slotAngle);
    if (blink > 0.995) {
      rig.eyes.scale.y = def.proportions.eye * 0.25;
    } else {
      rig.eyes.scale.y = def.proportions.eye;
    }
  }

  /** White flash on hit, tinted toward the class accent. */
  private applyHitFlash(): void {
    if (this.state === 'priming') return;
    const flash = this.hitFlash * this.hitFlash;
    if (flash > 0.001) {
      this.rig.skinMaterial.emissive.setRGB(flash, flash * 0.85, flash * 0.7);
      this.rig.skinMaterial.emissiveIntensity = 1;
    } else if (this.rig.skinMaterial.emissiveIntensity !== 0) {
      this.rig.skinMaterial.emissive.setRGB(0, 0, 0);
      this.rig.skinMaterial.emissiveIntensity = 0;
    }
  }

  /**
   * Distance-based detail reduction. Eyes, brows and shadow casting are the
   * first things to go — none of them are legible past ~25 m anyway.
   */
  private updateLod(ctx: ZombieUpdateContext): void {
    const distance = ctx.cameraDistance;
    const level = distance < 24 ? 0 : distance < 48 ? 1 : 2;
    this.setLodLevel(level, false, ctx.shadowBudgetRemaining > 0 && distance < 32);
  }

  private setLodLevel(level: number, force: boolean, allowShadows = true): void {
    if (level === this.lodLevel && !force) {
      // Shadow budget can change without the LOD level changing.
      const wantShadow = level === 0 && allowShadows;
      if (this.rig.torso.castShadow !== wantShadow) this.applyShadowFlag(wantShadow);
      return;
    }
    this.lodLevel = level;

    const showDetail = level === 0;
    for (const mesh of this.rig.detailMeshes) {
      // The accessory stays visible at mid range — it's a class read.
      if (mesh === this.rig.accessory) continue;
      mesh.visible = showDetail || level === 1;
    }
    this.rig.brow.visible = showDetail;
    this.applyShadowFlag(level === 0 && allowShadows);
  }

  private applyShadowFlag(enabled: boolean): void {
    this.rig.torso.castShadow = enabled;
    this.rig.skull.castShadow = enabled;
    (this.rig.armLeft.children[0] as THREE.Mesh).castShadow = enabled;
    (this.rig.armRight.children[0] as THREE.Mesh).castShadow = enabled;
    (this.rig.legLeft.children[0] as THREE.Mesh).castShadow = enabled;
    (this.rig.legRight.children[0] as THREE.Mesh).castShadow = enabled;
  }

  dispose(): void {
    this.rig.skinMaterial.dispose();
    this.rig.accentMaterial.dispose();
  }
}
