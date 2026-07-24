import * as THREE from 'three';
import {
  addGrain,
  cellularPattern,
  drawFittedText,
  fillVerticalGradient,
  hexToRgb,
  makeCanvas,
  normalMapFromCanvas,
  rgb,
  rgba,
  scatterBlobs,
  shade,
  type Canvas2D,
} from './CanvasUtils';
import { mulberry32 } from '../utilities/MathUtils';

/**
 * Every texture in the game is drawn at runtime on a 2D canvas. This keeps the
 * download tiny, lets materials be re-tinted for free, and avoids any asset
 * pipeline. Textures are generated lazily and cached by key.
 */
class TextureLibrary {
  private readonly cache = new Map<string, THREE.Texture>();
  private anisotropy = 4;

  setAnisotropy(value: number): void {
    this.anisotropy = value;
    for (const tex of this.cache.values()) {
      tex.anisotropy = value;
      tex.needsUpdate = true;
    }
  }

  /** Memoised texture creation — the factory only runs on a cache miss. */
  get(key: string, factory: () => THREE.Texture): THREE.Texture {
    const existing = this.cache.get(key);
    if (existing) return existing;
    const created = factory();
    created.anisotropy = this.anisotropy;
    this.cache.set(key, created);
    return created;
  }

  dispose(): void {
    for (const tex of this.cache.values()) tex.dispose();
    this.cache.clear();
  }
}

export const textureLibrary = new TextureLibrary();

function toTexture(
  c: Canvas2D,
  options: {
    repeat?: number;
    srgb?: boolean;
    wrap?: THREE.Wrapping;
    generateMipmaps?: boolean;
  } = {},
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c.canvas);
  const wrap = options.wrap ?? THREE.RepeatWrapping;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  if (options.repeat) tex.repeat.set(options.repeat, options.repeat);
  tex.colorSpace = options.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;

  // Clamped textures are our sprites and decals: a shape surrounded by fully
  // transparent pixels, which canvas stores as *black* with alpha 0. Mipmapping
  // averages that black RGB into the visible edges, so as the quad shrinks on
  // screen it collapses into a uniform dark square — the classic "black box"
  // artifact. Tiling surface textures have no transparency and keep their mips.
  const spriteLike = wrap === THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = options.generateMipmaps ?? !spriteLike;
  tex.minFilter = tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Ground & terrain
// ---------------------------------------------------------------------------

