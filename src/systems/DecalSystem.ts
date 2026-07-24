import * as THREE from 'three';
import { bulletDecalTexture } from '../textures/ProceduralTextures';
import { randRange } from '../utilities/MathUtils';

interface Decal {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
}

/**
 * Bullet-hole decals.
 *
 * Implemented as camera-independent quads offset slightly along the surface
 * normal rather than true projected decals — for a stylised game the visual
 * difference is negligible, and it costs one quad instead of a geometry clip
 * against every triangle it overlaps.
 *
 * The pool is a fixed-size ring: the oldest hole is recycled once the budget is
 * reached, so decal count can never grow without bound during a long run.
 */
export class DecalSystem {
  readonly group = new THREE.Group();

  private readonly decals: Decal[] = [];
  private cursor = 0;
  private capacity: number;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly lifetime = 26;

  private readonly _quaternion = new THREE.Quaternion();
  private static readonly PLANE_NORMAL = new THREE.Vector3(0, 0, 1);

  constructor(capacity: number) {
    this.group.name = 'Decals';
    this.capacity = Math.max(4, capacity);
    this.buildPool();
  }

  private buildPool(): void {
    const texture = bulletDecalTexture();
    for (let i = 0; i < this.capacity; i++) {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // Pull the decal toward the camera in depth so it never z-fights with
        // the wall it's stuck to.
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.decals.push({ mesh, material, life: 0, maxLife: this.lifetime });
    }
  }

  setCapacity(capacity: number): void {
    const target = Math.max(4, capacity);
    if (target === this.capacity) return;

    if (target < this.capacity) {
      const removed = this.decals.splice(target);
      for (const decal of removed) {
        decal.material.dispose();
        this.group.remove(decal.mesh);
      }
    } else {
      const texture = bulletDecalTexture();
      for (let i = this.capacity; i < target; i++) {
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        });
        const mesh = new THREE.Mesh(this.geometry, material);
        mesh.visible = false;
        mesh.renderOrder = 2;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        this.decals.push({ mesh, material, life: 0, maxLife: this.lifetime });
      }
    }

    this.capacity = target;
    this.cursor = 0;
  }

  /** Places a bullet hole at a world-space hit point. */
  spawn(position: THREE.Vector3, normal: THREE.Vector3, size = 0.22, tint = 0xffffff): void {
    if (this.decals.length === 0) return;

    const decal = this.decals[this.cursor];
    this.cursor = (this.cursor + 1) % this.decals.length;

    // Orient the quad's +Z along the surface normal, with a random roll so
    // repeated hits on one wall don't produce a visible pattern.
    this._quaternion.setFromUnitVectors(DecalSystem.PLANE_NORMAL, normal);
    const roll = new THREE.Quaternion().setFromAxisAngle(normal, Math.random() * Math.PI * 2);
    this._quaternion.premultiply(roll);

    const scale = size * randRange(0.82, 1.24);
    decal.mesh.matrix.compose(
      new THREE.Vector3(
        position.x + normal.x * 0.012,
        position.y + normal.y * 0.012,
        position.z + normal.z * 0.012,
      ),
      this._quaternion,
      new THREE.Vector3(scale, scale, scale),
    );
    decal.mesh.matrixWorldNeedsUpdate = true;

    decal.material.color.setHex(tint);
    decal.material.opacity = 0.7;
    decal.mesh.visible = true;
    decal.life = decal.maxLife;
  }

  update(dt: number): void {
    for (const decal of this.decals) {
      if (decal.life <= 0) continue;
      decal.life -= dt;
      if (decal.life <= 0) {
        decal.mesh.visible = false;
        decal.material.opacity = 0;
        continue;
      }
      // Hold full opacity, then fade over the final 25% of the lifetime.
      const t = decal.life / decal.maxLife;
      decal.material.opacity = t < 0.25 ? (t / 0.25) * 0.7 : 0.7;
    }
  }

  clear(): void {
    for (const decal of this.decals) {
      decal.life = 0;
      decal.mesh.visible = false;
      decal.material.opacity = 0;
    }
    this.cursor = 0;
  }

  dispose(): void {
    for (const decal of this.decals) decal.material.dispose();
    this.decals.length = 0;
    this.geometry.dispose();
    this.group.clear();
  }
}
