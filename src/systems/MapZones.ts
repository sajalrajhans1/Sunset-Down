import * as THREE from 'three';
import type { CollisionWorld, BoxCollider } from './CollisionWorld';
import type { WeaponId } from '../weapons/WeaponDefs';
import { WEAPONS } from '../weapons/WeaponDefs';
import { materials } from '../scenes/MaterialLibrary';
import { audio } from '../audio/AudioManager';
import { clamp01 } from '../utilities/MathUtils';

/**
 * The village as a place you learn, rather than scenery you run past.
 *
 * The player starts sealed inside the plaza. Three barricades ring it, each one
 * bought open with coins, and behind each is a district worth reaching: the
 * fairground, the market row and the gardens. Opening one is a real decision
 * rather than a menu click — it hands over more room to kite in and a weapon
 * mounted on the wall there, but it also wakes up that district's spawn points,
 * so every gate you open is another direction the dead can come from.
 *
 * That tension is the whole point. A player who buys nothing is safe but broke
 * and cornered; a player who opens everything has a shotgun and nowhere to hide.
 */

export type ZoneId = 'fairground' | 'market' | 'gardens';

/** Radius of the barricade ring. Clear of the plaza kerb and the cottages. */
export const WALL_RADIUS = 22.5;

/**
 * Wall weapons cost less than the same gun in the shop.
 *
 * The shop is safe — it opens between waves, from anywhere. A wall gun makes
 * you pay a gate to reach it and then walk back out to it every time you want
 * ammo, so the discount is what that risk buys. Without it there would be no
 * reason to ever leave the plaza.
 */
const WALL_BUY_DISCOUNT = 0.7;

/** Refilling from a wall you already own is a fraction of the gun's price. */
const WALL_REFILL_FRACTION = 0.18;

interface ZoneDefinition {
  id: ZoneId;
  name: string;
  /** Bearing of the gate opening, radians, in the (cos, sin) → (x, z) frame. */
  angle: number;
  /** Half-width of the opening, in radians. */
  gap: number;
  cost: number;
  /** Weapon sold on the wall inside this district. */
  wallBuy: WeaponId;
  /** Where that weapon hangs. */
  wallBuyPosition: THREE.Vector3;
  wallBuyFacing: number;
}

const ZONES: ZoneDefinition[] = [
  {
    id: 'market',
    name: 'Market Row',
    angle: 0,
    gap: 0.2,
    cost: 750,
    wallBuy: 'smg',
    wallBuyPosition: new THREE.Vector3(31.5, 1.7, 4),
    wallBuyFacing: Math.PI,
  },
  {
    id: 'fairground',
    name: 'The Fairground',
    angle: -Math.PI / 2,
    gap: 0.22,
    cost: 1250,
    wallBuy: 'shotgun',
    wallBuyPosition: new THREE.Vector3(-6, 1.7, -30),
    wallBuyFacing: 0,
  },
  {
    id: 'gardens',
    name: 'The Gardens',
    angle: Math.PI / 2,
    gap: 0.2,
    cost: 1750,
    wallBuy: 'rifle',
    wallBuyPosition: new THREE.Vector3(-6, 1.7, 29.5),
    wallBuyFacing: Math.PI,
  },
];

/** Anything the player can walk up to and buy. */
export interface Interactable {
  /** Where the prompt triggers from. */
  readonly position: THREE.Vector3;
  readonly range: number;
  /** Prompt copy, or null when it should not offer itself right now. */
  label(canAfford: boolean): string | null;
  cost(): number;
  /** Runs after the coins are taken. */
  purchase(): void;
}

interface Gate {
  def: ZoneDefinition;
  open: boolean;
  /** Barricade planks, animated aside when bought. */
  group: THREE.Group;
  colliders: BoxCollider[];
  /** 0 → shut, 1 → fully swung open. */
  progress: number;
}

interface WallBuy {
  def: ZoneDefinition;
  group: THREE.Group;
  bought: boolean;
  glow: THREE.Mesh;
}

