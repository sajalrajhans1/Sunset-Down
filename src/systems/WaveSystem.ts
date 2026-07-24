import * as THREE from 'three';
import { WAVES } from '../game/Config';
import type { ZombieTypeId } from '../components/ZombieTypes';
import { ZOMBIE_TYPES } from '../components/ZombieTypes';
import { clamp01, pick } from '../utilities/MathUtils';

export type WavePhase = 'idle' | 'prep' | 'active' | 'cleared';

export interface WaveComposition {
  type: ZombieTypeId;
  count: number;
}

export interface WaveSnapshot {
  phase: WavePhase;
  waveNumber: number;
  /** Zombies still to spawn plus those still alive. */
  remaining: number;
  totalThisWave: number;
  /** Seconds left in the prep countdown. */
  prepRemaining: number;
  isBossWave: boolean;
  aggression: number;
}

/**
 * The wave director.
 *
 * Owns pacing, difficulty scaling and the spawn queue. Deliberately kept free
 * of any rendering or entity knowledge: it decides *what* should spawn and
 * *when*, and asks the host to actually place it. That makes the difficulty
 * curve testable in isolation and easy to retune.
 */
export class WaveSystem {
  phase: WavePhase = 'idle';
  waveNumber = 0;

  private prepTimer = 0;
  private spawnTimer = 0;
  private queue: ZombieTypeId[] = [];
  private spawnedThisWave = 0;
  private totalThisWave = 0;
  private aliveFromThisWave = 0;

  onWaveStart: ((wave: number, isBoss: boolean, total: number) => void) | null = null;
  onWaveCleared: ((wave: number) => void) | null = null;
  onPrepStart: ((nextWave: number, duration: number) => void) | null = null;
  /** Host returns false when it can't place a zombie right now (field full). */
  onSpawnRequest: ((type: ZombieTypeId, scaling: WaveScaling) => boolean) | null = null;

  // -------------------------------------------------------------------------
  // Difficulty scaling
  // -------------------------------------------------------------------------

  get healthMultiplier(): number {
    return Math.pow(WAVES.healthScale, this.waveNumber - 1);
  }

  get speedMultiplier(): number {
    return Math.min(WAVES.maxSpeedScale, Math.pow(WAVES.speedScale, this.waveNumber - 1));
  }

  get damageMultiplier(): number {
    return Math.pow(WAVES.damageScale, this.waveNumber - 1);
  }

  /** 0..1 curve driving AI aggression, encirclement tightness and music. */
  get aggression(): number {
    return clamp01((this.waveNumber - 1) / 18);
  }

  get isBossWave(): boolean {
    return this.waveNumber > 0 && this.waveNumber % WAVES.bossEvery === 0;
  }

  private get scaling(): WaveScaling {
    return {
      health: this.healthMultiplier,
      speed: this.speedMultiplier,
      damage: this.damageMultiplier,
    };
  }

  // -------------------------------------------------------------------------
  // Flow control
  // -------------------------------------------------------------------------

  /** Starts a fresh run at wave 0, entering the first prep countdown. */
  begin(): void {
    this.waveNumber = 0;
    this.queue = [];
    this.spawnedThisWave = 0;
    this.totalThisWave = 0;
    this.aliveFromThisWave = 0;
    this.startPrep(WAVES.prepTimeFirst);
  }

  reset(): void {
    this.phase = 'idle';
    this.waveNumber = 0;
    this.queue = [];
    this.prepTimer = 0;
    this.spawnTimer = 0;
    this.spawnedThisWave = 0;
    this.totalThisWave = 0;
    this.aliveFromThisWave = 0;
  }

  private startPrep(duration: number): void {
    this.phase = 'prep';
    this.prepTimer = duration;
    this.onPrepStart?.(this.waveNumber + 1, duration);
  }

  /** Lets the player skip the remaining countdown from the shop. */
  skipPrep(): void {
    if (this.phase === 'prep') this.prepTimer = 0;
  }

  private startWave(): void {
    this.waveNumber++;
    this.phase = 'active';
    this.spawnedThisWave = 0;
    this.aliveFromThisWave = 0;

    this.queue = this.buildQueue(this.waveNumber);
    this.totalThisWave = this.queue.length;
    // First zombie arrives almost immediately so the wave has instant presence.
    this.spawnTimer = 0.4;

    this.onWaveStart?.(this.waveNumber, this.isBossWave, this.totalThisWave);
  }

