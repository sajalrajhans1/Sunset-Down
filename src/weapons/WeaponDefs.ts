import type { GunSoundProfile } from '../audio/SoundBank';

export type WeaponId = 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper';

export type FireMode = 'semi' | 'auto' | 'pump' | 'bolt';

/** How the reload animation and timing behave. */
export type ReloadStyle = 'magazine' | 'shells';

export interface RecoilProfile {
  /** Degrees of upward camera kick per shot. */
  vertical: number;
  /** Maximum degrees of random horizontal kick per shot. */
  horizontal: number;
  /** Viewmodel kickback along -Z, in metres. */
  punch: number;
  /** How fast the camera returns to centre. Higher = snappier. */
  recovery: number;
  /** Screen shake magnitude. */
  shake: number;
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** Short flavour line shown in the shop. */
  tagline: string;
  icon: string;
  price: number;

  damage: number;
  /** Pellets per trigger pull. >1 turns the weapon into a spread weapon. */
  pellets: number;
  /** Seconds between shots. */
  fireInterval: number;
  fireMode: FireMode;

  magazineSize: number;
  reserveAmmo: number;
  maxReserveAmmo: number;
  reloadTime: number;
  reloadStyle: ReloadStyle;
  /** For shell reloads: seconds per shell. */
  shellTime: number;

  /** Cone half-angle in degrees while hip-firing and stationary. */
  spread: number;
  /** Extra spread added at full movement speed. */
  moveSpread: number;
  /** Spread multiplier while aiming down sights. */
  adsSpreadScale: number;
  /** Additional spread accumulated per consecutive shot. */
  bloomPerShot: number;
  maxBloom: number;

  recoil: RecoilProfile;

  /** How many zombies a single bullet can pass through. */
  penetration: number;
  /** Damage retained after each penetration. */
  penetrationFalloff: number;
  /** Range in metres at which damage begins to drop off. */
  falloffStart: number;
  falloffEnd: number;
  /** Damage multiplier at maximum range. */
  minDamageScale: number;

  /** FOV change while aiming, in degrees (negative = zoom in). */
  adsFovDelta: number;
  adsTime: number;

  sound: GunSoundProfile;

  /** Viewmodel resting transform, relative to the camera. */
  viewPosition: [number, number, number];
  viewRotation: [number, number, number];
  /** Aim-down-sights transform. */
  adsPosition: [number, number, number];

  /** Crosshair spread multiplier for the HUD. */
  crosshairScale: number;
  /** Shows the sniper scope overlay while aiming. */
  hasScope: boolean;
}

