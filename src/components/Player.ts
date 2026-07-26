import * as THREE from 'three';
import { PLAYER, WORLD } from '../game/Config';
import type { PlayerStats } from '../game/PlayerStats';
import type { InputSystem } from '../systems/InputSystem';
import type { CollisionWorld } from '../systems/CollisionWorld';
import { audio } from '../audio/AudioManager';
import { clamp, clamp01, damp, lerp, TAU } from '../utilities/MathUtils';
import { settings } from '../game/Settings';

export interface DamageEvent {
  amount: number;
  /** World position the damage came from, used for the directional indicator. */
  source: THREE.Vector3 | null;
  killed: boolean;
}

/**
 * First-person player controller.
 *
 * Movement uses an accelerate/friction model rather than direct velocity
 * assignment, which is what gives the character weight — you ramp up to speed,
 * you slide slightly when you stop, and air control is deliberately limited.
 */
export class Player {
  readonly camera: THREE.PerspectiveCamera;
  readonly position = new THREE.Vector3(0, 0, 0);
  readonly velocity = new THREE.Vector3();

  yaw = 0;
  pitch = 0;

  health: number = PLAYER.baseHealth;
  armor: number = 0;
  stamina: number = PLAYER.staminaMax;

  onGround = true;
  sprinting = false;
  crouching = false;
  dead = false;

  /** 0..1 how fast the player is moving relative to their max speed. */
  moveFactor = 0;
  /** Metres travelled this frame, drives footstep cadence. */
  distanceThisFrame = 0;

  private readonly stats: PlayerStats;

  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private timeSinceDamage = 999;
  private timeSinceSprint = 999;
  private hurtImmunity = 0;

  // Camera feel
  private bobPhase = 0;
  private bobAmount = 0;
  private landingDip = 0;
  private landingVelocity = 0;
  private currentEyeHeight: number = PLAYER.eyeHeight;
  private baseFov: number;
  private fovOffset = 0;
  private tiltRoll = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;

  // Screen shake, applied additively to the camera each frame.
  private shakeTrauma = 0;
  private shakeTime = 0;

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly wishDirection = new THREE.Vector3();
  private readonly previousPosition = new THREE.Vector3();

  onDamage: ((event: DamageEvent) => void) | null = null;
  onDeath: (() => void) | null = null;

