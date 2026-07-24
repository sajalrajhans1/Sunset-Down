import * as THREE from 'three';
import type { Zombie } from '../components/Zombie';
import type { ZombieManager } from './ZombieManager';
import type { CollisionWorld } from './CollisionWorld';
import type { ParticleSystem } from './ParticleSystem';
import type { DecalSystem } from './DecalSystem';
import type { DamageNumbers } from './DamageNumbers';
import type { EconomySystem } from './EconomySystem';
import type { PlayerStats } from '../game/PlayerStats';
import type { Weapon, ShotRequest } from '../weapons/Weapon';
import { audio } from '../audio/AudioManager';
import { COMBAT } from '../game/Config';
import { DEG2RAD, randRange, TAU } from '../utilities/MathUtils';

export interface CombatHitFeedback {
  anyHit: boolean;
  killed: boolean;
  headshot: boolean;
  critical: boolean;
}

interface AggregatedHit {
  zombie: Zombie;
  damage: number;
  headshot: boolean;
  critical: boolean;
  point: THREE.Vector3;
  killed: boolean;
}

/**
 * Resolves weapon fire into damage, feedback and world effects.
 *
 * Kept separate from both the weapon (which owns timing and animation) and the
 * zombie manager (which owns entities) so that hit resolution — the part most
 * likely to need tuning — lives in exactly one readable place.
 *
 * Each pellet is traced independently and can pass through multiple zombies,
 * losing damage at every penetration until it either runs out of penetrations
 * or strikes solid geometry.
 */
export class CombatSystem {
  private readonly _origin = new THREE.Vector3();
  private readonly _direction = new THREE.Vector3();
  private readonly _spreadDir = new THREE.Vector3();
  private readonly _basisRight = new THREE.Vector3();
  private readonly _basisUp = new THREE.Vector3();
  private readonly _worldUp = new THREE.Vector3(0, 1, 0);
  private readonly _traceStart = new THREE.Vector3();

  /** Reused per shot so multi-pellet weapons produce one number per target. */
  private readonly aggregated = new Map<Zombie, AggregatedHit>();
  private readonly ignoreSet = new Set<Zombie>();

  constructor(
    private readonly zombies: ZombieManager,
    private readonly collision: CollisionWorld,
    private readonly particles: ParticleSystem,
    private readonly decals: DecalSystem,
    private readonly damageNumbers: DamageNumbers,
    private readonly economy: EconomySystem,
    private readonly stats: PlayerStats,
  ) {}

  /**
   * Traces a shot and applies all of its effects.
   * Returns feedback so the caller can drive hit markers and screen shake.
   */
  fire(
    weapon: Weapon,
    shot: ShotRequest,
    cameraPosition: THREE.Vector3,
    cameraDirection: THREE.Vector3,
    showDamageNumbers: boolean,
  ): CombatHitFeedback {
    this._origin.copy(cameraPosition);
    this._direction.copy(cameraDirection).normalize();

    // Orthonormal basis for scattering pellets around the aim vector.
    this._basisRight.crossVectors(this._direction, this._worldUp);
    if (this._basisRight.lengthSq() < 1e-6) this._basisRight.set(1, 0, 0);
    this._basisRight.normalize();
    this._basisUp.crossVectors(this._basisRight, this._direction).normalize();

    this.aggregated.clear();
    this.economy.registerShot(shot.pellets);

    const critChance = this.stats.criticalChance;
    const spreadRadians = shot.spreadDegrees * DEG2RAD;

    let anyHit = false;

    for (let pellet = 0; pellet < shot.pellets; pellet++) {
      // Sample inside the cone with a sqrt distribution so pellets cluster
      // toward the centre instead of forming a ring.
      const angle = Math.random() * TAU;
      const radius = Math.sqrt(Math.random()) * spreadRadians;
      this._spreadDir
        .copy(this._direction)
        .addScaledVector(this._basisRight, Math.cos(angle) * Math.tan(radius))
        .addScaledVector(this._basisUp, Math.sin(angle) * Math.tan(radius))
        .normalize();

      if (this.tracePellet(weapon, shot, critChance, this._spreadDir)) anyHit = true;
    }

    // Muzzle effects, once per trigger pull.
    this.particles.muzzleSmoke(
      weapon.model.muzzle.getWorldPosition(new THREE.Vector3()),
      this._direction,
      shot.pellets > 1 ? 1.8 : 1,
    );

    return this.resolveFeedback(anyHit, showDamageNumbers);
  }

