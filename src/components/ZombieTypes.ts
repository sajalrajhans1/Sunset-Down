export type ZombieTypeId = 'normal' | 'fast' | 'tank' | 'exploder' | 'boss';

export interface ZombieProportions {
  /** Overall multiplier applied on top of the per-type scale. */
  head: number;
  bodyWidth: number;
  bodyHeight: number;
  armLength: number;
  armThickness: number;
  legLength: number;
  legThickness: number;
  eye: number;
  /** Vertical offset of the head relative to the torso top. */
  neck: number;
}

export interface ZombieTypeDef {
  id: ZombieTypeId;
  name: string;
  /** Base health at wave 1, before per-wave scaling. */
  health: number;
  /** Metres per second. */
  speed: number;
  damage: number;
  /** Seconds between melee swings. */
  attackInterval: number;
  /** Distance at which it can land a hit. */
  attackRange: number;
  scale: number;
  /** Coins awarded on kill, before combo multiplier. */
  coinValue: number;
  /** Palette to pick a body colour from — variety within a class. */
  colors: number[];
  accentColor: number;
  proportions: ZombieProportions;
  /** Walk cycle speed multiplier and character. */
  gaitFrequency: number;
  gaitWobble: number;
  /** Multiplier on the growl's base pitch. */
  voicePitch: number;
  /** How hard it shoves the player's screen when it hits. */
  hitShake: number;
  /** Relative weight when the wave director rolls a spawn. */
  spawnWeight: number;
  isBoss: boolean;
  /** Exploders detonate instead of meleeing. */
  explodes: boolean;
  explosionRadius: number;
  explosionDamage: number;
  /** Damage multiplier applied to headshots on this class. */
  headshotMultiplier: number;
}

/**
 * The five zombie classes.
 *
 * Visual language is doing real gameplay work here: every class is instantly
 * readable at a glance by silhouette and colour, so players can triage a crowd
 * without reading health bars. Pink and lanky = fast. Big and purple = tank.
 * Round and glowing orange = get away from it.
 */
export const ZOMBIE_TYPES: Record<ZombieTypeId, ZombieTypeDef> = {
  normal: {
    id: 'normal',
    name: 'Shambler',
    health: 100,
    speed: 3.05,
    damage: 15,
    attackInterval: 0.95,
    attackRange: 2.0,
    scale: 1.0,
    coinValue: 1,
    colors: [0x7d9c6e, 0x6f9084, 0x8a9a5f, 0x6d8a92],
    accentColor: 0x2b3328,
    proportions: {
      head: 1,
      bodyWidth: 1,
      bodyHeight: 1,
      armLength: 1,
      armThickness: 1,
      legLength: 1,
      legThickness: 1,
      eye: 1,
      neck: 0,
    },
    gaitFrequency: 1,
    gaitWobble: 1,
    voicePitch: 0.78,
    hitShake: 0.35,
    spawnWeight: 100,
    isBoss: false,
    explodes: false,
    explosionRadius: 0,
    explosionDamage: 0,
    headshotMultiplier: 2.3,
  },

  fast: {
    id: 'fast',
    name: 'Sprinter',
    health: 58,
    speed: 6.1,
    damage: 11,
    attackInterval: 0.6,
    attackRange: 1.9,
    scale: 0.97,
    coinValue: 1.35,
    colors: [0xb0546a, 0xb35f4c, 0xa1548f],
    accentColor: 0x3a1f2c,
    proportions: {
      // Lanky: long limbs, narrow body, small head — reads as "quick".
      head: 0.88,
      bodyWidth: 0.78,
      bodyHeight: 1.14,
      armLength: 1.35,
      armThickness: 0.72,
      legLength: 1.42,
      legThickness: 0.7,
      eye: 1.1,
      neck: 0.06,
    },
    gaitFrequency: 1.75,
    gaitWobble: 1.5,
    voicePitch: 1.15,
    hitShake: 0.28,
    spawnWeight: 55,
    isBoss: false,
    explodes: false,
    explosionRadius: 0,
    explosionDamage: 0,
    headshotMultiplier: 2.6,
  },

  tank: {
    id: 'tank',
    name: 'Bruiser',
    health: 520,
    speed: 1.95,
    damage: 36,
    attackInterval: 1.5,
    attackRange: 2.6,
    scale: 1.26,
    coinValue: 3.2,
    colors: [0x6a5490, 0x55598f, 0x604a80],
    accentColor: 0x241d38,
    proportions: {
      // Enormous torso, stubby legs, tiny head — pure heavyweight silhouette.
      head: 0.82,
      bodyWidth: 1.5,
      bodyHeight: 0.94,
      armLength: 1.12,
      armThickness: 1.65,
      legLength: 0.74,
      legThickness: 1.6,
      eye: 0.86,
      neck: -0.08,
    },
    gaitFrequency: 0.62,
    gaitWobble: 1.9,
    voicePitch: 0.48,
    hitShake: 1.0,
    spawnWeight: 28,
    isBoss: false,
    explodes: false,
    explosionRadius: 0,
    explosionDamage: 0,
    headshotMultiplier: 1.8,
  },

  exploder: {
    id: 'exploder',
    name: 'Popper',
    health: 82,
    speed: 3.75,
    damage: 0,
    attackInterval: 0.5,
    attackRange: 2.2,
    scale: 1.03,
    coinValue: 1.8,
    colors: [0xd9a03a, 0xcf7f30, 0xd8b04e],
    accentColor: 0xe8632f,
    proportions: {
      // Balloon-bodied with tiny limbs: obviously about to pop.
      head: 0.78,
      bodyWidth: 1.42,
      bodyHeight: 1.18,
      armLength: 0.68,
      armThickness: 0.78,
      legLength: 0.66,
      legThickness: 0.8,
      eye: 1.25,
      neck: -0.05,
    },
    gaitFrequency: 1.25,
    gaitWobble: 2.2,
    voicePitch: 1.0,
    hitShake: 0.3,
    spawnWeight: 34,
    isBoss: false,
    explodes: true,
    explosionRadius: 5.2,
    explosionDamage: 52,
    headshotMultiplier: 2.0,
  },

  boss: {
    id: 'boss',
    name: 'The Mayor',
    health: 2900,
    speed: 2.45,
    damage: 50,
    attackInterval: 1.35,
    attackRange: 3.8,
    scale: 3.1,
    coinValue: 12,
    colors: [0x43558f, 0x4d4290],
    accentColor: 0xffc861,
    proportions: {
      head: 1.05,
      bodyWidth: 1.32,
      bodyHeight: 1.12,
      armLength: 1.25,
      armThickness: 1.45,
      legLength: 1.0,
      legThickness: 1.4,
      eye: 1.0,
      neck: 0.02,
    },
    gaitFrequency: 0.72,
    gaitWobble: 1.4,
    voicePitch: 0.34,
    hitShake: 1.6,
    spawnWeight: 0,
    isBoss: true,
    explodes: false,
    explosionRadius: 0,
    explosionDamage: 0,
    headshotMultiplier: 1.5,
  },
};

export const ZOMBIE_TYPE_IDS: ZombieTypeId[] = ['normal', 'fast', 'tank', 'exploder', 'boss'];