/**
 * The five weapons. Each is designed around a distinct role so upgrading feels
 * like a real choice rather than a linear power increase:
 *
 *  • Pistol  — free, reliable, high crit value; never runs dry
 *  • SMG     — shreds fast zombies up close, punished at range
 *  • Shotgun — crowd control, must be used at contact distance
 *  • Rifle   — the all-rounder; best sustained DPS at mid range
 *  • Sniper  — deletes tanks and bosses, punishing to miss with
 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol',
    name: 'Peacekeeper',
    tagline: 'Trusty sidearm. Never lets you down.',
    icon: '🔫',
    price: 0,

    damage: 34,
    pellets: 1,
    fireInterval: 0.145,
    fireMode: 'semi',

    magazineSize: 14,
    reserveAmmo: 140,
    maxReserveAmmo: 260,
    reloadTime: 1.15,
    reloadStyle: 'magazine',
    shellTime: 0,

    spread: 0.55,
    moveSpread: 1.4,
    adsSpreadScale: 0.35,
    bloomPerShot: 0.32,
    maxBloom: 2.4,

    recoil: { vertical: 1.45, horizontal: 0.42, punch: 0.045, recovery: 11, shake: 0.5 },

    penetration: 1,
    penetrationFalloff: 0.6,
    falloffStart: 26,
    falloffEnd: 60,
    minDamageScale: 0.62,

    adsFovDelta: -14,
    adsTime: 0.16,

    sound: { level: 0.42, brightness: 1750, body: 150, decay: 0.15, tail: 0.1, drive: 0.25, space: 0.3 },

    viewPosition: [0.24, -0.24, -0.44],
    viewRotation: [0, 0.06, 0],
    adsPosition: [0, -0.135, -0.32],

    crosshairScale: 1,
    hasScope: false,
  },

  smg: {
    id: 'smg',
    name: 'Buzzbee',
    tagline: 'Empties a magazine before you can blink.',
    icon: '🐝',
    price: 1500,

    damage: 18,
    pellets: 1,
    fireInterval: 0.072,
    fireMode: 'auto',

    magazineSize: 34,
    reserveAmmo: 300,
    maxReserveAmmo: 540,
    reloadTime: 1.55,
    reloadStyle: 'magazine',
    shellTime: 0,

    spread: 1.15,
    moveSpread: 1.5,
    adsSpreadScale: 0.55,
    bloomPerShot: 0.26,
    maxBloom: 4.2,

    recoil: { vertical: 0.72, horizontal: 0.55, punch: 0.028, recovery: 13, shake: 0.3 },

    penetration: 1,
    penetrationFalloff: 0.5,
    falloffStart: 16,
    falloffEnd: 42,
    minDamageScale: 0.45,

    adsFovDelta: -10,
    adsTime: 0.13,

    sound: { level: 0.34, brightness: 2100, body: 175, decay: 0.1, tail: 0.07, drive: 0.3, space: 0.24 },

    viewPosition: [0.26, -0.25, -0.5],
    viewRotation: [0, 0.05, 0],
    adsPosition: [0, -0.13, -0.36],

    crosshairScale: 1.3,
    hasScope: false,
  },

  shotgun: {
    id: 'shotgun',
    name: 'Sunflower',
    tagline: 'Nine petals of pure persuasion.',
    icon: '🌻',
    price: 2000,

    damage: 17,
    pellets: 9,
    fireInterval: 0.78,
    fireMode: 'pump',

    magazineSize: 7,
    reserveAmmo: 64,
    maxReserveAmmo: 120,
    reloadTime: 0.55,
    reloadStyle: 'shells',
    shellTime: 0.34,

    spread: 6.2,
    moveSpread: 1.2,
    adsSpreadScale: 0.62,
    bloomPerShot: 0,
    maxBloom: 0,

    recoil: { vertical: 4.6, horizontal: 0.9, punch: 0.11, recovery: 8, shake: 1.5 },

    penetration: 1,
    penetrationFalloff: 0.5,
    falloffStart: 9,
    falloffEnd: 26,
    minDamageScale: 0.2,

    adsFovDelta: -6,
    adsTime: 0.2,

    sound: { level: 0.62, brightness: 1100, body: 92, decay: 0.3, tail: 0.26, drive: 0.42, space: 0.5 },

    viewPosition: [0.24, -0.26, -0.58],
    viewRotation: [0, 0.04, 0],
    adsPosition: [0, -0.14, -0.42],

    crosshairScale: 2.4,
    hasScope: false,
  },

  rifle: {
    id: 'rifle',
    name: 'Ranger',
    tagline: 'Steady, dependable, deeply unfriendly.',
    icon: '🎯',
    price: 2800,

    damage: 33,
    pellets: 1,
    fireInterval: 0.105,
    fireMode: 'auto',

    magazineSize: 30,
    reserveAmmo: 260,
    maxReserveAmmo: 460,
    reloadTime: 1.95,
    reloadStyle: 'magazine',
    shellTime: 0,

    spread: 0.85,
    moveSpread: 1.35,
    adsSpreadScale: 0.3,
    bloomPerShot: 0.3,
    maxBloom: 3.4,

    recoil: { vertical: 1.15, horizontal: 0.4, punch: 0.05, recovery: 10, shake: 0.55 },

    penetration: 2,
    penetrationFalloff: 0.62,
    falloffStart: 34,
    falloffEnd: 78,
    minDamageScale: 0.68,

    adsFovDelta: -18,
    adsTime: 0.18,

    sound: { level: 0.5, brightness: 1550, body: 128, decay: 0.19, tail: 0.15, drive: 0.35, space: 0.38 },

    viewPosition: [0.25, -0.25, -0.56],
    viewRotation: [0, 0.045, 0],
    adsPosition: [0, -0.132, -0.4],

    crosshairScale: 1.1,
    hasScope: false,
  },

  sniper: {
    id: 'sniper',
    name: 'Longshot',
    tagline: 'One breath. One shot. One very surprised zombie.',
    icon: '🔭',
    price: 4200,

    damage: 265,
    pellets: 1,
    fireInterval: 1.15,
    fireMode: 'bolt',

    magazineSize: 5,
    reserveAmmo: 45,
    maxReserveAmmo: 90,
    reloadTime: 2.5,
    reloadStyle: 'magazine',
    shellTime: 0,

    spread: 2.6,
    moveSpread: 2.6,
    adsSpreadScale: 0.02,
    bloomPerShot: 0,
    maxBloom: 0,

    recoil: { vertical: 6.2, horizontal: 0.6, punch: 0.14, recovery: 6.5, shake: 2.0 },

    penetration: 4,
    penetrationFalloff: 0.75,
    falloffStart: 120,
    falloffEnd: 220,
    minDamageScale: 0.9,

    adsFovDelta: -46,
    adsTime: 0.3,

    sound: { level: 0.72, brightness: 1300, body: 78, decay: 0.36, tail: 0.5, drive: 0.4, space: 0.72 },

    viewPosition: [0.24, -0.24, -0.62],
    viewRotation: [0, 0.035, 0],
    adsPosition: [0, -0.118, -0.46],

    crosshairScale: 0.7,
    hasScope: true,
  },
};

export const WEAPON_ORDER: WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];

/** Maps a weapon to the audio profile used for its impact sounds. */
export function isAutomatic(def: WeaponDef): boolean {
  return def.fireMode === 'auto';
}