  /** Traces a single pellet through zombies and into the world. */
  private tracePellet(
    weapon: Weapon,
    shot: ShotRequest,
    critChance: number,
    direction: THREE.Vector3,
  ): boolean {
    this.ignoreSet.clear();
    this._traceStart.copy(this._origin);

    let remainingPenetration = shot.penetration;
    let damage = shot.damagePerPellet;
    let travelled = 0;
    let hitSomething = false;

    while (remainingPenetration > 0) {
      const budget = COMBAT.maxTraceDistance - travelled;
      if (budget <= 0) break;

      const zombieHit = this.zombies.raycast(this._traceStart, direction, budget, this.ignoreSet);
      const worldHit = this.collision.raycast(this._traceStart, direction, budget);

      const zombieFirst = zombieHit && (!worldHit || zombieHit.distance <= worldHit.distance);

      if (zombieFirst && zombieHit) {
        hitSomething = true;
        const totalDistance = travelled + zombieHit.distance;
        const critical = Math.random() < critChance;
        const rangedDamage = weapon.damageAtRange(damage, totalDistance);

        const result = zombieHit.zombie.takeDamage(
          rangedDamage,
          zombieHit.point,
          critical,
          COMBAT.headshotMultiplier,
          zombieHit.headshot,
        );

        this.economy.registerHit(result.damage, critical);
        this.accumulate(zombieHit.zombie, result.damage, result.headshot, critical, zombieHit.point, result.killed);

        this.particles.zombieHit(
          zombieHit.point,
          direction.clone().negate(),
          zombieHit.zombie.rig.skinMaterial.color.getHex(),
          critical || result.headshot,
        );

        this.ignoreSet.add(zombieHit.zombie);
        remainingPenetration--;
        damage *= shot.penetration > 1 ? weapon.def.penetrationFalloff : 0;

        travelled = totalDistance + 0.05;
        this._traceStart.addScaledVector(direction, zombieHit.distance + 0.05);
        continue;
      }

      if (worldHit) {
        hitSomething = true;
        this.decals.spawn(worldHit.point, worldHit.normal, worldHit.isGround ? 0.3 : 0.22);
        this.particles.bulletImpact(worldHit.point, worldHit.normal, worldHit.impactColor);
        audio.sfx.impact(surfaceFromColor(worldHit.impactColor, worldHit.isGround), worldHit.point);
      }
      break;
    }

    return hitSomething;
  }

  private accumulate(
    zombie: Zombie,
    damage: number,
    headshot: boolean,
    critical: boolean,
    point: THREE.Vector3,
    killed: boolean,
  ): void {
    const existing = this.aggregated.get(zombie);
    if (existing) {
      existing.damage += damage;
      existing.headshot = existing.headshot || headshot;
      existing.critical = existing.critical || critical;
      existing.killed = existing.killed || killed;
    } else {
      this.aggregated.set(zombie, {
        zombie,
        damage,
        headshot,
        critical,
        point: point.clone(),
        killed,
      });
    }
  }

  /** Turns the aggregated hits into damage numbers, sounds and feedback flags. */
  private resolveFeedback(anyHit: boolean, showDamageNumbers: boolean): CombatHitFeedback {
    let killed = false;
    let headshot = false;
    let critical = false;

    for (const hit of this.aggregated.values()) {
      killed = killed || hit.killed;
      headshot = headshot || hit.headshot;
      critical = critical || hit.critical;

      if (showDamageNumbers) {
        // Nudge the number off-centre so overlapping hits stay legible.
        const anchor = hit.point.clone();
        anchor.x += randRange(-0.18, 0.18);
        anchor.y += randRange(0.05, 0.28);
        anchor.z += randRange(-0.18, 0.18);

        const style = hit.killed
          ? 'kill'
          : hit.critical
            ? 'critical'
            : hit.headshot
              ? 'headshot'
              : 'normal';
        this.damageNumbers.spawn(anchor, hit.damage, style);
      }
    }

    if (anyHit) {
      audio.sfx.hitMarker(killed ? 'kill' : critical || headshot ? 'critical' : 'normal');
    }

    return { anyHit, killed, headshot, critical };
  }

  /**
   * Detonates an exploder. Damages nearby zombies and, if close enough, the
   * player — friendly fire in both directions makes them a real threat and a
   * real opportunity.
   */
  detonate(
    source: Zombie,
    playerPosition: THREE.Vector3,
    onPlayerDamage: (amount: number, from: THREE.Vector3) => void,
    showDamageNumbers: boolean,
  ): void {
    const def = source.def;
    const centre = source.position.clone();
    centre.y += source.headHeight * 0.45;

    this.particles.explosion(centre, def.explosionRadius);
    audio.sfx.explosion(centre);

    this.zombies.applyExplosion(centre, def.explosionRadius, def.explosionDamage * 1.6, source, (zombie, result) => {
      this.economy.registerHit(result.damage, false);
      if (showDamageNumbers) {
        this.damageNumbers.spawn(
          new THREE.Vector3(zombie.position.x, zombie.position.y + zombie.headHeight, zombie.position.z),
          result.damage,
          'normal',
        );
      }
    });

    const distance = Math.hypot(playerPosition.x - centre.x, playerPosition.z - centre.z);
    if (distance <= def.explosionRadius) {
      const falloff = 1 - distance / def.explosionRadius;
      onPlayerDamage(def.explosionDamage * falloff, centre);
    }
  }
}

/**
 * Maps an impact colour back to a rough material family for audio. Cheaper and
 * simpler than threading a material id through the whole collision layer, and
 * accurate enough that stone, wood and metal all sound distinct.
 */
function surfaceFromColor(color: number, isGround: boolean): 'stone' | 'wood' | 'metal' | 'dirt' | 'foliage' {
  if (isGround) return 'dirt';
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;

  // Strongly green surfaces are foliage.
  if (g > r + 18 && g > b + 18) return 'foliage';
  // Neutral greys with low saturation read as metal.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 26 && max > 120) return 'metal';
  // Warm mid-tones are wood.
  if (r > b + 30) return 'wood';
  return 'stone';
}