export interface MapZoneCallbacks {
  /** Returns true if the coins were successfully taken. */
  spend: (amount: number) => boolean;
  /** Grants the weapon and equips it. Returns false if already owned. */
  grantWeapon: (id: WeaponId) => boolean;
  /** Tops up the current weapon when a wall-buy is already owned. */
  refillAmmo: () => void;
  ownsWeapon: (id: WeaponId) => boolean;
  /** Non-destructive wallet check, used to grey out prompts. */
  canAfford: (amount: number) => boolean;
  /** Rebuilds navigation after a barricade comes down. */
  onZoneOpened: (id: ZoneId, name: string) => void;
}

export class MapZones {
  readonly group = new THREE.Group();

  private readonly gates: Gate[] = [];
  private readonly wallBuys: WallBuy[] = [];
  private elapsed = 0;

  /** Set while the player is stood in front of something buyable. */
  private focus: { label: string; affordable: boolean; action: () => void } | null = null;

  constructor(private readonly callbacks: MapZoneCallbacks) {
    this.group.name = 'MapZones';
  }

  /** True once this district's barricade has been bought open. */
  isOpen(id: ZoneId): boolean {
    const gate = this.gates.find((g) => g.def.id === id);
    return gate ? gate.open : true;
  }

  get openZoneIds(): ZoneId[] {
    return this.gates.filter((gate) => gate.open).map((gate) => gate.def.id);
  }

  /**
   * Returns the bearing of every still-closed gate, so the wall ring can be
   * built with matching openings.
   */
  static get definitions(): readonly ZoneDefinition[] {
    return ZONES;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  build(collision: CollisionWorld): void {
    for (const def of ZONES) {
      this.gates.push(this.buildGate(def, collision));
      this.wallBuys.push(this.buildWallBuy(def));
    }
  }

  /**
   * A barricade of crossed planks filling the gap in the wall.
   *
   * Built as two halves so it can swing apart like a pair of doors, which reads
   * far better than a barricade that simply blinks out of existence.
   */
  private buildGate(def: ZoneDefinition, collision: CollisionWorld): Gate {
    const group = new THREE.Group();
    const width = WALL_RADIUS * def.gap * 2;
    const wood = materials.get('wood.warm');
    const trim = materials.get('wood.crate');

    const colliders: BoxCollider[] = [];

    for (const side of [-1, 1] as const) {
      const leaf = new THREE.Group();
      const halfWidth = width * 0.5;

      // Three horizontal planks with a diagonal brace: the classic shut-up-shop
      // look, and cheap — four boxes per leaf.
      for (let i = 0; i < 3; i++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(halfWidth, 0.55, 0.22), wood);
        plank.position.set(halfWidth * 0.5, 0.55 + i * 0.95, 0);
        plank.castShadow = true;
        plank.receiveShadow = true;
        leaf.add(plank);
      }

      const brace = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 1.15, 0.3, 0.16), trim);
      brace.position.set(halfWidth * 0.5, 1.5, 0.16);
      brace.rotation.z = side * 0.5;
      brace.castShadow = true;
      leaf.add(brace);

