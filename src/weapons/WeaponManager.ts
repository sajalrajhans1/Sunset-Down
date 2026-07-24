import * as THREE from 'three';
import { Weapon, type WeaponModifiers } from './Weapon';
import { WEAPON_ORDER, type WeaponId } from './WeaponDefs';
import { audio } from '../audio/AudioManager';
import { clamp01, damp, lerp, randRange, TAU } from '../utilities/MathUtils';
import type { CollisionWorld } from '../systems/CollisionWorld';

/**
 * Owns the player's arsenal and the first-person viewmodel rig.
 *
 * The rig is a chain of nested groups so each motion source stays independent
 * and readable:
 *
 *   camera
 *     └ rigRoot      — wall avoidance + sprint lowering
 *        └ swayNode  — mouse-look lag
 *           └ bobNode — footstep bob
 *              └ adsNode — hip ⇄ aim blend
 *                 └ weapon.model.root — recoil + reload animation
 */
export class WeaponManager {
  readonly rigRoot = new THREE.Group();

  private readonly swayNode = new THREE.Group();
  private readonly bobNode = new THREE.Group();
  private readonly adsNode = new THREE.Group();

  private readonly owned = new Map<WeaponId, Weapon>();
  private order: WeaponId[] = [];
  private activeIndex = 0;
  private active: Weapon | null = null;

  /** Switching plays a holster-then-draw, so there's a brief empty moment. */
  private switchTimer = 0;
  private pendingSwitch: WeaponId | null = null;

  // Aim-down-sights blend, 0 = hip, 1 = aimed.
  private adsAmount = 0;
  private adsTarget = 0;

  // Sway / bob state.
  private swayOffset = new THREE.Vector2();
  private swayTarget = new THREE.Vector2();
  private bobPhase = 0;
  private bobIntensity = 0;
  private lowerAmount = 0;

  // Muzzle flash.
  private readonly flashMesh: THREE.Mesh;
  private readonly flashMaterial: THREE.ShaderMaterial;
  private readonly flashLight: THREE.PointLight;
  private flashTimer = 0;
  private flashDuration = 0.055;

  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _rayDir = new THREE.Vector3();

  constructor() {
    this.rigRoot.name = 'ViewmodelRig';
    this.rigRoot.add(this.swayNode);
    this.swayNode.add(this.bobNode);
    this.bobNode.add(this.adsNode);

    // Muzzle flash lives on the rig and is re-parented to the active muzzle.
    //
    // Drawn analytically rather than from a texture. A textured quad with
    // premultiplication or edge-bleed problems can end up *darkening* the
    // frame — a black square at the barrel. This shader only ever emits light:
    // it outputs premultiplied colour with additive blending, so the worst
    // possible failure is an invisible flash, never a dark box.
    this.flashMaterial = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: false,
      fog: false,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color(0xffc978) },
        uIntensity: { value: 0 },
        uSeed: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uSeed;
        varying vec2 vUv;

