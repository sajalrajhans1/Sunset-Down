import pistol from '../assets/weapon-pistol.webp';
import smg from '../assets/weapon-smg.webp';
import shotgun from '../assets/weapon-shotgun.webp';
import rifle from '../assets/weapon-rifle.webp';
import sniper from '../assets/weapon-sniper.webp';
import type { WeaponId } from '../weapons/WeaponDefs';

/**
 * Buy-menu artwork for each weapon.
 *
 * Kept apart from WeaponDefs so the gameplay data stays free of asset imports
 * — the shop is the only thing that needs these.
 */
export const WEAPON_ART: Record<WeaponId, string> = {
  pistol,
  smg,
  shotgun,
  rifle,
  sniper,
};
