import { PLAYER, UPGRADES, upgradeCost, type UpgradeDef, type UpgradeId } from './Config';
import type { WeaponModifiers } from '../weapons/Weapon';

/**
 * The player's permanent progression for a run.
 *
 * All derived combat values funnel through here, so every system reads one
 * source of truth and balance changes only ever need to touch Config.
 */
export class PlayerStats {
  private readonly levels = new Map<UpgradeId, number>();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.levels.clear();
    for (const def of UPGRADES) this.levels.set(def.id, 0);
  }

  levelOf(id: UpgradeId): number {
    return this.levels.get(id) ?? 0;
  }

  defOf(id: UpgradeId): UpgradeDef {
    const def = UPGRADES.find((u) => u.id === id);
    if (!def) throw new Error(`Unknown upgrade: ${id}`);
    return def;
  }

  isMaxed(id: UpgradeId): boolean {
    return this.levelOf(id) >= this.defOf(id).maxLevel;
  }

  /** Cost of the *next* level, or null when maxed out. */
  nextCost(id: UpgradeId): number | null {
    if (this.isMaxed(id)) return null;
    return upgradeCost(this.defOf(id), this.levelOf(id));
  }

  /** Applies one level. The caller is responsible for deducting coins. */
  applyUpgrade(id: UpgradeId): boolean {
    if (this.isMaxed(id)) return false;
    this.levels.set(id, this.levelOf(id) + 1);
    return true;
  }

  /** Human-readable current effect, e.g. "+45 HP". */
  describe(id: UpgradeId): string {
    const def = this.defOf(id);
    const level = this.levelOf(id);
    return level === 0 ? '—' : def.format(level, def.perLevel);
  }

  /** What the next level would read as, for the shop's before/after display. */
  describeNext(id: UpgradeId): string {
    const def = this.defOf(id);
    const level = this.levelOf(id);
    if (level >= def.maxLevel) return 'MAX';
    return def.format(level + 1, def.perLevel);
  }

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  get maxHealth(): number {
    return PLAYER.baseHealth + this.levelOf('health') * this.defOf('health').perLevel;
  }

  get maxArmor(): number {
    return Math.min(PLAYER.maxArmorCap, this.levelOf('armor') * this.defOf('armor').perLevel);
  }

  get moveSpeedMultiplier(): number {
    return 1 + this.levelOf('speed') * this.defOf('speed').perLevel;
  }

  get damageMultiplier(): number {
    return 1 + this.levelOf('damage') * this.defOf('damage').perLevel;
  }

  get reloadSpeedMultiplier(): number {
    return 1 + this.levelOf('reload') * this.defOf('reload').perLevel;
  }

  get magazineMultiplier(): number {
    return 1 + this.levelOf('magazine') * this.defOf('magazine').perLevel;
  }

  get fireRateMultiplier(): number {
    return 1 + this.levelOf('firerate') * this.defOf('firerate').perLevel;
  }

  get criticalChance(): number {
    return Math.min(0.75, this.levelOf('crit') * this.defOf('crit').perLevel);
  }

  /** Bundle handed to every weapon so they pick up upgrades automatically. */
  toWeaponModifiers(): WeaponModifiers {
    return {
      damage: this.damageMultiplier,
      fireRate: this.fireRateMultiplier,
      reloadSpeed: this.reloadSpeedMultiplier,
      magazineSize: this.magazineMultiplier,
    };
  }

  /** Total levels purchased — used for the end-of-run summary. */
  get totalLevels(): number {
    let total = 0;
    for (const value of this.levels.values()) total += value;
    return total;
  }

  snapshot(): Record<UpgradeId, number> {
    const result = {} as Record<UpgradeId, number>;
    for (const def of UPGRADES) result[def.id] = this.levelOf(def.id);
    return result;
  }
}
