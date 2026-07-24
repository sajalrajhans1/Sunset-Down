import * as THREE from 'three';
import {
  cobbleNormalTexture,
  cobbleTexture,
  dirtPathTexture,
  grassNormalTexture,
  grassTexture,
  metalTexture,
  plasterTexture,
  shingleNormalTexture,
  shingleTexture,
  stripeTexture,
  windowTexture,
  woodPlankTexture,
} from '../textures/ProceduralTextures';
import { stylizedStandard } from '../textures/StylizedMaterial';

/**
 * The village's entire palette, as a fixed set of shared materials.
 *
 * Keeping the material count small is what makes the batching in MeshBatcher
 * effective — every prop in a district that uses "plaster.mint" collapses into
 * a single draw call. Materials are created lazily on first access.
 */
export type MaterialKey =
  | 'ground.grass'
  | 'ground.cobble'
  | 'ground.dirt'
  | 'plaster.cream'
  | 'plaster.mint'
  | 'plaster.peach'
  | 'plaster.sky'
  | 'plaster.butter'
  | 'plaster.lilac'
  | 'timber.dark'
  | 'wood.warm'
  | 'wood.light'
  | 'wood.crate'
  | 'roof.red'
  | 'roof.blue'
  | 'roof.teal'
  | 'roof.plum'
  | 'stripe.redWhite'
  | 'stripe.blueWhite'
  | 'stripe.mintWhite'
  | 'stripe.goldWhite'
  | 'window.glow'
  | 'metal.dark'
  | 'metal.gold'
  | 'metal.iron'
  | 'foliage.amber'
  | 'foliage.gold'
  | 'foliage.crimson'
  | 'foliage.green'
  | 'flower.pink'
  | 'flower.yellow'
  | 'flower.violet'
  | 'stone.pale'
  | 'stone.dark'
  | 'bulb.glow'
  | 'fabric.cream'
  | 'canvas.red'
  | 'paint.white';

class MaterialLibrary {
  private readonly cache = new Map<MaterialKey, THREE.Material>();
  private readonly builders: Record<MaterialKey, () => THREE.Material>;