      // Hinge post.
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 3.3, 7), trim);
      post.position.set(0, 1.65, 0);
      post.castShadow = true;
      leaf.add(post);

      leaf.scale.x = side;
      leaf.position.x = side * halfWidth;
      group.add(leaf);
    }

    // Position and orient the whole gate on the wall ring.
    const x = Math.cos(def.angle) * WALL_RADIUS;
    const z = Math.sin(def.angle) * WALL_RADIUS;
    group.position.set(x, 0, z);
    // The leaves are long on local X, so the same tangent alignment the wall
    // ring uses applies here: a Y rotation of -a - PI/2 lays them across the
    // opening rather than pointing them out of it.
    group.rotation.y = -def.angle - Math.PI / 2;
    this.group.add(group);

    // One collider covering the whole opening, switched off when bought.
    colliders.push(
      collision.addBox({
        x,
        z,
        hx: width * 0.5,
        hz: 0.35,
        // Colliders use the opposite sign convention to Three's Y rotation.
        rotation: def.angle + Math.PI / 2,
        baseY: 0,
        height: 3.3,
        impactColor: 0xa9743f,
      }),
    );

    return { def, open: false, group, colliders, progress: 0 };
  }

  /** A weapon hung on a board, with a coin-coloured glow so it reads at range. */
  private buildWallBuy(def: ZoneDefinition): WallBuy {
    const group = new THREE.Group();

    const board = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 1.15, 0.12),
      materials.get('wood.warm'),
    );
    board.castShadow = true;
    board.receiveShadow = true;
    group.add(board);

    // Legs down to the ground. The rack stands in the open rather than being
    // mounted on a wall, so without these it would appear to float.
    for (const side of [-0.72, 0.72]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.09, 1.7, 6),
        materials.get('wood.crate'),
      );
      leg.position.set(side, -1.42, 0);
      leg.castShadow = true;
      group.add(leg);
    }

    // A simple silhouette of the weapon: body, barrel and grip. Reading the
    // shape at a glance matters more here than fidelity.
    const metal = materials.get('metal.dark');
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.2, 0.14), metal);
    body.position.set(0, 0.08, 0.13);
    group.add(body);

    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.1), metal);
    barrel.position.set(0.75, 0.08, 0.13);
    group.add(barrel);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.42, 0.13), metal);
    grip.position.set(-0.3, -0.18, 0.13);
    grip.rotation.z = 0.22;
    group.add(grip);

    // The glow is what the player actually spots from across the district.
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, 1.7),
      new THREE.MeshBasicMaterial({
        color: 0xffc861,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    glow.position.z = -0.12;
    group.add(glow);

    group.position.copy(def.wallBuyPosition);
    group.rotation.y = def.wallBuyFacing;
    // Hidden until the district is opened, so it can't be bought through a wall.
    group.visible = false;
    this.group.add(group);

    return { def, group, bought: false, glow };
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * Animates the gates and works out what the player is being offered.
   *
   * Selection is by distance *and* facing, so standing between two purchases
   * never leaves the prompt flickering between them — you get whichever one you
   * are actually looking at.
   */
  update(dt: number, playerPosition: THREE.Vector3, playerForward: THREE.Vector3): void {
    this.elapsed += dt;

    for (const gate of this.gates) {
      if (!gate.open || gate.progress >= 1) continue;
      gate.progress = clamp01(gate.progress + dt * 0.9);
      // Ease-out so the doors slam apart and settle.
      const eased = 1 - (1 - gate.progress) ** 3;
      const leaves = gate.group.children;
      for (let i = 0; i < leaves.length; i++) {
        leaves[i].rotation.y = (i === 0 ? -1 : 1) * eased * 2.1;
      }
      if (gate.progress >= 1) gate.group.visible = false;
    }

    // Gentle pulse on the wall-buy glows.
    const pulse = 0.18 + Math.sin(this.elapsed * 2.4) * 0.07;
    for (const buy of this.wallBuys) {
      if (!buy.group.visible) continue;
      (buy.glow.material as THREE.MeshBasicMaterial).opacity = buy.bought ? pulse * 0.4 : pulse;
    }

    this.focus = this.findFocus(playerPosition, playerForward);
  }

  private findFocus(
    position: THREE.Vector3,
    forward: THREE.Vector3,
  ): { label: string; affordable: boolean; action: () => void } | null {
    let best: { label: string; affordable: boolean; action: () => void } | null = null;
    let bestScore = -Infinity;

    const consider = (
      target: THREE.Vector3,
      range: number,
      cost: number,
      text: (affordable: boolean) => string | null,
      action: () => void,
    ): void => {
      const dx = target.x - position.x;
      const dz = target.z - position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > range) return;

      // Must be roughly in front of the player.
      const facing = distance > 0.01 ? (dx * forward.x + dz * forward.z) / distance : 1;
      if (facing < 0.35) return;

      const affordable = cost <= 0 || this.callbacks.canAfford(cost);
      const label = text(affordable);
      if (!label) return;

      // Closest-and-most-centred wins.
      const score = facing * 2 - distance / range;
      if (score <= bestScore) return;
      bestScore = score;
      best = { label, affordable, action };
    };

    for (const gate of this.gates) {
      if (gate.open) continue;
      const target = gate.group.position;
      consider(
        target,
        4.5,
        gate.def.cost,
        (affordable) =>
          affordable
            ? `<b>E</b> Open ${gate.def.name} <span class="sh-prompt__cost">${gate.def.cost}</span>`
            : `Need <span class="sh-prompt__cost sh-prompt__cost--short">${gate.def.cost}</span> to open ${gate.def.name}`,
        () => this.openGate(gate),
      );
    }

    for (const buy of this.wallBuys) {
      if (!buy.group.visible) continue;
      const owned = this.callbacks.ownsWeapon(buy.def.wallBuy);
      const weapon = WEAPONS[buy.def.wallBuy];
      const cost = Math.round(
        weapon.price * (owned ? WALL_REFILL_FRACTION : WALL_BUY_DISCOUNT),
      );
      consider(
        buy.group.position,
        3.4,
        cost,
        (affordable) => {
          const action = owned ? `Refill ${weapon.name}` : `Take the ${weapon.name}`;
          return affordable
            ? `<b>E</b> ${action} <span class="sh-prompt__cost">${cost}</span>`
            : `Need <span class="sh-prompt__cost sh-prompt__cost--short">${cost}</span> for the ${weapon.name}`;
        },
        () => this.buyFromWall(buy, cost, owned),
      );
    }

    return best;
  }

  /** The prompt the HUD should show this frame, or null. */
  get promptText(): string | null {
    return this.focus?.label ?? null;
  }

  /** Runs the focused purchase. Called when the interact key is pressed. */
  tryInteract(): void {
    if (!this.focus) return;
    if (!this.focus.affordable) {
      audio.sfx.denied();
      return;
    }
    this.focus.action();
  }

  // -------------------------------------------------------------------------
  // Purchases
  // -------------------------------------------------------------------------

  private openGate(gate: Gate): void {
    if (gate.open) return;
    if (!this.callbacks.spend(gate.def.cost)) {
      audio.sfx.denied();
      return;
    }

    gate.open = true;
    for (const collider of gate.colliders) collider.enabled = false;

    // The weapon on the wall inside only becomes reachable now.
    const buy = this.wallBuys.find((w) => w.def.id === gate.def.id);
    if (buy) buy.group.visible = true;

    audio.sfx.purchase();
    this.callbacks.onZoneOpened(gate.def.id, gate.def.name);
  }

  private buyFromWall(buy: WallBuy, cost: number, owned: boolean): void {
    if (!this.callbacks.spend(cost)) {
      audio.sfx.denied();
      return;
    }

    if (owned) {
      this.callbacks.refillAmmo();
    } else {
      this.callbacks.grantWeapon(buy.def.wallBuy);
      buy.bought = true;
    }
    audio.sfx.purchase();
  }

  // -------------------------------------------------------------------------

  /** Returns every gate to shut, for a fresh run. */
  reset(): void {
    for (const gate of this.gates) {
      gate.open = false;
      gate.progress = 0;
      gate.group.visible = true;
      for (const leaf of gate.group.children) leaf.rotation.y = 0;
      for (const collider of gate.colliders) collider.enabled = true;
    }
    for (const buy of this.wallBuys) {
      buy.bought = false;
      buy.group.visible = false;
    }
    this.focus = null;
  }

  dispose(): void {
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
    });
    this.gates.length = 0;
    this.wallBuys.length = 0;
  }
}