function buildGrassCanvas(size = 512): Canvas2D {
  const c = makeCanvas(size);
  const rand = mulberry32(9001);

  // Warm, sun-kissed base so the grass reads as golden hour rather than noon.
  fillVerticalGradient(c, rgb(118, 158, 78), rgb(92, 132, 62));

  // Broad tonal patches give the illusion of large-scale variation.
  scatterBlobs(c, 34, size * 0.08, size * 0.24, () => {
    const t = rand();
    return t < 0.4 ? rgb(138, 174, 88) : t < 0.75 ? rgb(102, 142, 70) : rgb(150, 160, 74);
  }, 0.35);

  // Dry patches / trodden earth.
  scatterBlobs(c, 14, size * 0.03, size * 0.09, () => rgb(158, 136, 82), 0.28);

  // Individual blades: short tapered strokes in varied greens.
  const { ctx } = c;
  ctx.lineCap = 'round';
  for (let i = 0; i < size * 9; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 2 + rand() * 5;
    const lean = (rand() - 0.5) * 3;
    const t = rand();
    ctx.strokeStyle =
      t < 0.35
        ? rgba(158, 196, 96, 0.55)
        : t < 0.7
          ? rgba(88, 126, 58, 0.5)
          : rgba(196, 208, 108, 0.4);
    ctx.lineWidth = 0.8 + rand() * 1.1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + lean, y - len);
    ctx.stroke();
  }

  // Scattered clover / tiny flowers for the storybook feel.
  for (let i = 0; i < 220; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const t = rand();
    ctx.fillStyle = t < 0.5 ? rgba(255, 236, 168, 0.85) : t < 0.8 ? rgba(255, 190, 210, 0.8) : rgba(190, 220, 255, 0.7);
    ctx.beginPath();
    ctx.arc(x, y, 1 + rand() * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  addGrain(c, 12);
  return c;
}

export function grassTexture(): THREE.Texture {
  return textureLibrary.get('grass', () => toTexture(buildGrassCanvas(512), { repeat: 26 }));
}

export function grassNormalTexture(): THREE.Texture {
  return textureLibrary.get('grass-n', () => {
    const n = normalMapFromCanvas(buildGrassCanvas(256), 1.4);
    return toTexture(n, { repeat: 26, srgb: false });
  });
}

function buildCobbleCanvas(size = 512): Canvas2D {
  const c = makeCanvas(size);
  const rand = mulberry32(4242);
  const { ctx } = c;

  ctx.fillStyle = rgb(96, 84, 78);
  ctx.fillRect(0, 0, size, size);

  const cells = 14;
  const { dist, edge, id } = cellularPattern(size, cells, 0.85, rand);

  // Per-stone colour palette in warm dusty tones.
  const stoneColors: [number, number, number][] = [];
  for (let i = 0; i < cells * cells; i++) {
    const t = rand();
    const base = t < 0.3 ? [186, 168, 152] : t < 0.6 ? [166, 148, 136] : t < 0.85 ? [200, 178, 156] : [148, 138, 134];
    const v = (rand() - 0.5) * 18;
    stoneColors.push([base[0] + v, base[1] + v, base[2] + v]);
  }

  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < dist.length; i++) {
    const col = stoneColors[id[i]];
    // `edge` approaches 0 at the boundary between two stones -> mortar gap.
    const gap = Math.min(1, edge[i] / 0.14);
    // Dome the stone slightly so the derived normal map bulges outward.
    const dome = 1 - Math.min(1, dist[i] * 0.75) * 0.28;
    const mortar = 0.35 + gap * 0.65;
    const p = i * 4;
    d[p] = col[0] * dome * mortar + 70 * (1 - mortar);
    d[p + 1] = col[1] * dome * mortar + 62 * (1 - mortar);
    d[p + 2] = col[2] * dome * mortar + 58 * (1 - mortar);
    d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Moss creeping in the joints keeps it from looking sterile.
  scatterBlobs(c, 30, 4, 16, () => rgba(112, 148, 82, 1), 0.2);
  addGrain(c, 16);
  return c;
}

export function cobbleTexture(): THREE.Texture {
  return textureLibrary.get('cobble', () => toTexture(buildCobbleCanvas(512), { repeat: 9 }));
}

export function cobbleNormalTexture(): THREE.Texture {
  return textureLibrary.get('cobble-n', () => {
    const n = normalMapFromCanvas(buildCobbleCanvas(256), 3.2);
    return toTexture(n, { repeat: 9, srgb: false });
  });
}

export function dirtPathTexture(): THREE.Texture {
  return textureLibrary.get('dirt', () => {
    const c = makeCanvas(256);
    const rand = mulberry32(77);
    fillVerticalGradient(c, rgb(164, 134, 96), rgb(140, 112, 80));
    scatterBlobs(c, 40, 6, 30, () => (rand() < 0.5 ? rgb(178, 148, 108) : rgb(126, 100, 72)), 0.4);
    scatterBlobs(c, 60, 1, 3, () => rgb(96, 78, 60), 0.5);
    addGrain(c, 18);
    return toTexture(c, { repeat: 12 });
  });
}

// ---------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------

export function plasterTexture(color: number): THREE.Texture {
  return textureLibrary.get(`plaster-${color.toString(16)}`, () => {
    const c = makeCanvas(256);
    const rand = mulberry32(color >>> 3);
    const [r, g, b] = hexToRgb(color);
    c.ctx.fillStyle = rgb(r, g, b);
    c.ctx.fillRect(0, 0, 256, 256);

    // Soft mottling reproduces the hand-painted look of stylised plaster.
    scatterBlobs(c, 46, 8, 44, () => (rand() < 0.5 ? shade(color, 0.09) : shade(color, -0.09)), 0.22);

    // Occasional chips exposing the render underneath.
    for (let i = 0; i < 24; i++) {
      const x = rand() * 256;
      const y = rand() * 256;
      c.ctx.fillStyle = rgba(r * 0.72, g * 0.7, b * 0.68, 0.35);
      c.ctx.beginPath();
      c.ctx.ellipse(x, y, 2 + rand() * 7, 2 + rand() * 5, rand() * Math.PI, 0, Math.PI * 2);
      c.ctx.fill();
    }
    addGrain(c, 9);
    return toTexture(c, { repeat: 1 });
  });
}

export function woodPlankTexture(color: number, planks = 6): THREE.Texture {
  return textureLibrary.get(`wood-${color.toString(16)}-${planks}`, () => {
    const size = 256;
    const c = makeCanvas(size);
    const rand = mulberry32((color >>> 2) + planks);
    const { ctx } = c;
    const [r, g, b] = hexToRgb(color);
    ctx.fillStyle = rgb(r, g, b);
    ctx.fillRect(0, 0, size, size);

    const plankH = size / planks;
    for (let i = 0; i < planks; i++) {
      const y = i * plankH;
      const v = (rand() - 0.5) * 26;
      ctx.fillStyle = rgb(r + v, g + v * 0.9, b + v * 0.8);
      ctx.fillRect(0, y, size, plankH);

      // Grain lines: gently wavering horizontal strokes.
      ctx.strokeStyle = rgba(r * 0.68, g * 0.64, b * 0.6, 0.35);
      for (let k = 0; k < 7; k++) {
        const gy = y + 3 + rand() * (plankH - 6);
        ctx.lineWidth = 0.6 + rand() * 1.1;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        for (let x = 0; x <= size; x += 16) {
          ctx.lineTo(x, gy + Math.sin(x * 0.05 + i) * 1.6 + (rand() - 0.5) * 1.2);
        }
        ctx.stroke();
      }

      // Knots.
      if (rand() < 0.45) {
        const kx = rand() * size;
        const ky = y + plankH * 0.5;
        const kr = 2 + rand() * 3;
        ctx.strokeStyle = rgba(r * 0.55, g * 0.5, b * 0.46, 0.6);
        for (let ring = 0; ring < 3; ring++) {
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(kx, ky, kr + ring * 1.8, kr * 0.7 + ring * 1.2, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Shadow gap between boards.
      ctx.fillStyle = rgba(0, 0, 0, 0.28);
      ctx.fillRect(0, y, size, 1.5);
      ctx.fillStyle = rgba(255, 255, 255, 0.12);
      ctx.fillRect(0, y + 2, size, 1);
    }
    addGrain(c, 10);
    return toTexture(c, { repeat: 1 });
  });
}

export function shingleTexture(color: number): THREE.Texture {
  return textureLibrary.get(`shingle-${color.toString(16)}`, () => {
    const size = 256;
    const c = makeCanvas(size);
    const rand = mulberry32(color ^ 0x5f);
    const { ctx } = c;
    const [r, g, b] = hexToRgb(color);
    ctx.fillStyle = rgb(r * 0.75, g * 0.75, b * 0.75);
    ctx.fillRect(0, 0, size, size);

    const rows = 8;
    const cols = 6;
    const h = size / rows;
    const w = size / cols;
    for (let row = 0; row < rows; row++) {
      const offset = (row % 2) * (w / 2);
      for (let col = -1; col <= cols; col++) {
        const x = col * w + offset;
        const y = row * h;
        const v = (rand() - 0.5) * 30;
        ctx.fillStyle = rgb(r + v, g + v, b + v);
        // Rounded scallop tiles read as friendly storybook roofing.
        ctx.beginPath();
        ctx.moveTo(x + 1, y);
        ctx.lineTo(x + w - 1, y);
        ctx.lineTo(x + w - 1, y + h * 0.45);
        ctx.quadraticCurveTo(x + w / 2, y + h * 1.15, x + 1, y + h * 0.45);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = rgba(0, 0, 0, 0.22);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
    addGrain(c, 8);
    return toTexture(c, { repeat: 1 });
  });
}

export function shingleNormalTexture(color: number): THREE.Texture {
  return textureLibrary.get(`shingle-n-${color.toString(16)}`, () => {
    const src = shingleTexture(color) as THREE.CanvasTexture;
    const image = src.image as HTMLCanvasElement;
    const wrapped: Canvas2D = {
      canvas: image,
      ctx: image.getContext('2d') as CanvasRenderingContext2D,
      size: image.width,
    };
    return toTexture(normalMapFromCanvas(wrapped, 2.4), { srgb: false });
  });
}

/** Candy-striped canvas used for carnival tents and awnings. */
export function stripeTexture(colorA: number, colorB: number, stripes = 8): THREE.Texture {
  return textureLibrary.get(`stripe-${colorA.toString(16)}-${colorB.toString(16)}-${stripes}`, () => {
    const size = 256;
    const c = makeCanvas(size);
    const { ctx } = c;
    const [ar, ag, ab] = hexToRgb(colorA);
    ctx.fillStyle = rgb(ar, ag, ab);
    ctx.fillRect(0, 0, size, size);
    const [br, bg, bb] = hexToRgb(colorB);
    ctx.fillStyle = rgb(br, bg, bb);
    const w = size / stripes;
    for (let i = 0; i < stripes; i += 2) ctx.fillRect(i * w, 0, w, size);

    // Fabric weave + soft shading so the stripes are not flat vector fills.
    ctx.globalAlpha = 0.12;
    for (let y = 0; y < size; y += 3) {
      ctx.fillStyle = y % 6 === 0 ? '#000' : '#fff';
      ctx.fillRect(0, y, size, 1);
    }
    ctx.globalAlpha = 1;
    addGrain(c, 7);
    return toTexture(c, { repeat: 1 });
  });
}

/** Warm window glow used as an emissive map on building windows. */
export function windowTexture(): THREE.Texture {
  return textureLibrary.get('window', () => {
    const size = 128;
    const c = makeCanvas(size);
    const { ctx } = c;
    ctx.fillStyle = rgb(58, 42, 66);
    ctx.fillRect(0, 0, size, size);

    const g = ctx.createRadialGradient(size * 0.5, size * 0.62, 4, size * 0.5, size * 0.5, size * 0.62);
    g.addColorStop(0, 'rgba(255,236,178,1)');
    g.addColorStop(0.55, 'rgba(255,190,110,0.85)');
    g.addColorStop(1, 'rgba(180,110,70,0.2)');
    ctx.fillStyle = g;
    ctx.fillRect(6, 6, size - 12, size - 12);

    // Muntin bars split the pane into a cosy four-light window.
    ctx.strokeStyle = 'rgba(48,32,40,0.9)';
    ctx.lineWidth = 7;
    ctx.strokeRect(6, 6, size - 12, size - 12);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(size / 2, 6);
    ctx.lineTo(size / 2, size - 6);
    ctx.moveTo(6, size / 2);
    ctx.lineTo(size - 6, size / 2);
    ctx.stroke();
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Hand-painted shop sign. Text is baked in so no font loading is required. */
export function signTexture(text: string, bg: number, fg: number): THREE.Texture {
  return textureLibrary.get(`sign-${text}-${bg}-${fg}`, () => {
    const size = 256;
    const c = makeCanvas(size);
    const { ctx } = c;
    const [r, g, b] = hexToRgb(bg);
    ctx.fillStyle = rgb(r, g, b);
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = rgba(255, 255, 255, 0.16);
    ctx.fillRect(0, 0, size, size * 0.45);

    ctx.strokeStyle = rgba(255, 246, 214, 0.85);
    ctx.lineWidth = 6;
    ctx.strokeRect(14, 46, size - 28, size - 92);

    const [fr, fg2, fb] = hexToRgb(fg);
    drawFittedText(c, text.toUpperCase(), size * 0.5, size - 60, '800', rgb(fr, fg2, fb), 'rgba(40,24,30,0.75)');
    addGrain(c, 10);
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

// ---------------------------------------------------------------------------
// Sprites: particles, decals, flashes
// ---------------------------------------------------------------------------

/** Soft radial falloff — the workhorse sprite for smoke, dust and glows. */
export function softCircleTexture(): THREE.Texture {
  return textureLibrary.get('soft-circle', () => {
    const size = 128;
    const c = makeCanvas(size);
    const g = c.ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.72)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.2)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.ctx.fillStyle = g;
    c.ctx.fillRect(0, 0, size, size);
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Four-point anime-style sparkle used for crits and coin pickups. */
export function sparkleTexture(): THREE.Texture {
  return textureLibrary.get('sparkle', () => {
    const size = 128;
    const c = makeCanvas(size);
    const { ctx } = c;
    const cx = size / 2;

    const glow = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx * 0.55);
    glow.addColorStop(0, 'rgba(255,255,255,0.95)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const long = cx * 0.94;
    const waist = cx * 0.1;
    ctx.moveTo(cx, cx - long);
    ctx.quadraticCurveTo(cx + waist, cx - waist, cx + long, cx);
    ctx.quadraticCurveTo(cx + waist, cx + waist, cx, cx + long);
    ctx.quadraticCurveTo(cx - waist, cx + waist, cx - long, cx);
    ctx.quadraticCurveTo(cx - waist, cx - waist, cx, cx - long);
    ctx.fill();
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Elongated spark streak for muzzle debris and impact sparks. */
export function sparkStreakTexture(): THREE.Texture {
  return textureLibrary.get('spark-streak', () => {
    const size = 64;
    const c = makeCanvas(size);
    const g = c.ctx.createLinearGradient(0, size / 2, size, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, 'rgba(255,246,210,0.9)');
    g.addColorStop(0.6, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,160,60,0)');
    c.ctx.fillStyle = g;
    c.ctx.fillRect(0, size * 0.42, size, size * 0.16);
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Chunky stylised smoke puff with internal shape (not a plain blur). */
export function smokePuffTexture(): THREE.Texture {
  return textureLibrary.get('smoke-puff', () => {
    const size = 128;
    const c = makeCanvas(size);
    const rand = mulberry32(31337);
    const { ctx } = c;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + rand();
      const r = size * (0.12 + rand() * 0.16);
      const x = size / 2 + Math.cos(a) * size * 0.17 * rand();
      const y = size / 2 + Math.sin(a) * size * 0.17 * rand();
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Muzzle flash: a hot core with an irregular starburst corona. */
export function muzzleFlashTexture(): THREE.Texture {
  return textureLibrary.get('muzzle-flash', () => {
    const size = 256;
    const c = makeCanvas(size);
    const rand = mulberry32(808);
    const { ctx } = c;
    const cx = size / 2;
    ctx.globalCompositeOperation = 'lighter';

    // Irregular star corona.
    ctx.fillStyle = 'rgba(255,196,96,0.85)';
    ctx.beginPath();
    const points = 11;
    for (let i = 0; i <= points * 2; i++) {
      const a = (i / (points * 2)) * Math.PI * 2;
      const outer = i % 2 === 0 ? cx * (0.62 + rand() * 0.36) : cx * (0.2 + rand() * 0.12);
      const x = cx + Math.cos(a) * outer;
      const y = cx + Math.sin(a) * outer;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    const core = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx * 0.42);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.4, 'rgba(255,232,150,0.9)');
    core.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, size, size);
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Bullet impact decal — a dented crater with radiating hairline cracks. */
export function bulletDecalTexture(): THREE.Texture {
  return textureLibrary.get('bullet-decal', () => {
    const size = 128;
    const c = makeCanvas(size);
    const rand = mulberry32(1212);
    const { ctx } = c;
    const cx = size / 2;

    // Dust halo. Deliberately restrained — a bullet hole should read as a
    // scuff on the wall, not an ink blot.
    const halo = ctx.createRadialGradient(cx, cx, size * 0.1, cx, cx, cx);
    halo.addColorStop(0, 'rgba(104,88,80,0.4)');
    halo.addColorStop(0.55, 'rgba(112,96,88,0.16)');
    halo.addColorStop(1, 'rgba(112,96,88,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);

    // Cracks.
    ctx.strokeStyle = 'rgba(74,60,56,0.5)';
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.6;
      const len = size * (0.16 + rand() * 0.24);
      ctx.lineWidth = 0.7 + rand() * 1.4;
      ctx.beginPath();
      ctx.moveTo(cx, cx);
      ctx.lineTo(cx + Math.cos(a) * len, cx + Math.sin(a) * len);
      ctx.stroke();
    }

    // Crater with a lit lower lip so it reads as an indent.
    const hole = ctx.createRadialGradient(cx, cx - 2, 1, cx, cx, size * 0.14);
    hole.addColorStop(0, 'rgba(48,38,42,0.88)');
    hole.addColorStop(0.75, 'rgba(68,54,54,0.6)');
    hole.addColorStop(1, 'rgba(88,70,66,0)');
    ctx.fillStyle = hole;
    ctx.beginPath();
    ctx.arc(cx, cx, size * 0.15, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,236,200,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cx + 1.5, size * 0.12, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Simple stylised leaf used for wind-blown foliage particles. */
export function leafTexture(): THREE.Texture {
  return textureLibrary.get('leaf', () => {
    const size = 64;
    const c = makeCanvas(size);
    const { ctx } = c;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.06);
    ctx.bezierCurveTo(size * 0.98, size * 0.3, size * 0.92, size * 0.78, size * 0.5, size * 0.96);
    ctx.bezierCurveTo(size * 0.08, size * 0.78, size * 0.02, size * 0.3, size * 0.5, size * 0.06);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.12);
    ctx.lineTo(size * 0.5, size * 0.9);
    ctx.stroke();
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Fluffy billboard cloud for the skydome layer. */
export function cloudTexture(): THREE.Texture {
  return textureLibrary.get('cloud', () => {
    const w = 256;
    const c = makeCanvas(w);
    const rand = mulberry32(6161);
    const { ctx } = c;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 22; i++) {
      const t = i / 22;
      const x = w * (0.14 + t * 0.72) + (rand() - 0.5) * w * 0.1;
      const y = w * (0.55 - Math.sin(t * Math.PI) * 0.18) + (rand() - 0.5) * w * 0.08;
      const r = w * (0.07 + Math.sin(t * Math.PI) * 0.14) * (0.7 + rand() * 0.6);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Radial gradient shadow blob — a cheap, always-correct contact shadow. */
export function blobShadowTexture(): THREE.Texture {
  return textureLibrary.get('blob-shadow', () => {
    const size = 128;
    const c = makeCanvas(size);
    const g = c.ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(40,20,50,0.55)');
    g.addColorStop(0.5, 'rgba(40,20,50,0.28)');
    g.addColorStop(1, 'rgba(40,20,50,0)');
    c.ctx.fillStyle = g;
    c.ctx.fillRect(0, 0, size, size);
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/**
 * Three-step gradient ramp used as a MeshToonMaterial gradientMap. Gives the
 * zombies their crisp animated-film shading without a custom shader.
 */
export function toonRampTexture(): THREE.Texture {
  return textureLibrary.get('toon-ramp', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const stops = ['#6a5a86', '#b09ac0', '#e8d4d0', '#ffffff'];
    for (let i = 0; i < stops.length; i++) {
      ctx.fillStyle = stops[i];
      ctx.fillRect(i, 0, 1, 1);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

/** Brushed metal for weapon bodies — subtle anisotropic streaks. */
export function metalTexture(color: number): THREE.Texture {
  return textureLibrary.get(`metal-${color.toString(16)}`, () => {
    const size = 128;
    const c = makeCanvas(size);
    const rand = mulberry32(color + 17);
    const [r, g, b] = hexToRgb(color);
    c.ctx.fillStyle = rgb(r, g, b);
    c.ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 460; i++) {
      const y = rand() * size;
      const alpha = 0.03 + rand() * 0.07;
      c.ctx.strokeStyle = rand() < 0.5 ? rgba(255, 255, 255, alpha) : rgba(0, 0, 0, alpha);
      c.ctx.lineWidth = 0.6 + rand();
      c.ctx.beginPath();
      c.ctx.moveTo(0, y);
      c.ctx.lineTo(size, y + (rand() - 0.5) * 3);
      c.ctx.stroke();
    }
    // Light scuffs around the edges of the panel.
    scatterBlobs(c, 12, 2, 8, () => rgba(255, 255, 255, 1), 0.05);
    return toTexture(c, { repeat: 1 });
  });
}

/** Ring-shaped shockwave used for explosions and boss slams. */
export function shockRingTexture(): THREE.Texture {
  return textureLibrary.get('shock-ring', () => {
    const size = 256;
    const c = makeCanvas(size);
    const { ctx } = c;
    const cx = size / 2;
    const g = ctx.createRadialGradient(cx, cx, cx * 0.6, cx, cx, cx);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,236,180,0.15)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.92, 'rgba(255,180,90,0.5)');
    g.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return toTexture(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}
