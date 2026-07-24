import * as THREE from 'three';
import { WEAPONS, type WeaponDef, type WeaponId } from './WeaponDefs';
import { createWeaponModel, disposeWeaponModel, type WeaponModel } from './WeaponModels';
import { audio } from '../audio/AudioManager';
import { clamp, clamp01, damp, lerp, randRange } from '../utilities/MathUtils';
import { Easing } from '../utilities/Easing';

/** Upgrade-derived multipliers supplied by the player's stat block. */
export interface WeaponModifiers {
  damage: number;
  fireRate: number;
  reloadSpeed: number;
  magazineSize: number;
}

export const NEUTRAL_MODIFIERS: WeaponModifiers = {
  damage: 1,
  fireRate: 1,
  reloadSpeed: 1,
  magazineSize: 1,
};

export interface ShotRequest {
  pellets: number;
  /** Total cone half-angle in degrees for this shot. */
  spreadDegrees: number;
  damagePerPellet: number;
  penetration: number;
}

type ReloadStage = 'idle' | 'dropping' | 'inserting' | 'racking' | 'shell';

/**
 * Runtime state and animation for a single weapon.
 *
 * Owns its own viewmodel and drives all of the mechanical animation — slide
 * cycling, magazine drops, pump strokes, bolt throws — from timers rather than
 * keyframed clips, which keeps the whole thing data-driven and lets upgrades
 * genuinely speed up reloads.
 */
export class Weapon {
  readonly def: WeaponDef;
  readonly model: WeaponModel;

  ammoInMagazine: number;
  reserveAmmo: number;

  private cooldown = 0;
  private bloom = 0;
  /** Blocks auto-fire from a held trigger on semi/pump/bolt weapons. */
  private triggerLatched = false;

  // Reload state
  private reloadStage: ReloadStage = 'idle';
  private reloadTimer = 0;
  private reloadDuration = 0;
  private shellsQueued = 0;

  // Animation state
  private slideRecoil = 0;
  private actionCycle = 0;
  private actionTarget = 0;
  private magDrop = 0;
  private inspectTimer = 0;
  private equipTimer = 0;

  /** Viewmodel offsets, applied on top of the resting transform. */
  readonly kickPosition = new THREE.Vector3();
  readonly kickRotation = new THREE.Euler();
  private kickVelocity = new THREE.Vector3();

  private modifiers: WeaponModifiers = NEUTRAL_MODIFIERS;

  constructor(id: WeaponId, modifiers: WeaponModifiers = NEUTRAL_MODIFIERS) {
    this.def = WEAPONS[id];
    this.model = createWeaponModel(id);
    this.modifiers = modifiers;
    this.ammoInMagazine = this.magazineCapacity;
    this.reserveAmmo = this.def.reserveAmmo;
  }

  setModifiers(modifiers: WeaponModifiers): void {
    const previousCapacity = this.magazineCapacity;
    this.modifiers = modifiers;
    // Growing the magazine tops it up immediately, which feels like a reward.
    if (this.magazineCapacity > previousCapacity && this.reloadStage === 'idle') {
      const gain = Math.min(this.magazineCapacity - this.ammoInMagazine, this.reserveAmmo);
      this.ammoInMagazine += gain;
      this.reserveAmmo -= gain;
    }
  }

  get magazineCapacity(): number {
    return Math.max(1, Math.round(this.def.magazineSize * this.modifiers.magazineSize));
  }

  get maxReserve(): number {
    return Math.round(this.def.maxReserveAmmo * this.modifiers.magazineSize);
  }

  get fireInterval(): number {
    return this.def.fireInterval / this.modifiers.fireRate;
  }

  get isReloading(): boolean {
    return this.reloadStage !== 'idle';
  }

  get isEmpty(): boolean {
    return this.ammoInMagazine <= 0;
  }

  get totalAmmo(): number {
    return this.ammoInMagazine + this.reserveAmmo;
  }

  /** 0..1 progress through the current reload, for the HUD ring. */
  get reloadProgress(): number {
    if (this.reloadStage === 'idle' || this.reloadDuration <= 0) return 0;
    return clamp01(1 - this.reloadTimer / this.reloadDuration);
  }