  constructor(stats: PlayerStats, aspect: number) {
    this.stats = stats;
    this.baseFov = settings.current.fov;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.06, 400);
    this.camera.rotation.order = 'YXZ';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  spawn(position: THREE.Vector3, facing = 0): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = facing;
    this.pitch = 0;
    this.health = this.stats.maxHealth;
    this.armor = this.stats.maxArmor;
    this.stamina = PLAYER.staminaMax;
    this.dead = false;
    this.onGround = true;
    this.sprinting = false;
    this.crouching = false;
    this.landingDip = 0;
    this.shakeTrauma = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.timeSinceDamage = 999;
    this.currentEyeHeight = PLAYER.eyeHeight;
    this.updateCameraTransform(0);
  }

  get maxHealth(): number {
    return this.stats.maxHealth;
  }

  get maxArmor(): number {
    return this.stats.maxArmor;
  }

  get healthFraction(): number {
    return clamp01(this.health / this.maxHealth);
  }

  get eyePosition(): THREE.Vector3 {
    return this.camera.position;
  }

  // -------------------------------------------------------------------------
  // Combat interface
  // -------------------------------------------------------------------------

  /** Applies damage through armor first. Returns true if it actually landed. */
  takeDamage(amount: number, source: THREE.Vector3 | null = null): boolean {
    if (this.dead || this.hurtImmunity > 0 || amount <= 0) return false;

    this.hurtImmunity = PLAYER.hurtImmunity;
    this.timeSinceDamage = 0;

    let remaining = amount;
    if (this.armor > 0) {
      // Armor absorbs 70% of incoming damage until it's stripped.
      const absorbed = Math.min(this.armor, remaining * 0.7);
      this.armor -= absorbed;
      remaining -= absorbed;
    }

    this.health -= remaining;
    this.addShake(clamp01(amount / 45) * 0.7);
    audio.sfx.playerHurt();

    const killed = this.health <= 0;
    if (killed) {
      this.health = 0;
      this.dead = true;
    }

    this.onDamage?.({ amount, source, killed });
    if (killed) this.onDeath?.();
    return true;
  }

  heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  restoreArmor(): void {
    this.armor = this.maxArmor;
  }

  /** Camera kick applied by weapon fire. */
  applyRecoil(vertical: number, horizontal: number): void {
    this.recoilPitch += vertical * (Math.PI / 180);
    this.recoilYaw += horizontal * (Math.PI / 180);
  }

  addShake(amount: number): void {
    const scale = settings.current.screenShake;
    this.shakeTrauma = clamp01(this.shakeTrauma + amount * scale);
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(dt: number, input: InputSystem, collision: CollisionWorld, canAct: boolean): void {
    this.previousPosition.copy(this.position);
    this.hurtImmunity = Math.max(0, this.hurtImmunity - dt);
    this.timeSinceDamage += dt;

    if (this.dead) {
      this.updateDeathCamera(dt);
      return;
    }

    this.updateLook(input, canAct);
    this.updateMovement(dt, input, collision, canAct);
    this.updateStamina(dt);
    this.updateRegeneration(dt);
    this.updateCameraTransform(dt);

    this.distanceThisFrame = Math.hypot(
      this.position.x - this.previousPosition.x,
      this.position.z - this.previousPosition.z,
    );
  }

  private updateLook(input: InputSystem, canAct: boolean): void {
    if (!canAct) return;
    this.yaw -= input.lookDeltaX;
    this.pitch -= input.lookDeltaY;
    // Clamp just short of straight up/down to avoid gimbal weirdness.
    this.pitch = clamp(this.pitch, -Math.PI * 0.495, Math.PI * 0.495);
    this.yaw = ((this.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
  }

  private updateMovement(dt: number, input: InputSystem, collision: CollisionWorld, canAct: boolean): void {
    const move = canAct ? input.getMoveVector() : { x: 0, y: 0 };

    // Sprint requires forward input and stamina; crouching cancels it.
    this.crouching = canAct && input.isHeld('crouch') && this.onGround;
    const wantsSprint = canAct && input.isHeld('sprint') && move.y > 0.1 && !this.crouching;
    this.sprinting = wantsSprint && this.stamina > 1;

    // Direction vectors on the horizontal plane.
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    this.wishDirection
      .set(0, 0, 0)
      .addScaledVector(this.forward, move.y)
      .addScaledVector(this.right, move.x);
    if (this.wishDirection.lengthSq() > 1e-6) this.wishDirection.normalize();

    let targetSpeed = PLAYER.walkSpeed * this.stats.moveSpeedMultiplier;
    if (this.sprinting) targetSpeed *= PLAYER.sprintMultiplier;
    else if (this.crouching) targetSpeed *= PLAYER.crouchMultiplier;
    const wishSpeed = this.wishDirection.lengthSq() > 0 ? targetSpeed : 0;

    // --- Horizontal acceleration ------------------------------------------
    const accel = this.onGround ? PLAYER.groundAccel : PLAYER.airAccel;
    const control = this.onGround ? 1 : PLAYER.airControl;

    const currentSpeedAlongWish =
      this.velocity.x * this.wishDirection.x + this.velocity.z * this.wishDirection.z;
    const addSpeed = wishSpeed - currentSpeedAlongWish;
    if (addSpeed > 0) {
      const accelSpeed = Math.min(addSpeed, accel * dt * wishSpeed * control * 0.2 + accel * dt * control * 0.4);
      this.velocity.x += this.wishDirection.x * accelSpeed;
      this.velocity.z += this.wishDirection.z * accelSpeed;
    }

    // --- Friction ----------------------------------------------------------
    if (this.onGround) {
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      if (speed > 0.001) {
        // Below a floor speed, friction is constant so stops feel crisp.
        const drop = Math.max(speed, 3.2) * PLAYER.groundFriction * dt;
        const scale = Math.max(0, speed - drop) / speed;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
    }

    // --- Jump --------------------------------------------------------------
    if (canAct && input.wasPressed('jump')) this.jumpBufferTimer = PLAYER.jumpBufferTime;
    this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    this.coyoteTimer = this.onGround ? PLAYER.coyoteTime : Math.max(0, this.coyoteTimer - dt);

    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0) {
      this.velocity.y = PLAYER.jumpVelocity;
      this.onGround = false;
      this.jumpBufferTimer = 0;
      this.coyoteTimer = 0;
      audio.sfx.jump();
    }

    // --- Gravity + vertical integration ------------------------------------
    this.velocity.y += PLAYER.gravity * dt;
    // Terminal velocity keeps the landing impulse bounded.
    this.velocity.y = Math.max(this.velocity.y, -42);

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;

    // --- Ground contact ----------------------------------------------------
    const wasAirborne = !this.onGround;
    if (this.position.y <= WORLD.groundY) {
      this.position.y = WORLD.groundY;
      if (wasAirborne) {
        const impact = clamp01(-this.velocity.y / 18);
        if (impact > 0.05) {
          this.landingVelocity = impact * PLAYER.landingDipMax * 14;
          audio.sfx.land(0.4 + impact);
          this.addShake(impact * 0.35);
          // Hard landings cost a little health, which discourages ledge diving.
          if (-this.velocity.y > 24) this.takeDamage((-this.velocity.y - 24) * 2.4);
        }
      }
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // --- Collision ---------------------------------------------------------
    const bodyHeight = this.crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
    collision.resolveCircle(this.position, PLAYER.radius, this.position.y, bodyHeight);

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.moveFactor = clamp01(horizontalSpeed / (PLAYER.walkSpeed * this.stats.moveSpeedMultiplier));
  }

  private updateStamina(dt: number): void {
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - PLAYER.staminaDrain * dt);
      this.timeSinceSprint = 0;
    } else {
      this.timeSinceSprint += dt;
      if (this.timeSinceSprint > PLAYER.staminaRegenDelay) {
        this.stamina = Math.min(PLAYER.staminaMax, this.stamina + PLAYER.staminaRegen * dt);
      }
    }
  }

  private updateRegeneration(dt: number): void {
    if (this.timeSinceDamage < PLAYER.healthRegenDelay) return;
    // Regen only refills the current segment, so big hits still hurt long-term.
    const cap = this.maxHealth;
    if (this.health < cap) {
      this.health = Math.min(cap, this.health + PLAYER.healthRegenRate * dt);
    }
  }

  /**
   * Composes the final camera transform from: eye height, view bob, landing
   * dip, strafe tilt, recoil and screen shake.
   */
  private updateCameraTransform(dt: number): void {
    // Crouch / stand eye height.
    const targetEye = this.crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
    this.currentEyeHeight = damp(this.currentEyeHeight, targetEye, 12, dt);

    // Landing dip: a spring that compresses on impact and pushes back up.
    this.landingVelocity -= this.landingDip * 90 * dt;
    this.landingVelocity *= Math.max(0, 1 - 12 * dt);
    this.landingDip += this.landingVelocity * dt;
    this.landingDip = clamp(this.landingDip, -0.02, PLAYER.landingDipMax);

    // View bob, scaled by movement and disabled in the air.
    const targetBob = this.onGround ? this.moveFactor : 0;
    this.bobAmount = damp(this.bobAmount, targetBob, 8, dt);
    const bobSpeed = PLAYER.bobFrequency * (this.sprinting ? 1.35 : 1);
    this.bobPhase += dt * bobSpeed * this.bobAmount;

    const reduced = settings.current.reducedMotion ? 0.35 : 1;
    const bobVertical = Math.sin(this.bobPhase * 2) * PLAYER.bobAmplitude * this.bobAmount * reduced;
    const bobHorizontal = Math.cos(this.bobPhase) * PLAYER.bobAmplitude * 0.7 * this.bobAmount * reduced;

    // Strafe tilt: leaning into lateral movement.
    const strafe = this.velocity.x * this.right.x + this.velocity.z * this.right.z;
    const targetRoll = clamp(-strafe * 0.0085, -0.045, 0.045) * reduced;
    this.tiltRoll = damp(this.tiltRoll, targetRoll, 7, dt);

    // Recoil decays back to centre.
    this.recoilPitch = damp(this.recoilPitch, 0, 9, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 9, dt);

    // Screen shake: two out-of-phase noise curves, trauma-squared for punch.
    this.shakeTime += dt;
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 1.9);
    const shake = this.shakeTrauma * this.shakeTrauma * reduced;
    const shakeX = Math.sin(this.shakeTime * 47.3) * shake * 0.045;
    const shakeY = Math.sin(this.shakeTime * 39.1 + 1.7) * shake * 0.045;
    const shakeRoll = Math.sin(this.shakeTime * 31.7 + 0.6) * shake * 0.05;

    this.camera.position.set(
      this.position.x + bobHorizontal,
      this.position.y + this.currentEyeHeight - this.landingDip + bobVertical,
      this.position.z,
    );

    this.camera.rotation.set(
      this.pitch + this.recoilPitch + shakeY,
      this.yaw + this.recoilYaw + shakeX,
      this.tiltRoll + shakeRoll,
    );

    // FOV: sprint kick, driven by actual speed rather than the sprint flag so
    // it ramps in and out smoothly.
    const sprintKick = this.sprinting ? PLAYER.fovSprintKick * this.moveFactor : 0;
    this.fovOffset = damp(this.fovOffset, sprintKick, 6, dt);
  }

  /** Slow-motion camera fall on death. */
  private updateDeathCamera(dt: number): void {
    this.velocity.y += PLAYER.gravity * 0.35 * dt;
    this.position.y = Math.max(0.25, this.position.y + this.velocity.y * dt * 0.5);
    this.currentEyeHeight = damp(this.currentEyeHeight, 0.32, 2.2, dt);
    this.pitch = damp(this.pitch, -0.42, 1.4, dt);
    this.tiltRoll = damp(this.tiltRoll, 0.75, 1.2, dt);
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt);

    this.camera.position.set(this.position.x, this.position.y + this.currentEyeHeight, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, this.tiltRoll);
  }

  /**
   * Applies the final FOV, combining the base setting, sprint kick and the
   * weapon's aim zoom.
   */
  applyFov(weaponFovDelta: number, dt: number): void {
    this.baseFov = settings.current.fov;
    const target = this.baseFov + this.fovOffset + weaponFovDelta;
    this.camera.fov = damp(this.camera.fov, target, 12, dt);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Updates the camera aspect ratio.
   *
   * Guards against a degenerate value: a zero-height window (minimised, or an
   * embed that hasn't been laid out yet) yields 0 or NaN, which silently
   * corrupts the projection matrix and every FOV-derived calculation that
   * reads back from it.
   */
  setAspect(aspect: number): void {
    this.camera.aspect = Number.isFinite(aspect) && aspect > 0.01 ? aspect : 16 / 9;
    this.camera.updateProjectionMatrix();
  }

  /** Ground material under the player, used to pick footstep sounds. */
  surfaceUnderfoot(): 'grass' | 'stone' {
    return Math.hypot(this.position.x, this.position.z) < 19.5 ? 'stone' : 'grass';
  }

  /** Normalised look direction, allocation-free. */
  getLookDirection(out: THREE.Vector3): THREE.Vector3 {
    return this.camera.getWorldDirection(out);
  }

  /** How much motion blur the current camera state warrants, 0..1. */
  motionBlurAmount(lookDeltaX: number, lookDeltaY: number, dt: number): number {
    const angular = Math.hypot(lookDeltaX, lookDeltaY) / Math.max(dt, 0.001);
    const fromLook = clamp01((angular - 1.1) / 7);
    const fromSprint = this.sprinting ? this.moveFactor * 0.42 : 0;
    return clamp01(Math.max(fromLook, fromSprint));
  }

  /** Centre of mass, used by zombies as their attack target. */
  getBodyCenter(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + 0.9, this.position.z);
  }

  get staminaFraction(): number {
    return clamp01(this.stamina / PLAYER.staminaMax);
  }

  /** Blend factor for the low-health post effect. */
  get distressAmount(): number {
    return clamp01(lerp(0, 1, 1 - this.healthFraction / 0.4));
  }
}