  constructor() {
    // Foliage and fabric get wind + subsurface; hard surfaces get rim only.
    const foliage = (color: number, wind = 0.16): THREE.Material =>
      stylizedStandard(
        { color, roughness: 0.88, flatShading: true },
        {
          rimColor: 0xffc27a,
          rimStrength: 0.5,
          subsurfaceColor: color,
          subsurfaceStrength: 0.9,
          wind: { strength: wind, speed: 1.1, minY: 0.4, maxY: 3.2 },
        },
      );

    const plaster = (color: number): THREE.Material =>
      stylizedStandard(
        { color, map: plasterTexture(color), roughness: 0.92 },
        { rimStrength: 0.3 },
      );

    const roof = (color: number): THREE.Material =>
      stylizedStandard(
        {
          color: 0xffffff,
          map: shingleTexture(color),
          normalMap: shingleNormalTexture(color),
          normalScale: new THREE.Vector2(0.7, 0.7),
          roughness: 0.85,
        },
        { rimStrength: 0.38 },
      );

    const stripe = (a: number, b: number): THREE.Material =>
      stylizedStandard(
        { map: stripeTexture(a, b), roughness: 0.78, side: THREE.DoubleSide },
        {
          rimStrength: 0.42,
          subsurfaceColor: a,
          subsurfaceStrength: 1.4,
          wind: { strength: 0.03, speed: 1.8, minY: 0.1, maxY: 1.0 },
        },
      );

    const wood = (color: number, planks = 6): THREE.Material =>
      stylizedStandard({ color: 0xffffff, map: woodPlankTexture(color, planks), roughness: 0.86 }, { rimStrength: 0.3 });

    this.builders = {
      'ground.grass': () =>
        stylizedStandard(
          {
            map: grassTexture(),
            normalMap: grassNormalTexture(),
            normalScale: new THREE.Vector2(0.45, 0.45),
            color: 0xb8c98a,
            roughness: 0.95,
          },
          { rimStrength: 0.12 },
        ),
      'ground.cobble': () =>
        stylizedStandard(
          {
            map: cobbleTexture(),
            normalMap: cobbleNormalTexture(),
            normalScale: new THREE.Vector2(0.85, 0.85),
            color: 0xe8dcc8,
            roughness: 0.88,
          },
          { rimStrength: 0.14 },
        ),
      'ground.dirt': () => stylizedStandard({ map: dirtPathTexture(), roughness: 0.96 }, { rimStrength: 0.1 }),

      'plaster.cream': () => plaster(0xf3e2c4),
      'plaster.mint': () => plaster(0xbfe3d2),
      'plaster.peach': () => plaster(0xf7cfa8),
      'plaster.sky': () => plaster(0xc3dcf0),
      'plaster.butter': () => plaster(0xf7dfa0),
      'plaster.lilac': () => plaster(0xd8c8ea),

      'timber.dark': () => wood(0x6b4630, 3),
      'wood.warm': () => wood(0x9c6b42, 5),
      'wood.light': () => wood(0xc9a173, 6),
      'wood.crate': () => wood(0xb98b56, 4),

      'roof.red': () => roof(0xc4553f),
      'roof.blue': () => roof(0x5f7fa8),
      'roof.teal': () => roof(0x4f8f8a),
      'roof.plum': () => roof(0x8a5f86),

      'stripe.redWhite': () => stripe(0xe25b52, 0xfff3e2),
      'stripe.blueWhite': () => stripe(0x5a8fc4, 0xfff3e2),
      'stripe.mintWhite': () => stripe(0x6cc4a4, 0xfff3e2),
      'stripe.goldWhite': () => stripe(0xefb64f, 0xfff3e2),

      // Emissive so windows read as lit interiors and feed the bloom pass.
      'window.glow': () =>
        new THREE.MeshStandardMaterial({
          map: windowTexture(),
          emissiveMap: windowTexture(),
          emissive: 0xffc884,
          emissiveIntensity: 0.85,
          roughness: 0.4,
          metalness: 0,
        }),

      'metal.dark': () =>
        stylizedStandard({ map: metalTexture(0x3d3a44), roughness: 0.45, metalness: 0.72 }, { rimStrength: 0.6 }),
      'metal.gold': () =>
        stylizedStandard({ map: metalTexture(0xd9a441), roughness: 0.3, metalness: 0.85 }, { rimStrength: 0.8 }),
      'metal.iron': () =>
        stylizedStandard({ map: metalTexture(0x6a6a72), roughness: 0.55, metalness: 0.6 }, { rimStrength: 0.5 }),

      'foliage.amber': () => foliage(0xe08a3c),
      'foliage.gold': () => foliage(0xe8b447),
      'foliage.crimson': () => foliage(0xc4543f),
      'foliage.green': () => foliage(0x7ba85c),

      'flower.pink': () => foliage(0xf08cb4, 0.1),
      'flower.yellow': () => foliage(0xf5d15c, 0.1),
      'flower.violet': () => foliage(0xa886dc, 0.1),

      'stone.pale': () => stylizedStandard({ color: 0xd6cbb8, roughness: 0.9, flatShading: true }, { rimStrength: 0.28 }),
      'stone.dark': () => stylizedStandard({ color: 0x8f8578, roughness: 0.92, flatShading: true }, { rimStrength: 0.24 }),

      // Fully emissive: string-light bulbs and lamp globes.
      'bulb.glow': () =>
        new THREE.MeshBasicMaterial({ color: 0xffd89a, toneMapped: false, fog: false }),

      'fabric.cream': () =>
        stylizedStandard(
          { color: 0xf5e6cc, roughness: 0.9, side: THREE.DoubleSide },
          { subsurfaceColor: 0xffcf9a, subsurfaceStrength: 1.2, rimStrength: 0.4 },
        ),
      'canvas.red': () =>
        stylizedStandard(
          { color: 0xd05a4e, roughness: 0.9, side: THREE.DoubleSide },
          { subsurfaceColor: 0xff7a5a, subsurfaceStrength: 1.3, rimStrength: 0.4 },
        ),
      'paint.white': () => stylizedStandard({ color: 0xfaf0e0, roughness: 0.7 }, { rimStrength: 0.45 }),
    };
  }

  get(key: MaterialKey): THREE.Material {
    let material = this.cache.get(key);
    if (!material) {
      material = this.builders[key]();
      material.name = key;
      this.cache.set(key, material);
    }
    return material;
  }

  /** Toggles shadow-relevant flags when the shadow setting changes. */
  forEach(fn: (material: THREE.Material, key: MaterialKey) => void): void {
    for (const [key, material] of this.cache) fn(material, key);
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    this.cache.clear();
  }
}

export const materials = new MaterialLibrary();

/** Colour used for impact particles when a bullet strikes this material. */
export const MATERIAL_IMPACT_COLOR: Partial<Record<MaterialKey, number>> = {
  'ground.grass': 0x86a05c,
  'ground.cobble': 0xc9bca6,
  'ground.dirt': 0xa88c62,
  'plaster.cream': 0xf3e2c4,
  'plaster.mint': 0xbfe3d2,
  'plaster.peach': 0xf7cfa8,
  'plaster.sky': 0xc3dcf0,
  'plaster.butter': 0xf7dfa0,
  'plaster.lilac': 0xd8c8ea,
  'timber.dark': 0x6b4630,
  'wood.warm': 0x9c6b42,
  'wood.crate': 0xb98b56,
  'metal.dark': 0x9aa0aa,
  'metal.gold': 0xffd98a,
  'stone.pale': 0xd6cbb8,
};