  /** Current accuracy cone in degrees, including movement and bloom. */
  currentSpread(movementFactor: number, adsFactor: number): number {
    const base = this.def.spread + this.def.moveSpread * movementFactor + this.bloom;
    const adsScale = lerp(1, this.def.adsSpreadScale, adsFactor);
    return base * adsScale;
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  releaseTrigger(): void {
    this.triggerLatched = false;
  }

  /**
   * Attempts to fire. Returns the shot description when a round leaves the
   * barrel, otherwise null (cooling down, reloading, or empty).
   */
  tryFire(triggerHeld: boolean, movementFactor: number, adsFactor: number): ShotRequest | null {
    if (!triggerHeld) {
      this.triggerLatched = false;
      return null;
    }
    if (this.cooldown > 0 || this.isReloading || this.equipTimer > 0) return null;

    // Non-automatic weapons require the trigger to be released between shots.
    if (this.def.fireMode !== 'auto') {
      if (this.triggerLatched) return null;
      this.triggerLatched = true;
    }

    if (this.ammoInMagazine <= 0) {
      audio.sfx.dryFire();
      this.cooldown = 0.28;
      return null;
    }

    this.ammoInMagazine--;
    this.cooldown = this.fireInterval;
    this.inspectTimer = 0;

    // Recoil, bloom and animation.
    this.bloom = Math.min(this.def.maxBloom, this.bloom + this.def.bloomPerShot);
    this.slideRecoil = 1;
    this.applyViewKick();

    audio.sfx.gunshot(this.def.sound);

    // Manual actions cycle after the shot, gating the next one.
    if (this.def.fireMode === 'pump' || this.def.fireMode === 'bolt') {
      this.actionTarget = 1;
      window.setTimeout(() => {
        this.actionTarget = 0;
        audio.sfx.reloadClick('rack');
      }, this.fireInterval * 400);
    }

    if (this.def.fireMode !== 'pump') audio.sfx.shellDrop(0.12);

    return {
      pellets: this.def.pellets,
      spreadDegrees: this.currentSpread(movementFactor, adsFactor),
      damagePerPellet: this.def.damage * this.modifiers.damage,
      penetration: this.def.penetration,
    };
  }

  /** Randomised impulse into the viewmodel spring. */
  private applyViewKick(): void {
    const recoil = this.def.recoil;
    this.kickVelocity.z += recoil.punch * 42;
    this.kickVelocity.y += recoil.punch * randRange(4, 11);
    this.kickVelocity.x += recoil.punch * randRange(-8, 8);
    this.kickRotation.x -= recoil.vertical * 0.011;
    this.kickRotation.z += randRange(-1, 1) * recoil.horizontal * 0.014;
  }

  // -------------------------------------------------------------------------
  // Reloading
  // -------------------------------------------------------------------------

  canReload(): boolean {
    return (
      !this.isReloading &&
      this.equipTimer <= 0 &&
      this.reserveAmmo > 0 &&
      this.ammoInMagazine < this.magazineCapacity
    );
  }

  startReload(): boolean {
    if (!this.canReload()) return false;

    if (this.def.reloadStyle === 'shells') {
      this.shellsQueued = Math.min(this.magazineCapacity - this.ammoInMagazine, this.reserveAmmo);
      this.beginShellCycle();
    } else {
      this.reloadStage = 'dropping';
      this.reloadDuration = this.def.reloadTime / this.modifiers.reloadSpeed;
      this.reloadTimer = this.reloadDuration;
      audio.sfx.reloadClick('release');
    }
    return true;
  }

  private beginShellCycle(): void {
    if (this.shellsQueued <= 0) {
      // Finish with a pump to chamber the first round.
      this.reloadStage = 'racking';
      this.reloadDuration = 0.32 / this.modifiers.reloadSpeed;
      this.reloadTimer = this.reloadDuration;
      this.actionTarget = 1;
      audio.sfx.reloadClick('rack');
      return;
    }
    this.reloadStage = 'shell';
    this.reloadDuration = this.def.shellTime / this.modifiers.reloadSpeed;
    this.reloadTimer = this.reloadDuration;
    audio.sfx.reloadClick('insert');
  }

  /** Interrupts a shell-by-shell reload so the player can fire immediately. */
  cancelReload(): void {
    if (this.reloadStage === 'shell') {
      this.shellsQueued = 0;
      this.reloadStage = 'racking';
      this.reloadDuration = 0.28 / this.modifiers.reloadSpeed;
      this.reloadTimer = this.reloadDuration;
      this.actionTarget = 1;
    }
  }

  private advanceReload(dt: number): void {
    if (this.reloadStage === 'idle') return;
    this.reloadTimer -= dt;
    if (this.reloadTimer > 0) return;

    switch (this.reloadStage) {
      case 'dropping': {
        // Mag out — now seat the fresh one.
        this.reloadStage = 'inserting';
        this.reloadDuration = (this.def.reloadTime * 0.45) / this.modifiers.reloadSpeed;
        this.reloadTimer = this.reloadDuration;
        audio.sfx.reloadClick('insert');
        break;
      }
      case 'inserting': {
        const needed = this.magazineCapacity - this.ammoInMagazine;
        const transferred = Math.min(needed, this.reserveAmmo);
        this.ammoInMagazine += transferred;
        this.reserveAmmo -= transferred;

        this.reloadStage = 'racking';
        this.reloadDuration = (this.def.reloadTime * 0.28) / this.modifiers.reloadSpeed;
        this.reloadTimer = this.reloadDuration;
        this.slideRecoil = 1;
        audio.sfx.reloadClick('rack');
        break;
      }
      case 'shell': {
        this.ammoInMagazine++;
        this.reserveAmmo--;
        this.shellsQueued--;
        this.actionCycle = 0.35;
        this.beginShellCycle();
        break;
      }
      case 'racking': {
        this.reloadStage = 'idle';
        this.actionTarget = 0;
        this.reloadTimer = 0;
        this.reloadDuration = 0;
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle + animation
  // -------------------------------------------------------------------------

  /** Called when this weapon becomes the active one. */
  onEquip(): void {
    this.equipTimer = 0.42;
    this.triggerLatched = true;
    this.reloadStage = 'idle';
    this.shellsQueued = 0;
    audio.sfx.weaponSwitch();
  }

  onHolster(): void {
    this.reloadStage = 'idle';
    this.shellsQueued = 0;
    this.actionTarget = 0;
  }

  /** Plays the idle inspect flourish. */
  inspect(): void {
    if (this.isReloading || this.inspectTimer > 0) return;
    this.inspectTimer = 1.5;
    audio.sfx.reloadClick('release', 0.1);
    audio.sfx.reloadClick('rack', 0.75);
  }

  refillAmmo(fraction = 1): void {
    const target = Math.round(this.maxReserve * fraction);
    this.reserveAmmo = Math.min(this.maxReserve, this.reserveAmmo + target);
    if (this.ammoInMagazine < this.magazineCapacity && !this.isReloading) {
      const gain = Math.min(this.magazineCapacity - this.ammoInMagazine, this.reserveAmmo);
      this.ammoInMagazine += gain;
      this.reserveAmmo -= gain;
    }
  }

  update(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.equipTimer = Math.max(0, this.equipTimer - dt);
    this.inspectTimer = Math.max(0, this.inspectTimer - dt);
    // Accuracy recovers steadily once the trigger stops moving.
    this.bloom = Math.max(0, this.bloom - dt * (this.def.maxBloom > 0 ? this.def.maxBloom * 1.5 : 0));

    this.advanceReload(dt);
    this.updateSprings(dt);
    this.updateModel(dt);
  }

  /** Critically damped spring returning the viewmodel to rest. */
  private updateSprings(dt: number): void {
    const stiffness = 210;
    const damping = 22;

    this.kickVelocity.x += -this.kickPosition.x * stiffness * dt;
    this.kickVelocity.y += -this.kickPosition.y * stiffness * dt;
    this.kickVelocity.z += -this.kickPosition.z * stiffness * dt;
    this.kickVelocity.multiplyScalar(Math.max(0, 1 - damping * dt));

    this.kickPosition.x += this.kickVelocity.x * dt;
    this.kickPosition.y += this.kickVelocity.y * dt;
    this.kickPosition.z += this.kickVelocity.z * dt;

    const recovery = this.def.recoil.recovery;
    this.kickRotation.x = damp(this.kickRotation.x, 0, recovery, dt);
    this.kickRotation.y = damp(this.kickRotation.y, 0, recovery, dt);
    this.kickRotation.z = damp(this.kickRotation.z, 0, recovery, dt);
  }

  private updateModel(dt: number): void {
    const { model } = this;

    // Slide / bolt carrier snaps back then eases home.
    this.slideRecoil = Math.max(0, this.slideRecoil - dt * 9);
    if (model.slide) {
      const travel = Easing.expoOut(this.slideRecoil) * 0.055;
      model.slide.position.z = travel;
    }

    // Pump / bolt handle stroke.
    this.actionCycle = damp(this.actionCycle, this.actionTarget, 16, dt);
    if (model.action) {
      if (this.def.fireMode === 'bolt') {
        // Bolt rotates up then draws back.
        model.action.rotation.z = this.actionCycle * -1.1;
        model.action.position.z = this.actionCycle * 0.085;
      } else {
        model.action.position.z = this.actionCycle * 0.11;
      }
    }

    // Magazine drops away and swings back in.
    const wantDrop = this.reloadStage === 'dropping' ? 1 : 0;
    this.magDrop = damp(this.magDrop, wantDrop, this.reloadStage === 'inserting' ? 9 : 16, dt);
    if (model.magazine) {
      model.magazine.position.y = -this.magDrop * 0.34;
      model.magazine.rotation.x = this.magDrop * 0.5;
      (model.magazine as THREE.Object3D).visible = this.magDrop < 0.94;
    }

    // Whole-weapon reload flourish: tilt in toward the camera.
    if (this.isReloading) {
      const t = this.reloadProgress;
      const swing = Math.sin(t * Math.PI);
      model.root.rotation.z = lerp(model.root.rotation.z, swing * 0.42, 1 - Math.exp(-14 * dt));
      model.root.rotation.x = lerp(model.root.rotation.x, swing * 0.2, 1 - Math.exp(-14 * dt));
      model.root.position.y = lerp(model.root.position.y, -swing * 0.06, 1 - Math.exp(-14 * dt));
    } else if (this.inspectTimer > 0) {
      // Inspect: rotate the weapon to show it off, then return.
      const t = 1 - this.inspectTimer / 1.5;
      const curve = Math.sin(t * Math.PI);
      model.root.rotation.y = curve * 1.5;
      model.root.rotation.z = curve * 0.42;
      model.root.position.y = curve * 0.045;
      model.root.position.z = curve * 0.06;
    } else if (this.equipTimer > 0) {
      // Equip: swing up from below.
      const t = 1 - this.equipTimer / 0.42;
      const eased = Easing.backOut(clamp01(t));
      model.root.position.y = lerp(-0.34, 0, eased);
      model.root.rotation.x = lerp(0.7, 0, eased);
      model.root.rotation.y = 0;
      model.root.rotation.z = 0;
    } else {
      const k = 1 - Math.exp(-16 * dt);
      model.root.rotation.z = lerp(model.root.rotation.z, 0, k);
      model.root.rotation.x = lerp(model.root.rotation.x, 0, k);
      model.root.rotation.y = lerp(model.root.rotation.y, 0, k);
      model.root.position.y = lerp(model.root.position.y, 0, k);
      model.root.position.z = lerp(model.root.position.z, 0, k);
    }
  }

  /** Hides the scope body while aiming so the overlay isn't obstructed. */
  setScopedView(scoped: boolean): void {
    if (this.model.scope) this.model.scope.visible = !scoped;
  }

  /** Damage scaling with distance. */
  damageAtRange(baseDamage: number, distance: number): number {
    const { falloffStart, falloffEnd, minDamageScale } = this.def;
    if (distance <= falloffStart) return baseDamage;
    const t = clamp01((distance - falloffStart) / Math.max(0.001, falloffEnd - falloffStart));
    return baseDamage * lerp(1, minDamageScale, t);
  }

  dispose(): void {
    disposeWeaponModel(this.model);
  }
}

/** Clamps a reserve value into the weapon's legal range. */
export function clampReserve(weapon: Weapon, value: number): number {
  return clamp(value, 0, weapon.maxReserve);
}
