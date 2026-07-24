import type { CollisionWorld } from './CollisionWorld';
import { WORLD } from '../game/Config';

/**
 * Flow-field pathfinding.
 *
 * Classic per-agent A* would mean 50+ independent searches every time the
 * player moves. Instead we run a *single* Dijkstra expansion outward from the
 * player across a coarse grid, then every zombie simply reads the precomputed
 * downhill direction from the cell it stands in.
 *
 * Cost: one ~7k-cell flood fill a few times per second, regardless of how many
 * zombies are alive. Each zombie's per-frame navigation is then two array reads.
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;

  /** 1 = impassable. */
  private readonly blocked: Uint8Array;
  /** Extra traversal cost near walls, so agents hug corners less. */
  private readonly clearanceCost: Float32Array;
  /** Integrated distance-to-player field. */
  private readonly distance: Float32Array;
  /** Normalised downhill direction per cell. */
  private readonly dirX: Float32Array;
  private readonly dirZ: Float32Array;

  /** Bucket queue for the Dijkstra expansion — avoids per-frame allocation. */
  private readonly queue: Int32Array;

  private targetCell = -1;
  private hasField = false;

  constructor(cellSize = WORLD.navCellSize) {
    this.cellSize = cellSize;
    const span = WORLD.halfSize * 2;
    this.cols = Math.ceil(span / cellSize);
    this.rows = this.cols;
    this.originX = -WORLD.halfSize;
    this.originZ = -WORLD.halfSize;

    const total = this.cols * this.rows;
    this.blocked = new Uint8Array(total);
    this.clearanceCost = new Float32Array(total);
    this.distance = new Float32Array(total);
    this.dirX = new Float32Array(total);
    this.dirZ = new Float32Array(total);
    this.queue = new Int32Array(total);
  }

  private index(cx: number, cz: number): number {
    return cz * this.cols + cx;
  }

  cellOf(x: number, z: number): { cx: number; cz: number } {
    return {
      cx: Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.originX) / this.cellSize))),
      cz: Math.max(0, Math.min(this.rows - 1, Math.floor((z - this.originZ) / this.cellSize))),
    };
  }

  /**
   * Bakes static geometry into the grid. Cells are tested with a generous agent
   * radius so zombies never clip a wall corner, and a soft "clearance" penalty
   * is spread one ring outward to bias paths toward open ground.
   */
  bake(collision: CollisionWorld, agentRadius = 0.62): void {
    this.blocked.fill(0);
    this.clearanceCost.fill(0);

    const half = this.cellSize * 0.5;
    for (let cz = 0; cz < this.rows; cz++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const x = this.originX + cx * this.cellSize + half;
        const z = this.originZ + cz * this.cellSize + half;
        // Test at knee height: props tall enough to matter block, kerbs don't.
        if (collision.isBlocked(x, z, agentRadius, 0.55)) {
          this.blocked[this.index(cx, cz)] = 1;
        }
      }
    }

    // Propagate a two-ring clearance penalty around every blocked cell.
    for (let cz = 0; cz < this.rows; cz++) {
      for (let cx = 0; cx < this.cols; cx++) {
        if (!this.blocked[this.index(cx, cz)]) continue;
        for (let oz = -2; oz <= 2; oz++) {
          for (let ox = -2; ox <= 2; ox++) {
            const nx = cx + ox;
            const nz = cz + oz;
            if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
            const i = this.index(nx, nz);
            if (this.blocked[i]) continue;
            const ring = Math.max(Math.abs(ox), Math.abs(oz));
            const penalty = ring === 1 ? 2.4 : 0.8;
            if (penalty > this.clearanceCost[i]) this.clearanceCost[i] = penalty;
          }
        }
      }
    }
  }

  isCellBlocked(x: number, z: number): boolean {
    const { cx, cz } = this.cellOf(x, z);
    return this.blocked[this.index(cx, cz)] === 1;
  }

  /**
   * Dijkstra expansion from the target. Uses a simple sorted-insert-free
   * approach: because edge costs are small and bounded, a plain FIFO with
   * relaxation converges quickly and stays allocation-free.
   */
  computeField(targetX: number, targetZ: number): void {
    const { cx: tx, cz: tz } = this.cellOf(targetX, targetZ);
    let target = this.index(tx, tz);

    // If the player stands inside geometry (shouldn't happen, but be safe),
    // fall back to the nearest open cell so the field is still usable.
    if (this.blocked[target]) {
      const found = this.findNearestOpen(tx, tz);
      if (found < 0) {
        this.hasField = false;
        return;
      }
      target = found;
    }

    this.targetCell = target;
    this.distance.fill(Number.POSITIVE_INFINITY);
    this.distance[target] = 0;

    const queue = this.queue;
    let head = 0;
    let tail = 0;
    queue[tail++] = target;
    const capacity = queue.length;

    const straight = this.cellSize;
    const diagonal = this.cellSize * Math.SQRT2;

    while (head !== tail) {
      const current = queue[head++];
      if (head >= capacity) head = 0;
      const cd = this.distance[current];
      const ccx = current % this.cols;
      const ccz = (current / this.cols) | 0;

      for (let oz = -1; oz <= 1; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oz === 0) continue;
          const nx = ccx + ox;
          const nz = ccz + oz;
          if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
          const ni = this.index(nx, nz);
          if (this.blocked[ni]) continue;

          // Disallow cutting a diagonal between two blocked orthogonals.
          if (ox !== 0 && oz !== 0) {
            if (this.blocked[this.index(ccx + ox, ccz)] || this.blocked[this.index(ccx, ccz + oz)]) continue;
          }

          const step = ox !== 0 && oz !== 0 ? diagonal : straight;
          const nd = cd + step + this.clearanceCost[ni];
          if (nd + 1e-4 < this.distance[ni]) {
            this.distance[ni] = nd;
            queue[tail++] = ni;
            if (tail >= capacity) tail = 0;
            // Ring buffer overflow guard: bail rather than corrupt the field.
            if (tail === head) {
              this.buildDirections();
              this.hasField = true;
              return;
            }
          }
        }
      }
    }

    this.buildDirections();
    this.hasField = true;
  }

  private findNearestOpen(cx: number, cz: number): number {
    for (let radius = 1; radius < 12; radius++) {
      for (let oz = -radius; oz <= radius; oz++) {
        for (let ox = -radius; ox <= radius; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oz)) !== radius) continue;
          const nx = cx + ox;
          const nz = cz + oz;
          if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
          const i = this.index(nx, nz);
          if (!this.blocked[i]) return i;
        }
      }
    }
    return -1;
  }

  /** Converts the scalar distance field into a normalised gradient per cell. */
  private buildDirections(): void {
    for (let cz = 0; cz < this.rows; cz++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const i = this.index(cx, cz);
        if (this.blocked[i] || !Number.isFinite(this.distance[i])) {
          this.dirX[i] = 0;
          this.dirZ[i] = 0;
          continue;
        }

        let bestScore = this.distance[i];
        let bx = 0;
        let bz = 0;
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oz === 0) continue;
            const nx = cx + ox;
            const nz = cz + oz;
            if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
            const ni = this.index(nx, nz);
            if (this.blocked[ni]) continue;
            const d = this.distance[ni];
            if (d < bestScore) {
              bestScore = d;
              bx = ox;
              bz = oz;
            }
          }
        }
        const len = Math.hypot(bx, bz);
        if (len > 0) {
          this.dirX[i] = bx / len;
          this.dirZ[i] = bz / len;
        } else {
          this.dirX[i] = 0;
          this.dirZ[i] = 0;
        }
      }
    }
  }

  /**
   * Samples the flow direction at a world position with bilinear smoothing, so
   * agents curve through the field instead of snapping between 8 directions.
   */
  sampleDirection(x: number, z: number, out: { x: number; z: number }): boolean {
    if (!this.hasField) {
      out.x = 0;
      out.z = 0;
      return false;
    }

    const fx = (x - this.originX) / this.cellSize - 0.5;
    const fz = (z - this.originZ) / this.cellSize - 0.5;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;

    let sumX = 0;
    let sumZ = 0;
    let sumW = 0;

    for (let oz = 0; oz <= 1; oz++) {
      for (let ox = 0; ox <= 1; ox++) {
        const nx = x0 + ox;
        const nz = z0 + oz;
        if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
        const i = this.index(nx, nz);
        if (this.blocked[i]) continue;
        const w = (ox ? tx : 1 - tx) * (oz ? tz : 1 - tz);
        if (w <= 0) continue;
        sumX += this.dirX[i] * w;
        sumZ += this.dirZ[i] * w;
        sumW += w;
      }
    }

    if (sumW <= 1e-5) {
      // Standing in or beside geometry — fall back to the nearest cell's vector.
      const { cx, cz } = this.cellOf(x, z);
      const i = this.index(cx, cz);
      out.x = this.dirX[i];
      out.z = this.dirZ[i];
      return out.x !== 0 || out.z !== 0;
    }

    const len = Math.hypot(sumX, sumZ);
    if (len < 1e-5) {
      out.x = 0;
      out.z = 0;
      return false;
    }
    out.x = sumX / len;
    out.z = sumZ / len;
    return true;
  }

  /** Path distance from a world position back to the field target, in metres. */
  distanceAt(x: number, z: number): number {
    if (!this.hasField) return Number.POSITIVE_INFINITY;
    const { cx, cz } = this.cellOf(x, z);
    return this.distance[this.index(cx, cz)];
  }

  /** True when a spawn point can actually reach the player. */
  isReachable(x: number, z: number): boolean {
    return Number.isFinite(this.distanceAt(x, z));
  }

  get targetIndex(): number {
    return this.targetCell;
  }
}