  /**
   * Builds the spawn order for a wave.
   *
   * Composition rules:
   *  • Count grows super-linearly but is capped so the field never gridlocks.
   *  • Elite classes unlock at fixed waves, then their share ramps up.
   *  • Boss waves add one boss and trim the trash count to keep the frame
   *    budget and the fight readable.
   */
  private buildQueue(wave: number): ZombieTypeId[] {
    const rawCount =
      WAVES.baseCount + WAVES.countGrowth * Math.pow(wave, WAVES.countExponent);
    let count = Math.min(WAVES.maxCount, Math.round(rawCount));

    const boss = wave % WAVES.bossEvery === 0;
    if (boss) count = Math.round(count * 0.62);

    // Weighted pool of the classes unlocked at this wave.
    const pool: { type: ZombieTypeId; weight: number }[] = [
      { type: 'normal', weight: ZOMBIE_TYPES.normal.spawnWeight },
    ];
    if (wave >= WAVES.fastFromWave) {
      pool.push({
        type: 'fast',
        weight: ZOMBIE_TYPES.fast.spawnWeight * Math.min(1.8, 0.5 + wave * 0.08),
      });
    }
    if (wave >= WAVES.tankFromWave) {
      pool.push({
        type: 'tank',
        weight: ZOMBIE_TYPES.tank.spawnWeight * Math.min(1.6, 0.4 + wave * 0.06),
      });
    }
    if (wave >= WAVES.exploderFromWave) {
      pool.push({
        type: 'exploder',
        weight: ZOMBIE_TYPES.exploder.spawnWeight * Math.min(1.5, 0.35 + wave * 0.05),
      });
    }

    const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
    const queue: ZombieTypeId[] = [];

    for (let i = 0; i < count; i++) {
      let roll = Math.random() * totalWeight;
      let chosen: ZombieTypeId = 'normal';
      for (const entry of pool) {
        roll -= entry.weight;
        if (roll <= 0) {
          chosen = entry.type;
          break;
        }
      }
      queue.push(chosen);
    }

    // The boss leads the wave so the player meets it head-on rather than
    // discovering it behind a wall of trash forty seconds later.
    if (boss) queue.unshift('boss');

    return queue;
  }

  private get spawnInterval(): number {
    const interval =
      WAVES.baseSpawnInterval * Math.pow(WAVES.spawnIntervalDecay, this.waveNumber - 1);
    return Math.max(WAVES.minSpawnInterval, interval);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  update(dt: number, aliveCount: number, fieldHasRoom: boolean): void {
    switch (this.phase) {
      case 'prep': {
        this.prepTimer -= dt;
        if (this.prepTimer <= 0) this.startWave();
        break;
      }

      case 'active': {
        // Spawning.
        if (this.queue.length > 0) {
          this.spawnTimer -= dt;
          if (this.spawnTimer <= 0 && fieldHasRoom) {
            const type = this.queue[0];
            const placed = this.onSpawnRequest?.(type, this.scaling) ?? false;
            if (placed) {
              this.queue.shift();
              this.spawnedThisWave++;
              this.aliveFromThisWave++;
              this.spawnTimer = this.spawnInterval;
            } else {
              // Retry shortly rather than stalling the wave.
              this.spawnTimer = 0.25;
            }
          }
        }

        // Wave completes when the queue is empty and the field is clear.
        if (this.queue.length === 0 && aliveCount === 0) {
          this.phase = 'cleared';
          this.onWaveCleared?.(this.waveNumber);
          this.startPrep(WAVES.prepTime);
        }
        break;
      }

      case 'cleared':
      case 'idle':
      default:
        break;
    }
  }

  /** Called by the host whenever a zombie from this wave dies. */
  notifyKill(): void {
    this.aliveFromThisWave = Math.max(0, this.aliveFromThisWave - 1);
  }

  snapshot(aliveCount: number): WaveSnapshot {
    return {
      phase: this.phase,
      waveNumber: this.phase === 'prep' ? this.waveNumber + 1 : this.waveNumber,
      remaining: this.queue.length + aliveCount,
      totalThisWave: this.totalThisWave,
      prepRemaining: Math.max(0, this.prepTimer),
      isBossWave:
        this.phase === 'prep'
          ? (this.waveNumber + 1) % WAVES.bossEvery === 0
          : this.isBossWave,
      aggression: this.aggression,
    };
  }

  /** Picks a spawn point: far enough from the player to be fair, but not silly. */
  static chooseSpawnPoint(
    candidates: readonly THREE.Vector3[],
    playerPosition: THREE.Vector3,
    minDistance = 22,
    maxDistance = 70,
  ): THREE.Vector3 | null {
    if (candidates.length === 0) return null;

    const viable = candidates.filter((point) => {
      const distance = Math.hypot(point.x - playerPosition.x, point.z - playerPosition.z);
      return distance >= minDistance && distance <= maxDistance;
    });

    if (viable.length > 0) return pick(viable);

    // Fall back to the furthest point if nothing is in the ideal band.
    let best = candidates[0];
    let bestDistance = -1;
    for (const point of candidates) {
      const distance = Math.hypot(point.x - playerPosition.x, point.z - playerPosition.z);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
    return best;
  }
}

export interface WaveScaling {
  health: number;
  speed: number;
  damage: number;
}
