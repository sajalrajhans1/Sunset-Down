import type * as THREE from 'three';
import { el } from './dom';
import { WORLD } from '../game/Config';
import type { Zombie } from '../components/Zombie';

/**
 * Top-down radar.
 *
 * Drawn on a small 2D canvas rather than with a second camera: a render pass
 * would mean drawing the whole village twice, whereas this costs a few dozen
 * `arc` calls. It redraws at 20 Hz — fast enough to track a sprinter, slow
 * enough to be free.
 *
 * The map is *rotated with the player*, so *up* is always where you're facing.
 * That's the orientation people read fastest under pressure.
 */
export class Minimap {
  readonly root: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size = 168;
  private readonly range = 42;

  private redrawTimer = 0;
  private static readonly INTERVAL = 1 / 20;

  /** Per-class dot colours, matching how the zombies read in the world. */
  private static readonly CLASS_COLORS: Record<string, string> = {
    normal: '#8fce8a',
    fast: '#ff7a9c',
    tank: '#a98fe8',
    exploder: '#ffb03d',
    boss: '#ff4d5e',
  };

  constructor() {
    this.canvas = el('canvas', { className: 'sh-minimap__canvas' });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;

    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Minimap needs a 2D canvas context.');
    this.ctx = context;
    this.ctx.scale(dpr, dpr);

    this.root = el('div', {
      className: 'sh-minimap',
      attrs: { 'aria-hidden': 'true' },
      children: [
        this.canvas,
        el('div', { className: 'sh-minimap__ring' }),
        el('div', { className: 'sh-minimap__label', text: 'N' }),
      ],
    });
  }

  update(
    dt: number,
    playerPosition: THREE.Vector3,
    playerYaw: number,
    zombies: readonly Zombie[],
  ): void {
    this.redrawTimer -= dt;
    if (this.redrawTimer > 0) return;
    this.redrawTimer = Minimap.INTERVAL;
    this.draw(playerPosition, playerYaw, zombies);
  }

  private draw(player: THREE.Vector3, yaw: number, zombies: readonly Zombie[]): void {
    const { ctx } = this;
    const half = this.size / 2;
    const scale = half / this.range;

    ctx.clearRect(0, 0, this.size, this.size);

    // Circular clip so nothing spills outside the bezel.
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(14, 8, 24, 0.72)';
    ctx.fillRect(0, 0, this.size, this.size);

    // World is rotated so the player's facing points up the screen.
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(yaw);

    // --- Static reference: plaza ring and map bounds ----------------------
    ctx.strokeStyle = 'rgba(255, 200, 120, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(-player.x * scale, -player.z * scale, 19 * scale, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 200, 120, 0.16)';
    ctx.strokeRect(
      (-WORLD.halfSize - player.x) * scale,
      (-WORLD.halfSize - player.z) * scale,
      WORLD.halfSize * 2 * scale,
      WORLD.halfSize * 2 * scale,
    );

    // --- Zombies -----------------------------------------------------------
    for (const zombie of zombies) {
      if (!zombie.isAlive) continue;
      const dx = zombie.position.x - player.x;
      const dz = zombie.position.z - player.z;
      const distance = Math.hypot(dx, dz);
      if (distance > this.range * 1.35) continue;

      const x = dx * scale;
      const y = dz * scale;
      const isBoss = zombie.def.isBoss;
      const radius = isBoss ? 6 : zombie.def.id === 'tank' ? 4.5 : 3.2;

      // Contacts outside the radar edge clamp to the rim as a chevron, so you
      // still know which way the pressure is coming from.
      const edge = half - 6;
      const clamped = distance * scale > edge;
      const px = clamped ? (x / (distance * scale)) * edge : x;
      const py = clamped ? (y / (distance * scale)) * edge : y;

      ctx.fillStyle = Minimap.CLASS_COLORS[zombie.def.id] ?? '#8fce8a';
      ctx.globalAlpha = clamped ? 0.5 : 1;
      ctx.beginPath();
      ctx.arc(px, py, clamped ? 2.2 : radius, 0, Math.PI * 2);
      ctx.fill();

      if (isBoss && !clamped) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // --- Player: fixed at centre, always pointing up -----------------------
    // Vision cone first, so the arrow sits on top of it.
    ctx.fillStyle = 'rgba(255, 220, 150, 0.16)';
    ctx.beginPath();
    ctx.moveTo(half, half);
    ctx.arc(half, half, 30, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#fff6e0';
    ctx.beginPath();
    ctx.moveTo(half, half - 6.5);
    ctx.lineTo(half + 4.5, half + 5);
    ctx.lineTo(half, half + 2.5);
    ctx.lineTo(half - 4.5, half + 5);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }
}
