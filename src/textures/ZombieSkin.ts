import * as THREE from 'three';
import zombieSkinUrl from '../assets/zombie-skin.webp';
import { makeCanvas, normalMapFromCanvas } from './CanvasUtils';

/**
 * The zombies' skin.
 *
 * This is the one place in the 3D world that uses an authored bitmap rather
 * than a runtime-generated canvas — hand-painted mottled flesh with veins,
 * cracked patches and coarse stitching, which is far more convincing at close
 * range than anything reasonable to draw procedurally.
 *
 * The matching normal map is derived from the albedo's luminance once the
 * image decodes, so the skin catches the low sunset light and reads as
 * leathery rather than painted-on.
 */

interface ZombieSkinTextures {
  albedo: THREE.Texture;
  normal: THREE.Texture;
}

let cached: ZombieSkinTextures | null = null;

/** How many times the skin tiles across a single body part. */
const SKIN_REPEAT = 2.4;

export function zombieSkin(): ZombieSkinTextures {
  if (cached) return cached;

  // The normal map has no image until the albedo decodes; Three tolerates an
  // empty texture and simply skips it until `needsUpdate` is set.
  const normal = new THREE.Texture();
  normal.wrapS = THREE.RepeatWrapping;
  normal.wrapT = THREE.RepeatWrapping;
  normal.repeat.set(SKIN_REPEAT, SKIN_REPEAT);
  normal.colorSpace = THREE.NoColorSpace;

  const albedo = new THREE.TextureLoader().load(zombieSkinUrl, (texture) => {
    const image = texture.image as HTMLImageElement | ImageBitmap | undefined;
    if (!image) return;

    // Half resolution is plenty for a normal map and keeps the one-off Sobel
    // pass well under a frame.
    const size = 512;
    const source = makeCanvas(size);
    source.ctx.drawImage(image as CanvasImageSource, 0, 0, size, size);

    const derived = normalMapFromCanvas(source, 2.6);
    normal.image = derived.canvas;
    normal.needsUpdate = true;
  });

  albedo.wrapS = THREE.RepeatWrapping;
  albedo.wrapT = THREE.RepeatWrapping;
  albedo.repeat.set(SKIN_REPEAT, SKIN_REPEAT);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.anisotropy = 4;

  cached = { albedo, normal };
  return cached;
}

export function disposeZombieSkin(): void {
  cached?.albedo.dispose();
  cached?.normal.dispose();
  cached = null;
}
