import type * as THREE from 'three';
import type { ZombieTypeDef } from './ZombieTypes';

/**
 * Everything the animation layer needs to know about a zombie this frame.
 *
 * Deliberately free of any Three.js types: the Zombie entity computes pure
 * numbers, and each visual implementation decides how to express them —
 * whether that's rotating primitive groups or driving a skinned skeleton.
 */
export interface ZombieAnimationState {
  dt: number;
  elapsed: number;
  /** 0..1 ground speed relative to this zombie's own top speed. */
  stride: number;
  /** Ground speed in metres per second, absolute. */
  speed: number;
  /**
   * 0..1 blend from a walk cycle to a run cycle.
   *
   * Distinct from `stride`, which is normalised against each class's own top
   * speed — so a shambler plodding at its maximum and a sprinter flat out both
   * report a stride of 1 and would animate identically. This is derived from
   * absolute speed instead, which is what actually decides whether a body is
   * walking or running.
   */
  run: number;
  /** Continuously advancing walk-cycle phase, in radians. */
  gaitPhase: number;
  /** Seconds remaining in the attack windup; 0 when not winding up. */
  attackWindup: number;
  /** Length of a full windup, for normalising the above. */
  attackWindupDuration: number;
  isAttacking: boolean;
  /** 0..1 progress through the death animation. */
  deathProgress: number;
  /** Signed yaw from facing direction to the player, in radians. */
  lookOffset: number;
  /** Per-instance random offset so identical classes desynchronise. */
  phaseOffset: number;
}

/**
 * A zombie's renderable body.
 *
 * Two implementations exist: the original procedural primitive rig (still used
 * by the boss) and a skinned glTF character (used by every other class). The
 * Zombie entity talks only to this interface, so swapping a class's appearance
 * is a one-line change and the two can coexist in the same wave.
 */
export interface ZombieVisual {
  /** Node the entity positions and rotates. */
  readonly root: THREE.Object3D;

  /** Albedo tint of this zombie, used to colour hit and death particles. */
  readonly bodyColor: number;

  /** Head centre height in local units at the current scale — headshot line. */
  readonly headHeight: number;

  /** Collision/hit radius in world units at the current scale. */
  readonly bodyRadius: number;

  /** Radius of the headshot sphere in world units at the current scale. */
  readonly headRadius: number;

  /** Reconfigures the body for a class and colour variant. */
  applyType(def: ZombieTypeDef, colorIndex: number): void;

  /** Poses the body for this frame. */
  animate(state: ZombieAnimationState): void;

  /** 0..1 white flash on damage. */
  setHitFlash(amount: number): void;

  /** 0..1 glow for an exploder about to detonate. */
  setPrimingGlow(amount: number): void;

  setShadowsEnabled(enabled: boolean): void;

  /** 0 = full detail, 1 = mid, 2 = distant. */
  setLod(level: number): void;

  /** Returns the body to its rest pose — called on spawn. */
  resetPose(): void;

  dispose(): void;
}
