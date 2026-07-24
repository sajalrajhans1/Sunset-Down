import { ECONOMY } from '../game/Config';
import { Storage, STORAGE_KEYS } from '../utilities/Storage';
import { clamp01 } from '../utilities/MathUtils';

export interface RunStats {
  kills: number;
  headshots: number;
  criticals: number;
  shotsFired: number;
  shotsHit: number;
  coinsEarned: number;
  coinsSpent: number;
  damageDealt: number;
  damageTaken: number;
  highestWave: number;
  highestCombo: number;
  bossesKilled: number;
  timeSurvived: number;
  upgradesPurchased: number;
}

export interface PersistentRecords {
  bestWave: number;
  bestKills: number;
  bestCoins: number;
  runsPlayed: number;
  totalKills: number;
}

const EMPTY_STATS: RunStats = {
  kills: 0,
  headshots: 0,
  criticals: 0,
  shotsFired: 0,
  shotsHit: 0,
  coinsEarned: 0,
  coinsSpent: 0,
  damageDealt: 0,
  damageTaken: 0,
  highestWave: 0,
  highestCombo: 1,
  bossesKilled: 0,
  timeSurvived: 0,
  upgradesPurchased: 0,
};

const EMPTY_RECORDS: PersistentRecords = {
  bestWave: 0,
  bestKills: 0,
  bestCoins: 0,
  runsPlayed: 0,
  totalKills: 0,
};

/**
 * Coins, the kill-combo multiplier, and run statistics.
 *
 * The combo is the main skill-expression lever: chaining kills within a short
 * window multiplies every payout, so aggressive, accurate play funds upgrades
 * far faster than cautious play. It decays rather than snapping to 1 so a
 * single missed beat isn't punishing.
 */
export class EconomySystem {
  coins = ECONOMY.startingCoins;

  private comboMultiplier = 1;
  private comboTimer = 0;
  private comboKills = 0;
  /** Rising pitch index for the coin pickup chime. */
  private pitchStep = 0;

  stats: RunStats = { ...EMPTY_STATS };
  records: PersistentRecords;

  onCoinsChanged: ((coins: number, delta: number) => void) | null = null;
  onComboChanged: ((multiplier: number, kills: number) => void) | null = null;

  constructor() {
    this.records = Storage.get<PersistentRecords>(STORAGE_KEYS.records, EMPTY_RECORDS);
  }

  reset(): void {
    this.coins = ECONOMY.startingCoins;
    this.comboMultiplier = 1;
    this.comboTimer = 0;
    this.comboKills = 0;
    this.pitchStep = 0;
    this.stats = { ...EMPTY_STATS };
    this.onCoinsChanged?.(this.coins, 0);
    this.onComboChanged?.(1, 0);
  }

  // -------------------------------------------------------------------------
  // Combo
  // -------------------------------------------------------------------------

  get combo(): number {
    return this.comboMultiplier;
  }

  get comboKillCount(): number {
    return this.comboKills;
  }

  /** 0..1 remaining time on the combo window, for the HUD ring. */
  get comboFraction(): number {
    return clamp01(this.comboTimer / ECONOMY.comboWindow);
  }

  update(dt: number): void {
    if (this.comboTimer <= 0) return;
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) {
      this.comboTimer = 0;
      this.comboMultiplier = 1;
      this.comboKills = 0;
      this.pitchStep = 0;
      this.onComboChanged?.(1, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Earning
  // -------------------------------------------------------------------------

  /** Registers a kill and pays out. Returns the coins awarded. */
  registerKill(options: {
    baseValue: number;
    headshot: boolean;
    isBoss: boolean;
  }): { coins: number; multiplier: number; pitchStep: number } {
    this.comboKills++;
    this.comboTimer = ECONOMY.comboWindow;
    this.comboMultiplier = Math.min(
      ECONOMY.comboMaxMultiplier,
      1 + (this.comboKills - 1) * ECONOMY.comboStepPerKill,
    );
    this.pitchStep = Math.min(this.pitchStep + 1, 11);

    const base = options.headshot ? ECONOMY.coinsPerHeadshot : ECONOMY.coinsPerKill;
    let coins = Math.round(base * options.baseValue * this.comboMultiplier);
    if (options.isBoss) coins += ECONOMY.bossKillBonus;

    this.addCoins(coins);
    this.stats.kills++;
    if (options.headshot) this.stats.headshots++;
    if (options.isBoss) this.stats.bossesKilled++;
    this.stats.highestCombo = Math.max(this.stats.highestCombo, this.comboMultiplier);

    this.onComboChanged?.(this.comboMultiplier, this.comboKills);
    return { coins, multiplier: this.comboMultiplier, pitchStep: this.pitchStep };
  }

  /** End-of-wave bonus, scaling with how deep the run has gone. */
  registerWaveClear(waveNumber: number): number {
    const bonus = ECONOMY.waveClearBase + ECONOMY.waveClearPerWave * waveNumber;
    this.addCoins(bonus);
    this.stats.highestWave = Math.max(this.stats.highestWave, waveNumber);
    return bonus;
  }

  addCoins(amount: number): void {
    if (amount === 0) return;
    this.coins += amount;
    this.stats.coinsEarned += Math.max(0, amount);
    this.onCoinsChanged?.(this.coins, amount);
  }

  canAfford(cost: number): boolean {
    return this.coins >= cost;
  }

  /** Deducts a cost. Returns false (and changes nothing) if unaffordable. */
  spend(cost: number): boolean {
    if (!this.canAfford(cost)) return false;
    this.coins -= cost;
    this.stats.coinsSpent += cost;
    this.onCoinsChanged?.(this.coins, -cost);
    return true;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  registerShot(pellets: number): void {
    this.stats.shotsFired += pellets;
  }

  registerHit(damage: number, critical: boolean): void {
    this.stats.shotsHit++;
    this.stats.damageDealt += damage;
    if (critical) this.stats.criticals++;
  }

  registerDamageTaken(amount: number): void {
    this.stats.damageTaken += amount;
  }

  get accuracy(): number {
    if (this.stats.shotsFired === 0) return 0;
    return clamp01(this.stats.shotsHit / this.stats.shotsFired);
  }

  /** Persists this run's bests. Called once when a run ends. */
  finalise(waveReached: number, timeSurvived: number): void {
    this.stats.highestWave = Math.max(this.stats.highestWave, waveReached);
    this.stats.timeSurvived = timeSurvived;

    this.records = {
      bestWave: Math.max(this.records.bestWave, this.stats.highestWave),
      bestKills: Math.max(this.records.bestKills, this.stats.kills),
      bestCoins: Math.max(this.records.bestCoins, this.stats.coinsEarned),
      runsPlayed: this.records.runsPlayed + 1,
      totalKills: this.records.totalKills + this.stats.kills,
    };
    Storage.set(STORAGE_KEYS.records, this.records);
  }

  /** True when this run beat the stored best wave. */
  get isNewRecord(): boolean {
    return this.stats.highestWave > 0 && this.stats.highestWave >= this.records.bestWave;
  }
}
