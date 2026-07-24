import * as THREE from 'three';
import { Easing } from '../utilities/Easing';
import { randRange } from '../utilities/MathUtils';

export type DamageNumberStyle = 'normal' | 'critical' | 'headshot' | 'kill' | 'coins' | 'player';

interface FloatingNumber {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  life: number;
  maxLife: number;
  velocity: THREE.Vector3;
  origin: THREE.Vector3;
  baseScale: number;
  active: boolean;
}

const STYLES: Record<DamageNumberStyle, { fill: string; stroke: string; scale: number; prefix: string }> = {
  normal: { fill: '#fff4dd', stroke: 'rgba(58,32,44,0.9)', scale: 1, prefix: '' },
  critical: { fill: '#ffd54a', stroke: 'rgba(120,44,10,0.95)', scale: 1.45, prefix: '' },
  headshot: { fill: '#ff8f5c', stroke: 'rgba(96,24,24,0.95)', scale: 1.3, prefix: '' },
  kill: { fill: '#8fffc4', stroke: 'rgba(12,72,48,0.95)', scale: 1.35, prefix: '' },
  coins: { fill: '#ffd782', stroke: 'rgba(96,58,10,0.9)', scale: 1.05, prefix: '+' },
  player: { fill: '#ff6b7a', stroke: 'rgba(90,12,24,0.95)', scale: 1.2, prefix: '-' },
};

/**
 * Floating combat text.
 *
 * Each number is a pooled sprite backed by its own small canvas. Redrawing a
 * short string costs well under a tenth of a millisecond, and the pool is
 * capped, so the worst case is bounded no matter how fast the player is
 * killing things.
 */
export class DamageNumbers {
  readonly group = new THREE.Group();

  private readonly pool: FloatingNumber[] = [];
  private cursor = 0;
  private readonly canvasSize = 128;

  constructor(capacity = 26) {
    this.group.name = 'DamageNumbers';
    for (let i = 0; i < capacity; i++) this.pool.push(this.createEntry());
  }

  private createEntry(): FloatingNumber {
    const canvas = document.createElement('canvas');
    canvas.width = this.canvasSize;
    canvas.height = this.canvasSize / 2;
    const ctx = canvas.getContext('2d')!;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 0,
      fog: false,
    });

    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 30;
    this.group.add(sprite);

    return {
      sprite,
      material,
      texture,
      canvas,
      ctx,
      life: 0,
      maxLife: 1,
      velocity: new THREE.Vector3(),
      origin: new THREE.Vector3(),
      baseScale: 1,
      active: false,
    };
  }

  /** Spawns a number at a world position. */
  spawn(position: THREE.Vector3, value: number, style: DamageNumberStyle = 'normal'): void {
    const entry = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;

    const config = STYLES[style];
    const text = `${config.prefix}${Math.max(1, Math.round(value))}`;
    this.drawText(entry, text, config.fill, config.stroke);

    entry.origin.copy(position);
    // Random lateral drift so simultaneous hits don't stack into one blob.
    entry.velocity.set(randRange(-0.9, 0.9), randRange(2.6, 3.6), randRange(-0.9, 0.9));
    entry.maxLife = style === 'kill' || style === 'critical' ? 1.15 : 0.85;
    entry.life = entry.maxLife;
    entry.baseScale = config.scale * (style === 'coins' ? 0.4 : 0.5);
    entry.active = true;
    entry.sprite.visible = true;
    entry.sprite.position.copy(position);
    entry.sprite.scale.setScalar(entry.baseScale);
    entry.material.opacity = 1;
  }

  private drawText(entry: FloatingNumber, text: string, fill: string, stroke: string): void {
    const { ctx, canvas } = entry;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Auto-shrink so four-digit boss damage still fits the sprite.
    let fontSize = 42;
    do {
      ctx.font = `800 ${fontSize}px "Baloo 2", "Trebuchet MS", sans-serif`;
      if (ctx.measureText(text).width <= w - 14) break;
      fontSize -= 3;
    } while (fontSize > 14);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Drop shadow, heavy outline, then fill — reads at any distance.
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.lineWidth = Math.max(4, fontSize * 0.2);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, w / 2, h / 2);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = fill;
    ctx.fillText(text, w / 2, h / 2);

    entry.texture.needsUpdate = true;
  }

  update(dt: number): void {
    for (const entry of this.pool) {
      if (!entry.active) continue;

      entry.life -= dt;
      if (entry.life <= 0) {
        entry.active = false;
        entry.sprite.visible = false;
        entry.material.opacity = 0;
        continue;
      }

      const t = 1 - entry.life / entry.maxLife;

      // Arc upward, decelerating.
      entry.velocity.y -= 4.2 * dt;
      entry.velocity.x *= 1 - 1.8 * dt;
      entry.velocity.z *= 1 - 1.8 * dt;
      entry.origin.addScaledVector(entry.velocity, dt);
      entry.sprite.position.copy(entry.origin);

      // Pop in, hold, then shrink and fade.
      const pop = t < 0.18 ? Easing.backOut(t / 0.18) : 1;
      const shrink = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      entry.sprite.scale.setScalar(entry.baseScale * pop * (0.7 + shrink * 0.3));
      entry.material.opacity = t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1;
    }
  }

  clear(): void {
    for (const entry of this.pool) {
      entry.active = false;
      entry.sprite.visible = false;
      entry.material.opacity = 0;
    }
  }

  dispose(): void {
    for (const entry of this.pool) {
      entry.texture.dispose();
      entry.material.dispose();
    }
    this.pool.length = 0;
    this.group.clear();
  }
}