        void main() {
          vec2 p = vUv - 0.5;
          float r = length( p ) * 2.0;
          float angle = atan( p.y, p.x );

          // Irregular star: a few sharp spikes plus a softer secondary set,
          // rotated per shot so no two flashes look identical.
          float spikes = pow( abs( cos( angle * 3.0 + uSeed ) ), 8.0 ) * 0.5
                       + pow( abs( cos( angle * 5.0 - uSeed * 1.7 ) ), 12.0 ) * 0.28;
          float arms = smoothstep( 0.35 + spikes, 0.0, r );
          float core = smoothstep( 0.62, 0.0, r );

          float intensity = ( core * core * 1.6 + arms * 0.7 ) * uIntensity;
          if ( intensity < 0.002 ) discard;

          // Hot white centre falling off to the warm muzzle colour.
          vec3 color = mix( uColor, vec3( 1.0 ), core * core * 0.75 );
          gl_FragColor = vec4( color * intensity, intensity );
        }
      `,
    });

    this.flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.flashMaterial);
    this.flashMesh.scale.setScalar(0.5);
    this.flashMesh.renderOrder = 20;
    this.flashMesh.frustumCulled = false;
    this.flashMesh.visible = false;

    this.flashLight = new THREE.PointLight(0xffc070, 0, 14, 2);
    this.flashLight.castShadow = false;
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  /**
   * Returns the arsenal to its starting state.
   *
   * The pistol instance is deliberately *kept* rather than rebuilt: its model
   * geometry and shader programs are already resident on the GPU, so reusing
   * it makes starting a new run instant instead of re-uploading everything.
   * Only purchased weapons are torn down.
   */
  reset(modifiers: WeaponModifiers): void {
    for (const [id, weapon] of [...this.owned]) {
      if (id === 'pistol') continue;
      this.adsNode.remove(weapon.model.root);
      weapon.dispose();
      this.owned.delete(id);
    }

    this.order = WEAPON_ORDER.filter((w) => this.owned.has(w));
    this.activeIndex = 0;
    this.active = null;
    this.adsAmount = 0;
    this.adsTarget = 0;
    this.switchTimer = 0;
    this.pendingSwitch = null;

    if (!this.owned.has('pistol')) {
      this.grant('pistol', modifiers);
    } else {
      // Restore the surviving pistol to a fresh, fully-loaded state.
      const pistol = this.owned.get('pistol')!;
      pistol.setModifiers(modifiers);
      pistol.reserveAmmo = pistol.def.reserveAmmo;
      pistol.ammoInMagazine = pistol.magazineCapacity;
      pistol.model.root.visible = false;
    }

    this.equipIndex(0, true);
  }

  /**
   * Builds the starting weapon during the loading screen so its geometry and
   * shaders are ready before the player ever presses Play.
   */
  prewarm(modifiers: WeaponModifiers): void {
    if (!this.owned.has('pistol')) this.grant('pistol', modifiers);
    this.equipIndex(0, true);
  }

  has(id: WeaponId): boolean {
    return this.owned.has(id);
  }

  /** Adds a weapon to the arsenal. Returns false if already owned. */
  grant(id: WeaponId, modifiers: WeaponModifiers): boolean {
    if (this.owned.has(id)) return false;
    const weapon = new Weapon(id, modifiers);
    weapon.model.root.visible = false;
    this.adsNode.add(weapon.model.root);
    this.owned.set(id, weapon);
    // Keep inventory in the canonical order regardless of purchase order.
    this.order = WEAPON_ORDER.filter((w) => this.owned.has(w));
    return true;
  }

  get activeWeapon(): Weapon | null {
    return this.active;
  }

  get inventory(): Weapon[] {
    return this.order.map((id) => this.owned.get(id)!).filter(Boolean);
  }

  get(id: WeaponId): Weapon | undefined {
    return this.owned.get(id);
  }

  setModifiers(modifiers: WeaponModifiers): void {
    for (const weapon of this.owned.values()) weapon.setModifiers(modifiers);
  }

  refillAll(fraction = 1): void {
    for (const weapon of this.owned.values()) weapon.refillAmmo(fraction);
  }

  // -------------------------------------------------------------------------
  // Switching
  // -------------------------------------------------------------------------

  /** Equips by inventory slot (0-based). Ignored if the slot is empty. */
  equipIndex(index: number, immediate = false): void {
    if (index < 0 || index >= this.order.length) return;
    const id = this.order[index];
    if (this.active?.def.id === id && !immediate) return;

    if (immediate) {
      this.applySwitch(id);
      this.activeIndex = index;
      return;
    }

    if (this.switchTimer > 0) return;
    this.activeIndex = index;
    this.pendingSwitch = id;
    this.switchTimer = 0.18;
    this.active?.onHolster();
    this.adsTarget = 0;
  }

  equipWeapon(id: WeaponId): void {
    const index = this.order.indexOf(id);
    if (index >= 0) this.equipIndex(index);
  }

  cycle(direction: number): void {
    if (this.order.length <= 1) return;
    const next = (this.activeIndex + direction + this.order.length) % this.order.length;
    this.equipIndex(next);
  }

  private applySwitch(id: WeaponId): void {
    if (this.active) {
      this.active.model.root.visible = false;
      this.active.setScopedView(false);
    }
    const weapon = this.owned.get(id);
    if (!weapon) return;
    this.active = weapon;
    weapon.model.root.visible = true;
    weapon.onEquip();

    // Re-parent the flash to the new muzzle.
    weapon.model.muzzle.add(this.flashMesh);
    weapon.model.muzzle.add(this.flashLight);
  }

  // -------------------------------------------------------------------------
  // Aiming
  // -------------------------------------------------------------------------

  setAiming(aiming: boolean): void {
    this.adsTarget = aiming && !this.active?.isReloading && this.switchTimer <= 0 ? 1 : 0;
  }

  get aimAmount(): number {
    return this.adsAmount;
  }

  /** Extra FOV to apply for the current aim state. */
  get fovDelta(): number {
    if (!this.active) return 0;
    return this.active.def.adsFovDelta * this.adsAmount;
  }

  get isScoped(): boolean {
    return !!this.active?.def.hasScope && this.adsAmount > 0.82;
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  /** Fires the muzzle flash. Called by the combat system on a successful shot. */
  triggerMuzzleFlash(intensity = 1): void {
    this.flashTimer = this.flashDuration;
    this.flashMesh.visible = true;
    // Random roll + shader seed so consecutive shots never repeat a shape.
    this.flashMesh.rotation.z = Math.random() * TAU;
    this.flashMesh.scale.setScalar(randRange(0.4, 0.62) * intensity);
    this.flashMaterial.uniforms.uSeed.value = Math.random() * TAU;
    this.flashMaterial.uniforms.uIntensity.value = 1;
    this.flashLight.intensity = 9 * intensity;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * @param lookDelta  mouse movement this frame, in radians
   * @param moveSpeed  0..1 normalised horizontal speed
   * @param sprinting  lowers the weapon and disables aiming
   */
  update(
    dt: number,
    lookDelta: { x: number; y: number },
    moveSpeed: number,
    sprinting: boolean,
    onGround: boolean,
    collision: CollisionWorld,
    cameraWorldPosition: THREE.Vector3,
    cameraWorldDirection: THREE.Vector3,
  ): void {
    // Deferred weapon swap at the midpoint of the holster animation.
    if (this.switchTimer > 0) {
      this.switchTimer -= dt;
      if (this.switchTimer <= 0 && this.pendingSwitch) {
        this.applySwitch(this.pendingSwitch);
        this.pendingSwitch = null;
      }
    }

    const weapon = this.active;
    if (!weapon) return;

    weapon.update(dt);

    // --- ADS blend ---------------------------------------------------------
    const wantAds = this.adsTarget > 0 && !sprinting && !weapon.isReloading;
    const adsSpeed = 1 / Math.max(0.05, weapon.def.adsTime);
    this.adsAmount = damp(this.adsAmount, wantAds ? 1 : 0, adsSpeed * 3, dt);
    weapon.setScopedView(this.isScoped);

    const rest = weapon.def.viewPosition;
    const aim = weapon.def.adsPosition;
    this.adsNode.position.set(
      lerp(rest[0], aim[0], this.adsAmount),
      lerp(rest[1], aim[1], this.adsAmount),
      lerp(rest[2], aim[2], this.adsAmount),
    );
    this.adsNode.rotation.set(
      weapon.def.viewRotation[0] * (1 - this.adsAmount),
      weapon.def.viewRotation[1] * (1 - this.adsAmount),
      weapon.def.viewRotation[2] * (1 - this.adsAmount),
    );

    // --- Sway: the weapon lags behind the camera --------------------------
    const swayScale = lerp(1, 0.24, this.adsAmount);
    this.swayTarget.x = THREE.MathUtils.clamp(-lookDelta.x * 2.6, -0.09, 0.09) * swayScale;
    this.swayTarget.y = THREE.MathUtils.clamp(lookDelta.y * 2.6, -0.09, 0.09) * swayScale;
    this.swayOffset.x = damp(this.swayOffset.x, this.swayTarget.x, 9, dt);
    this.swayOffset.y = damp(this.swayOffset.y, this.swayTarget.y, 9, dt);

    this.swayNode.position.set(this.swayOffset.x, this.swayOffset.y, 0);
    this.swayNode.rotation.set(this.swayOffset.y * 1.6, -this.swayOffset.x * 1.6, this.swayOffset.x * 1.1);

    // --- Bob: figure-of-eight tied to stride ------------------------------
    const targetBob = onGround ? moveSpeed : 0;
    this.bobIntensity = damp(this.bobIntensity, targetBob, 7, dt);
    this.bobPhase += dt * (sprinting ? 13.5 : 9.4) * this.bobIntensity;

    const bobScale = lerp(1, 0.28, this.adsAmount) * this.bobIntensity;
    this.bobNode.position.set(
      Math.cos(this.bobPhase) * 0.021 * bobScale,
      Math.sin(this.bobPhase * 2) * 0.015 * bobScale,
      0,
    );
    this.bobNode.rotation.set(
      Math.sin(this.bobPhase * 2) * 0.016 * bobScale,
      Math.cos(this.bobPhase) * 0.022 * bobScale,
      Math.cos(this.bobPhase) * 0.03 * bobScale,
    );

    // --- Sprint lowering + wall avoidance ---------------------------------
    // Cast forward from the camera; when a surface is close, tuck the weapon in
    // so the barrel never pokes through geometry.
    this._rayOrigin.copy(cameraWorldPosition);
    this._rayDir.copy(cameraWorldDirection).normalize();
    const hit = collision.raycast(this._rayOrigin, this._rayDir, 1.6);
    const wallProximity = hit ? clamp01(1 - hit.distance / 1.6) : 0;

    const sprintLower = sprinting && this.adsAmount < 0.1 ? 1 : 0;
    const targetLower = Math.max(sprintLower * 0.8, wallProximity);
    this.lowerAmount = damp(this.lowerAmount, targetLower, 11, dt);

    this.rigRoot.position.set(0, -this.lowerAmount * 0.16, this.lowerAmount * 0.22);
    this.rigRoot.rotation.set(this.lowerAmount * 0.62, this.lowerAmount * 0.36, -this.lowerAmount * 0.3);

    // Recoil kick from the weapon's own spring.
    weapon.model.root.position.x = weapon.kickPosition.x * 0.4;
    weapon.model.root.position.y += weapon.kickPosition.y * 0.4;
    weapon.model.root.position.z += weapon.kickPosition.z * 0.4;
    weapon.model.root.rotation.x += weapon.kickRotation.x;
    weapon.model.root.rotation.z += weapon.kickRotation.z;

    // --- Muzzle flash decay ------------------------------------------------
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const t = clamp01(this.flashTimer / this.flashDuration);
      this.flashMaterial.uniforms.uIntensity.value = t;
      this.flashLight.intensity = 9 * t;
      if (this.flashTimer <= 0) {
        this.flashMesh.visible = false;
        this.flashMaterial.uniforms.uIntensity.value = 0;
        this.flashLight.intensity = 0;
      }
    }
  }

  /** Convenience for HUD: reload the active weapon. */
  reloadActive(): void {
    if (!this.active) return;
    if (this.active.startReload()) return;
    if (this.active.reserveAmmo <= 0 && this.active.isEmpty) audio.sfx.denied();
  }

  dispose(): void {
    for (const weapon of this.owned.values()) weapon.dispose();
    this.owned.clear();
    this.flashMaterial.dispose();
    this.flashMesh.geometry.dispose();
    this.rigRoot.clear();
  }
}
