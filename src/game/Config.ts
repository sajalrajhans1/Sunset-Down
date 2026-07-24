/**
 * Central balance sheet. Every tunable gameplay number lives here so designers
 * (and future me) can retune the game without hunting through systems.
 */

export const WORLD = {
  /** Half-extent of the playable square, in metres. */
  halfSize: 62,
  /** Nav grid resolution used by the flow-field pathfinder. */
  navCellSize: 1.5,
  groundY: 0,
  fogNear: 34,
  fogFar: 155,
  fogColor: 0xffb27a,
  skyTopColor: 0x2e3f8f,
  skyHorizonColor: 0xffb765,
  skySunColor: 0xfff3c4,
  sunDirection: { x: -0.55, y: 0.36, z: -0.75 },
} as const;

export const PLAYER = {
  eyeHeight: 1.68,
  crouchEyeHeight: 1.05,
  radius: 0.42,
  baseHealth: 100,
  baseArmor: 0,
  maxArmorCap: 150,

  walkSpeed: 5.1,
  sprintMultiplier: 1.62,
  crouchMultiplier: 0.52,
  airControl: 0.28,
  groundAccel: 62,
  groundFriction: 11.5,
  airAccel: 14,

  jumpVelocity: 6.1,
  gravity: -21.5,
  /** Grace period after walking off a ledge where a jump still registers. */
  coyoteTime: 0.12,
  jumpBufferTime: 0.14,

  /** Sprint drains, standing still regenerates. */
  staminaMax: 100,
  staminaDrain: 21,
  staminaRegen: 27,
  staminaRegenDelay: 0.7,

  healthRegenDelay: 5.5,
  healthRegenRate: 7,

  fovSprintKick: 9,
  fovAdsZoom: -22,

  bobFrequency: 9.2,
  bobAmplitude: 0.042,
  landingDipMax: 0.28,

  /** Seconds of invulnerability after taking a hit, prevents stunlock deaths. */
  hurtImmunity: 0.34,
} as const;

export const WAVES = {
  prepTimeFirst: 12,
  prepTime: 18,
  /** Zombies alive on the field at once is capped by the quality profile too. */
  baseCount: 6,
  countGrowth: 2.6,
  countExponent: 1.14,
  maxCount: 90,

  baseSpawnInterval: 1.5,
  minSpawnInterval: 0.28,
  spawnIntervalDecay: 0.94,

  /** Multiplicative per-wave scaling applied to zombie stats. */
  healthScale: 1.135,
  speedScale: 1.021,
  maxSpeedScale: 1.75,
  damageScale: 1.055,

  bossEvery: 5,
  /** Wave number from which elite (fast/tank/exploder) mixes start appearing. */
  fastFromWave: 2,
  tankFromWave: 4,
  exploderFromWave: 6,
} as const;

export const ECONOMY = {
  startingCoins: 500,
  coinsPerKill: 22,
  coinsPerHeadshot: 34,
  bossKillBonus: 450,
  waveClearBase: 120,
  waveClearPerWave: 45,
  /** Combo multiplier ramps with fast consecutive kills. */
  comboWindow: 3.4,
  comboMaxMultiplier: 5,
  comboStepPerKill: 0.25,
  ammoRefillCost: 180,
} as const;

export const COMBAT = {
  headshotMultiplier: 2.3,
  baseCritMultiplier: 2.0,
  /** Falloff makes long-range pistol chip damage feel fair without being useless. */
  hitPauseDuration: 0.045,
  hitPauseScale: 0.22,
  maxTraceDistance: 220,
  meleeRange: 2.35,
} as const;

/** Progressive upgrade tracks purchasable between (and during) waves. */
export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  icon: string;
  description: string;
  maxLevel: number;
  baseCost: number;
  costGrowth: number;
  /** Additive-per-level value; interpretation depends on the stat. */
  perLevel: number;
  format: (level: number, perLevel: number) => string;
}

export type UpgradeId =
  | 'health'
  | 'speed'
  | 'damage'
  | 'reload'
  | 'magazine'
  | 'firerate'
  | 'crit'
  | 'armor';

const pct = (level: number, per: number): string => `+${Math.round(level * per * 100)}%`;

export const UPGRADES: readonly UpgradeDef[] = [
  {
    id: 'health',
    name: 'Vitality',
    icon: '❤️',
    description: 'Raises your maximum health pool.',
    maxLevel: 10,
    baseCost: 320,
    costGrowth: 1.42,
    perLevel: 25,
    format: (l, p) => `+${l * p} HP`,
  },
  {
    id: 'speed',
    name: 'Swiftness',
    icon: '🥾',
    description: 'Move and sprint faster on your feet.',
    maxLevel: 8,
    baseCost: 300,
    costGrowth: 1.45,
    perLevel: 0.05,
    format: pct,
  },
  {
    id: 'damage',
    name: 'Firepower',
    icon: '💥',
    description: 'Every weapon hits harder.',
    maxLevel: 12,
    baseCost: 380,
    costGrowth: 1.48,
    perLevel: 0.12,
    format: pct,
  },
  {
    id: 'reload',
    name: 'Quick Hands',
    icon: '🌀',
    description: 'Reload noticeably faster.',
    maxLevel: 8,
    baseCost: 280,
    costGrowth: 1.4,
    perLevel: 0.08,
    format: pct,
  },
  {
    id: 'magazine',
    name: 'Deep Pockets',
    icon: '🎒',
    description: 'More rounds in every magazine.',
    maxLevel: 8,
    baseCost: 340,
    costGrowth: 1.44,
    perLevel: 0.2,
    format: pct,
  },
  {
    id: 'firerate',
    name: 'Trigger Finger',
    icon: '⚡',
    description: 'Increases rate of fire.',
    maxLevel: 8,
    baseCost: 400,
    costGrowth: 1.5,
    perLevel: 0.07,
    format: pct,
  },
  {
    id: 'crit',
    name: 'Lucky Shot',
    icon: '✨',
    description: 'Chance to deal double damage.',
    maxLevel: 10,
    baseCost: 360,
    costGrowth: 1.46,
    perLevel: 0.05,
    format: (l, p) => `${Math.round(l * p * 100)}% chance`,
  },
  {
    id: 'armor',
    name: 'Plating',
    icon: '🛡️',
    description: 'Armor absorbs damage before health, and refills each wave.',
    maxLevel: 10,
    baseCost: 350,
    costGrowth: 1.44,
    perLevel: 15,
    format: (l, p) => `${l * p} AP`,
  },
];

export function upgradeCost(def: UpgradeDef, currentLevel: number): number {
  return Math.round(def.baseCost * Math.pow(def.costGrowth, currentLevel) * 0.1) * 10;
}

/** Colour identity used consistently across UI, particles and lighting. */
export const PALETTE = {
  sunsetOrange: 0xff8a3d,
  sunsetPink: 0xff6f9c,
  warmGold: 0xffc861,
  skyLavender: 0x8b6fd4,
  deepPlum: 0x2a1a44,
  mintGreen: 0x6fe3a8,
  candyRed: 0xff5d5d,
  cyanPop: 0x5fd8ff,
  cream: 0xfff2dc,
} as const;
