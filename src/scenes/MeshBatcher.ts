import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { materials, type MaterialKey } from './MaterialLibrary';

/**
 * Static geometry batcher.
 *
 * A village built from ~1500 individual primitives would cost ~1500 draw calls.
 * Merging *everything* into one mesh fixes that but destroys frustum culling —
 * you'd draw the whole town even while staring at a wall.
 *
 * The compromise: batch by (material × spatial district). Each district is a
 * chunk of the map, so we get a handful of draw calls per material while the
 * renderer can still cull whole districts you aren't looking at.
 */

interface BatchEntry {
  geometries: THREE.BufferGeometry[];
  materialKey: MaterialKey;
}

export class MeshBatcher {
  private readonly batches = new Map<string, BatchEntry>();
  private readonly districtSize: number;
  private built: THREE.Mesh[] = [];

  constructor(districtSize = 32) {
    this.districtSize = districtSize;
  }

  private districtOf(x: number, z: number): string {
    const dx = Math.floor(x / this.districtSize);
    const dz = Math.floor(z / this.districtSize);
    return `${dx}_${dz}`;
  }

  /**
   * Queues a primitive. The source geometry is cloned and baked into world
   * space; callers may safely reuse their template geometries.
   */
  add(materialKey: MaterialKey, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    const key = `${materialKey}|${this.districtOf(position.x, position.z)}`;

    let entry = this.batches.get(key);
    if (!entry) {
      entry = { geometries: [], materialKey };
      this.batches.set(key, entry);
    }

    const baked = geometry.clone().applyMatrix4(matrix);
    // Merging requires identical attribute sets; drop anything exotic so a
    // stray tangent/colour attribute can't fail the whole batch.
    for (const name of Object.keys(baked.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') baked.deleteAttribute(name);
    }
    if (!baked.attributes.uv) {
      const count = baked.attributes.position.count;
      baked.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    if (!baked.attributes.normal) baked.computeVertexNormals();

    // mergeGeometries refuses to mix indexed and non-indexed geometry, and
    // Three's primitives are inconsistent about it (Extrude and Polyhedron
    // produce non-indexed, Box/Cylinder/Sphere produce indexed). Give anything
    // unindexed a trivial sequential index so every batch is uniform.
    if (!baked.getIndex()) {
      const count = baked.attributes.position.count;
      const indices = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      for (let i = 0; i < count; i++) indices[i] = i;
      baked.setIndex(new THREE.BufferAttribute(indices, 1));
    }

    entry.geometries.push(baked);
  }

  /** Convenience overload for the common position/rotation/scale case. */
  addTransformed(
    materialKey: MaterialKey,
    geometry: THREE.BufferGeometry,
    position: THREE.Vector3Like,
    rotationY = 0,
    scale: THREE.Vector3Like | number = 1,
    rotationX = 0,
    rotationZ = 0,
  ): void {
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(rotationX, rotationY, rotationZ, 'YXZ'),
    );
    const scaleVec =
      typeof scale === 'number'
        ? new THREE.Vector3(scale, scale, scale)
        : new THREE.Vector3(scale.x, scale.y, scale.z);
    matrix.compose(
      new THREE.Vector3(position.x, position.y, position.z),
      quaternion,
      scaleVec,
    );
    this.add(materialKey, geometry, matrix);
  }

  /** Merges every batch and returns the resulting meshes, ready to add to a scene. */
  build(castShadow = true, receiveShadow = true): THREE.Mesh[] {
    const result: THREE.Mesh[] = [];

    for (const [key, entry] of this.batches) {
      if (entry.geometries.length === 0) continue;

      const merged =
        entry.geometries.length === 1
          ? entry.geometries[0]
          : mergeGeometries(entry.geometries, false);

      if (!merged) {
        // Should not happen given the attribute normalisation above, but a
        // failed merge must not take the whole level with it.
        console.warn(`[MeshBatcher] merge failed for batch "${key}" — skipping.`);
        continue;
      }

      merged.computeBoundingSphere();
      merged.computeBoundingBox();

      const mesh = new THREE.Mesh(merged, materials.get(entry.materialKey));
      mesh.name = `batch:${key}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();

      // Free the per-primitive clones now that they've been merged.
      if (entry.geometries.length > 1) {
        for (const g of entry.geometries) g.dispose();
      }

      result.push(mesh);
    }

    this.batches.clear();
    this.built = result;
    return result;
  }

  get meshCount(): number {
    return this.built.length;
  }
}

/**
 * Shared primitive geometries. Every prop builds from these, so the memory cost
 * of the template set is a few kilobytes regardless of how big the map gets.
 */
export const Primitives = {
  box: new THREE.BoxGeometry(1, 1, 1),
  /** Box with its origin at the base — the common case for props on the ground. */
  boxBase: (() => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0, 0.5, 0);
    return g;
  })(),
  cylinder: (() => {
    const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
    g.translate(0, 0.5, 0);
    return g;
  })(),
  cylinderSmooth: (() => {
    const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
    g.translate(0, 0.5, 0);
    return g;
  })(),
  cone: (() => {
    const g = new THREE.ConeGeometry(0.5, 1, 14);
    g.translate(0, 0.5, 0);
    return g;
  })(),
  sphere: new THREE.SphereGeometry(0.5, 14, 10),
  sphereLow: new THREE.SphereGeometry(0.5, 8, 6),
  /** Icosahedron reads as a faceted stylised rock/foliage clump. */
  rock: weld(new THREE.IcosahedronGeometry(0.5, 0)),
  blob: weld(new THREE.IcosahedronGeometry(0.5, 1)),
  plane: new THREE.PlaneGeometry(1, 1),
  torus: new THREE.TorusGeometry(0.5, 0.12, 8, 24),
  /** Gabled roof prism: a triangular extrusion, origin at the eaves. */
  prism: (() => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.5, 0);
    shape.lineTo(0.5, 0);
    shape.lineTo(0, 1);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
    g.translate(0, 0, -0.5);
    return weld(g);
  })(),
};

/**
 * Converts a non-indexed primitive into an indexed one by welding coincident
 * vertices. Done once per template at module load, so it costs nothing at
 * runtime and keeps every batch's index state uniform.
 */
function weld(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geometry.getIndex()) return geometry;
  // ExtrudeGeometry carries a UV attribute; Polyhedron does not. mergeVertices
  // needs a consistent attribute set, so fill in a placeholder UV first.
  if (!geometry.attributes.uv) {
    const count = geometry.attributes.position.count;
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  const welded = mergeVertices(geometry);
  geometry.dispose();
  return welded;
}
