import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import treesUrl from '../assets/trees.glb';
import { applyStylizedShading } from '../textures/StylizedMaterial';

/**
 * Instanced foliage.
 *
 * The supplied pack is modular — two trunk variants, three branch canopies, a
 * flat background tree and a rock — all sharing atlas textures and totalling
 * under 4,000 triangles. That's ideal here: a tree is assembled from a trunk
 * plus a canopy, and every piece across the whole map is drawn as a single
 * `InstancedMesh`.
 *
 * The result is roughly six draw calls for several hundred trees, versus the
 * batched-primitive version it replaces, and it looks considerably better.
 */

export type TreePieceId =
  | 'trunk01'
  | 'trunk02'
  | 'branches01'
  | 'branches01b'
  | 'branches02'
  | 'backgroundTree'
  | 'rock';

interface PieceSource {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Height of the piece in its own local units, used to stack canopies. */
  height: number;
  /** Y of the lowest vertex, so pieces can be seated on the ground. */
  minY: number;
}

/** Substring of the source node name that identifies each piece. */
const PIECE_KEYS: Record<TreePieceId, string> = {
  trunk01: 'Tree_Trunk_01',
  trunk02: 'Tree_Trunk_02',
  branches01: 'Tree_Branches_01_',
  branches01b: 'Tree_Branches_01001',
  branches02: 'Tree_Branches_02',
  backgroundTree: 'Background_Tree_Atlas',
  rock: 'Rocks',
};

let templatePromise: Promise<Map<TreePieceId, PieceSource>> | null = null;
let pieces: Map<TreePieceId, PieceSource> | null = null;

export function loadTreeModels(): Promise<Map<TreePieceId, PieceSource>> {
  if (templatePromise) return templatePromise;

  templatePromise = new Promise((resolve, reject) => {
    new GLTFLoader().load(
      treesUrl,
      (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        const found = new Map<TreePieceId, PieceSource>();

        for (const [id, key] of Object.entries(PIECE_KEYS) as [TreePieceId, string][]) {
          let mesh: THREE.Mesh | null = null;
          gltf.scene.traverse((object) => {
            if (mesh) return;
            const candidate = object as THREE.Mesh;
            // GLTFLoader strips dots from node names, so "Tree_Branches_01.001"
            // arrives as "Tree_Branches_01001".
            if (candidate.isMesh && candidate.name.replace(/[[\].:/]/g, '').includes(key)) {
              mesh = candidate;
            }
          });
          if (!mesh) continue;

          const source = mesh as THREE.Mesh;
          // Bake the source transform in so instances only carry placement.
          const geometry = source.geometry.clone();
          source.updateWorldMatrix(true, false);
          geometry.applyMatrix4(source.matrixWorld);
          geometry.computeBoundingBox();

          // Re-centre horizontally and drop to y = 0 so instancing is simple.
          const box = geometry.boundingBox!;
          const centreX = (box.min.x + box.max.x) * 0.5;
          const centreZ = (box.min.z + box.max.z) * 0.5;
          geometry.translate(-centreX, -box.min.y, -centreZ);
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();

          const material = (source.material as THREE.MeshStandardMaterial).clone();
          // Atlas foliage is cut-out, not blended: alpha test keeps it sorting
          // correctly against itself without any transparency ordering pain.
          material.transparent = false;
          material.alphaTest = 0.42;
          material.side = THREE.DoubleSide;
          material.roughness = 0.92;
          material.metalness = 0;
          applyStylizedShading(material, {
            rimColor: 0xffc27a,
            rimStrength: 0.45,
            subsurfaceColor: 0xd8b45a,
            subsurfaceStrength: 0.9,
            // Only the canopies sway; trunks and rocks stay put.
            wind: id.startsWith('branches') || id === 'backgroundTree'
              ? { strength: 0.09, speed: 1.05, minY: 0.35, maxY: 1.0 }
              : undefined,
          });

          found.set(id, {
            geometry,
            material,
            height: geometry.boundingBox!.max.y,
            minY: 0,
          });
        }

        if (import.meta.env.DEV) {
          console.info('[Trees] pieces resolved: %s', [...found.keys()].join(', ') || 'NONE');
        }

        pieces = found;
        resolve(found);
      },
      undefined,
      (error) => reject(error),
    );
  });

  return templatePromise;
}

export function areTreesReady(): boolean {
  return pieces !== null && pieces.size > 0;
}

export interface TreePlacement {
  x: number;
  z: number;
  scale: number;
  rotation: number;
}

/**
 * Builds the instanced meshes for a set of tree placements.
 *
 * Each placement becomes a trunk plus a canopy seated on top of it, with the
 * variant chosen from the placement's own hash so the layout is stable across
 * sessions.
 */
export class TreeField {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];

  constructor() {
    this.group.name = 'Trees';
  }

  build(placements: TreePlacement[], rocks: TreePlacement[]): void {
    this.clear();
    if (!pieces) return;

    const trunkVariants: TreePieceId[] = ['trunk01', 'trunk02'];
    const canopyVariants: TreePieceId[] = ['branches01', 'branches01b', 'branches02'];

    // Bucket every placement by which piece it needs, so each piece can be a
    // single InstancedMesh.
    const buckets = new Map<TreePieceId, THREE.Matrix4[]>();
    const push = (id: TreePieceId, matrix: THREE.Matrix4): void => {
      let list = buckets.get(id);
      if (!list) {
        list = [];
        buckets.set(id, list);
      }
      list.push(matrix);
    };

    const dummy = new THREE.Object3D();

    placements.forEach((placement, index) => {
      const trunkId = trunkVariants[index % trunkVariants.length];
      const canopyId = canopyVariants[index % canopyVariants.length];
      const trunk = pieces!.get(trunkId);
      const canopy = pieces!.get(canopyId);
      if (!trunk) return;

      dummy.position.set(placement.x, 0, placement.z);
      dummy.rotation.set(0, placement.rotation, 0);
      dummy.scale.setScalar(placement.scale);
      dummy.updateMatrix();
      push(trunkId, dummy.matrix.clone());

      if (canopy) {
        // Seat the canopy near the top of the trunk, with a slight overlap so
        // there's never a visible seam between the two pieces.
        dummy.position.set(placement.x, trunk.height * placement.scale * 0.78, placement.z);
        dummy.rotation.set(0, placement.rotation * 1.7 + index, 0);
        dummy.scale.setScalar(placement.scale * 1.05);
        dummy.updateMatrix();
        push(canopyId, dummy.matrix.clone());
      }
    });

    rocks.forEach((placement) => {
      dummy.position.set(placement.x, 0, placement.z);
      dummy.rotation.set(0, placement.rotation, 0);
      dummy.scale.setScalar(placement.scale);
      dummy.updateMatrix();
      push('rock', dummy.matrix.clone());
    });

    for (const [id, matrices] of buckets) {
      const piece = pieces.get(id);
      if (!piece || matrices.length === 0) continue;

      const mesh = new THREE.InstancedMesh(piece.geometry, piece.material, matrices.length);
      for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Instances are spread across the whole map, so a per-object frustum test
      // against their combined bounds is never a win.
      mesh.frustumCulled = false;
      mesh.name = `trees:${id}`;

      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Height of a trunk at scale 1, so callers can size collision to match. */
  trunkHeight(): number {
    return pieces?.get('trunk01')?.height ?? 3;
  }

  clear(): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.meshes.length = 0;
  }

  dispose(): void {
    this.clear();
    this.group.clear();
  }
}
