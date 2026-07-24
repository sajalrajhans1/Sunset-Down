/**
 * Low-level 2D canvas helpers shared by every procedural texture generator.
 * Nothing here touches Three.js so the routines stay unit-testable.
 */

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  size: number;
}

export function makeCanvas(size: number): Canvas2D {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable — cannot build procedural textures.');
  return { canvas, ctx, size };
}

export function rgb(r: number, g: number, b: number): string {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

/** Converts a 0xRRGGBB int into its channel components. */
export function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

export function shade(hex: number, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = 1 + amount;
  return rgb(Math.min(255, r * f), Math.min(255, g * f), Math.min(255, b * f));
}

/** Fills the canvas with a vertical two-stop gradient. */
export function fillVerticalGradient(c: Canvas2D, top: string, bottom: string): void {
  const g = c.ctx.createLinearGradient(0, 0, 0, c.size);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  c.ctx.fillStyle = g;
  c.ctx.fillRect(0, 0, c.size, c.size);
}

/**
 * Scatters soft blobs across the canvas. Draws each blob nine times (3x3 offset
 * grid) so the resulting texture tiles seamlessly.
 */
export function scatterBlobs(
  c: Canvas2D,
  count: number,
  radiusMin: number,
  radiusMax: number,
  colorAt: (i: number) => string,
  alpha = 0.5,
): void {
  const { ctx, size } = c;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = radiusMin + Math.random() * (radiusMax - radiusMin);
    ctx.fillStyle = colorAt(i);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const px = x + ox * size;
        const py = y + oy * size;
        if (px < -r || px > size + r || py < -r || py > size + r) continue;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** Adds per-pixel monochrome grain. Cheap way to kill flat plastic surfaces. */
export function addGrain(c: Canvas2D, strength: number): void {
  const img = c.ctx.getImageData(0, 0, c.size, c.size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * strength;
    d[i] = clampByte(d[i] + n);
    d[i + 1] = clampByte(d[i + 1] + n);
    d[i + 2] = clampByte(d[i + 2] + n);
  }
  c.ctx.putImageData(img, 0, 0);
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Derives a tangent-space normal map from a canvas' luminance using a Sobel
 * filter. Wraps at the edges so tiling textures keep continuous normals.
 */
export function normalMapFromCanvas(source: Canvas2D, strength = 2.2): Canvas2D {
  const { size } = source;
  const src = source.ctx.getImageData(0, 0, size, size).data;
  const out = makeCanvas(size);
  const img = out.ctx.createImageData(size, size);
  const d = img.data;

  const lum = new Float32Array(size * size);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = (src[p] * 0.299 + src[p + 1] * 0.587 + src[p + 2] * 0.114) / 255;
  }

  const sample = (x: number, y: number): number => lum[(y & (size - 1)) * size + (x & (size - 1))];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = sample(x - 1, y - 1);
      const t = sample(x, y - 1);
      const tr = sample(x + 1, y - 1);
      const l = sample(x - 1, y);
      const r = sample(x + 1, y);
      const bl = sample(x - 1, y + 1);
      const b = sample(x, y + 1);
      const br = sample(x + 1, y + 1);

      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);

      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;

      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  out.ctx.putImageData(img, 0, 0);
  return out;
}

/**
 * Deterministic jittered-grid cellular pattern. Returns, for every pixel, the
 * distance to the nearest feature point and that point's id — the basis for
 * cobblestones, cracked paint and stylized rock.
 */
export function cellularPattern(
  size: number,
  cells: number,
  jitter: number,
  seedFn: () => number,
): { dist: Float32Array; edge: Float32Array; id: Int32Array } {
  const cellSize = size / cells;
  const points = new Float32Array(cells * cells * 2);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = (cy * cells + cx) * 2;
      points[i] = (cx + 0.5 + (seedFn() - 0.5) * jitter) * cellSize;
      points[i + 1] = (cy + 0.5 + (seedFn() - 0.5) * jitter) * cellSize;
    }
  }

  const dist = new Float32Array(size * size);
  const edge = new Float32Array(size * size);
  const id = new Int32Array(size * size);

  for (let y = 0; y < size; y++) {
    const cy = Math.floor(y / cellSize);
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cellSize);
      let best = Infinity;
      let second = Infinity;
      let bestId = 0;

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          // Wrap cell indices so the pattern tiles.
          const gx = (cx + ox + cells) % cells;
          const gy = (cy + oy + cells) % cells;
          const pi = (gy * cells + gx) * 2;
          // Offset the wrapped point back into local space.
          const px = points[pi] + (cx + ox < 0 ? -size : cx + ox >= cells ? size : 0);
          const py = points[pi + 1] + (cy + oy < 0 ? -size : cy + oy >= cells ? size : 0);
          const dd = (px - x) * (px - x) + (py - y) * (py - y);
          if (dd < best) {
            second = best;
            best = dd;
            bestId = gy * cells + gx;
          } else if (dd < second) {
            second = dd;
          }
        }
      }
      const i = y * size + x;
      dist[i] = Math.sqrt(best) / cellSize;
      edge[i] = (Math.sqrt(second) - Math.sqrt(best)) / cellSize;
      id[i] = bestId;
    }
  }
  return { dist, edge, id };
}

/** Draws centred text that automatically shrinks to fit the canvas width. */
export function drawFittedText(
  c: Canvas2D,
  text: string,
  y: number,
  maxWidth: number,
  font: string,
  fill: string,
  stroke?: string,
): void {
  const { ctx } = c;
  let fontSize = c.size * 0.22;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  do {
    ctx.font = `${font} ${fontSize}px "Baloo 2", "Trebuchet MS", sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    fontSize -= 2;
  } while (fontSize > 8);

  if (stroke) {
    ctx.lineWidth = Math.max(3, fontSize * 0.14);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, c.size / 2, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, c.size / 2, y);
}
