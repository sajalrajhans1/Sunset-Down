import * as THREE from 'three';
import { leafTexture, softCircleTexture, sparkleTexture } from '../textures/ProceduralTextures';
import { applyStylizedShading } from '../textures/StylizedMaterial';
import { WORLD } from '../game/Config';
import type { QualityProfile } from '../game/Settings';
import type { CollisionWorld } from '../systems/CollisionWorld';
import { randRange, TAU } from '../utilities/MathUtils';

/**
 * Ambient world detail: grass, fireflies, drifting leaves and dust.
 *
 * Every one of these is a *single* draw call with all motion computed in the
 * vertex shader from a per-particle seed. Nothing here costs CPU time per
 * frame beyond writing one uniform, which is what makes it affordable to have
 * thousands of moving elements while 50 zombies chase the player.
 */
export class Environment {
  readonly group = new THREE.Group();

  private readonly tickables: { material: THREE.ShaderMaterial | THREE.Material }[] = [];
  private elapsed = 0;
  private windStrength = 1;
  /** Number of grass clumps actually placed — surfaced in the debug overlay. */
  grassCount = 0;

  constructor() {
    this.group.name = 'Environment';
  }

  build(quality: QualityProfile, collision: CollisionWorld, plazaRadius: number): void {
    this.clear();
    if (quality.grassDensity > 0) this.buildGrass(quality.grassDensity, collision, plazaRadius);
    if (quality.fireflyCount > 0) this.buildFireflies(quality.fireflyCount);
    this.buildLeaves(Math.round(quality.maxParticles * 0.18));
    this.buildDust(Math.round(quality.maxParticles * 0.22));
  }

  // -------------------------------------------------------------------------
  // Grass
  // -------------------------------------------------------------------------

  /** Tapered blade pair, crossed so clumps read as volumetric from any angle. */
  private static createBladeGeometry(): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const addBlade = (angle: number, lean: number): void => {
      const base = positions.length / 3;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const halfWidth = 0.055;
      const height = 1.0;
      const tip = lean * 0.22;

      // Four vertices: wide at the base, pinched at the tip.
      const pts: [number, number, number][] = [
        [-halfWidth * cos, 0, -halfWidth * sin],
        [halfWidth * cos, 0, halfWidth * sin],
        [halfWidth * 0.28 * cos + tip * cos, height, halfWidth * 0.28 * sin + tip * sin],
        [-halfWidth * 0.28 * cos + tip * cos, height, -halfWidth * 0.28 * sin + tip * sin],
      ];
      for (const [px, py, pz] of pts) {
        positions.push(px, py, pz);
        // Normal points outward from the blade face, tilted up so the grass
        // catches light softly rather than flickering.
        normals.push(-sin * 0.6, 0.8, cos * 0.6);
      }
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    addBlade(0, 1);
    addBlade(Math.PI / 3, -0.7);
    addBlade((Math.PI * 2) / 3, 0.5);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  private buildGrass(count: number, collision: CollisionWorld, plazaRadius: number): void {
    const geometry = Environment.createBladeGeometry();

    const material = applyStylizedShading(
      new THREE.MeshStandardMaterial({
        color: 0x9dbf68,
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
        vertexColors: true,
      }),
      {
        rimColor: 0xffd08a,
        rimStrength: 0.55,
        subsurfaceColor: 0xa8d06a,
        subsurfaceStrength: 1.6,
        // Tuned so the tips sway while the base stays planted.
        wind: { strength: 0.12, speed: 1.5, minY: 0.05, maxY: 0.95 },
      },
    );

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const colors = new Float32Array(count * 3);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const limit = WORLD.halfSize - 3;

    let placed = 0;
    let attempts = 0;
    while (placed < count && attempts < count * 6) {
      attempts++;
      const x = randRange(-limit, limit);
      const z = randRange(-limit, limit);

      // Skip the paved plaza and anywhere a prop already sits.
      if (Math.hypot(x, z) < plazaRadius + 0.5) continue;
      if (collision.isBlocked(x, z, 0.35, 0.2)) continue;

      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, Math.random() * TAU, 0);
      const height = randRange(0.28, 0.62);
      dummy.scale.set(randRange(0.8, 1.3), height, randRange(0.8, 1.3));
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);

      // Per-clump colour variation prevents a uniform green carpet.
      const hue = randRange(0.19, 0.27);
      const light = randRange(0.36, 0.62);
      color.setHSL(hue, randRange(0.32, 0.55), light);
      colors[placed * 3] = color.r;
      colors[placed * 3 + 1] = color.g;
      colors[placed * 3 + 2] = color.b;
      placed++;
    }

    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    geometry.setAttribute('color', new THREE.InstancedBufferAttribute(colors, 3));

    this.grassCount = placed;
    this.group.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Fireflies
  // -------------------------------------------------------------------------

  private buildFireflies(count: number): void {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU;
      const radius = randRange(6, WORLD.halfSize - 8);
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = randRange(0.6, 3.6);
      positions[i * 3 + 2] = Math.sin(angle) * radius;
      seeds[i * 3] = Math.random() * TAU;
      seeds[i * 3 + 1] = randRange(0.25, 0.75);
      seeds[i * 3 + 2] = randRange(0.6, 1.8);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WORLD.halfSize * 1.5);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uTexture: { value: sparkleTexture() },
        uSize: { value: 46 },
        uColorA: { value: new THREE.Color(0xfff2a8) },
        uColorB: { value: new THREE.Color(0x9dff9a) },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelRatio;
        attribute vec3 aSeed;
        varying float vBlink;
        varying float vTint;

        void main() {
          vec3 pos = position;
          float t = uTime * aSeed.y;
          // Lazy lissajous wander, unique per firefly.
          pos.x += sin( t + aSeed.x ) * 1.6;
          pos.z += cos( t * 0.83 + aSeed.x * 1.7 ) * 1.6;
          pos.y += sin( t * 1.4 + aSeed.x * 2.3 ) * 0.55;

          vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );
          gl_Position = projectionMatrix * mvPosition;

          // Pulse between dim and bright; some blink out entirely.
          float pulse = sin( uTime * aSeed.z * 2.4 + aSeed.x * 4.0 );
          vBlink = smoothstep( -0.35, 0.9, pulse );
          vTint = fract( aSeed.x );

          gl_PointSize = uSize * uPixelRatio * ( 0.55 + vBlink * 0.65 ) / max( -mvPosition.z, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTexture;
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        varying float vBlink;
        varying float vTint;

        void main() {
          vec4 tex = texture2D( uTexture, gl_PointCoord );
          vec3 color = mix( uColorA, uColorB, vTint );
          gl_FragColor = vec4( color * ( 1.2 + vBlink ), tex.a * vBlink * 0.85 );
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 5;
    this.group.add(points);
    this.tickables.push({ material });
  }

  // -------------------------------------------------------------------------
  // Falling leaves
  // -------------------------------------------------------------------------

  private buildLeaves(count: number): void {
    if (count <= 0) return;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = randRange(-WORLD.halfSize, WORLD.halfSize);
      positions[i * 3 + 1] = randRange(0, 18);
      positions[i * 3 + 2] = randRange(-WORLD.halfSize, WORLD.halfSize);
      seeds[i * 4] = Math.random() * TAU;
      seeds[i * 4 + 1] = randRange(0.5, 1.4); // fall speed
      seeds[i * 4 + 2] = randRange(0.6, 2.2); // tumble rate
      seeds[i * 4 + 3] = Math.random(); // colour pick
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WORLD.halfSize * 1.6);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uTexture: { value: leafTexture() },
        uSize: { value: 34 },
        uPixelRatio: { value: 1 },
        uWind: { value: 1 },
        uCeiling: { value: 18 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelRatio;
        uniform float uWind;
        uniform float uCeiling;
        attribute vec4 aSeed;
        varying float vSpin;
        varying float vTint;

        void main() {
          vec3 pos = position;
          float fall = uTime * aSeed.y * 1.1;
          // Wrap vertically so the leaf fall loops forever without CPU work.
          pos.y = uCeiling - mod( fall + aSeed.x * 4.0, uCeiling );
          // Leaves drift downwind as they descend, and flutter side to side.
          pos.x += sin( uTime * aSeed.z * 0.7 + aSeed.x ) * 2.2 + uWind * ( uCeiling - pos.y ) * 0.16;
          pos.z += cos( uTime * aSeed.z * 0.55 + aSeed.x * 1.3 ) * 1.8;

          vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          vSpin = uTime * aSeed.z + aSeed.x * 6.0;
          vTint = aSeed.w;
          gl_PointSize = uSize * uPixelRatio / max( -mvPosition.z, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTexture;
        varying float vSpin;
        varying float vTint;

        void main() {
          // Rotate the sprite by spinning its UVs about the centre.
          vec2 uv = gl_PointCoord - 0.5;
          float s = sin( vSpin );
          float c = cos( vSpin );
          uv = mat2( c, -s, s, c ) * uv;
          // Squash horizontally on a slow cycle so leaves appear to tumble
          // edge-on through the fall.
          uv.x /= max( abs( sin( vSpin * 0.7 ) ), 0.28 );
          uv += 0.5;
          if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) discard;

          vec4 tex = texture2D( uTexture, uv );
          if ( tex.a < 0.12 ) discard;

          vec3 amber = vec3( 0.92, 0.48, 0.16 );
          vec3 gold  = vec3( 0.95, 0.72, 0.22 );
          vec3 rust  = vec3( 0.74, 0.26, 0.16 );
          vec3 color = vTint < 0.4 ? amber : ( vTint < 0.75 ? gold : rust );
          gl_FragColor = vec4( color, tex.a * 0.92 );
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 4;
    this.group.add(points);
    this.tickables.push({ material });
  }

  // -------------------------------------------------------------------------
  // Dust motes
  // -------------------------------------------------------------------------

  private buildDust(count: number): void {
    if (count <= 0) return;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 2);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = randRange(-WORLD.halfSize, WORLD.halfSize);
      positions[i * 3 + 1] = randRange(0.2, 9);
      positions[i * 3 + 2] = randRange(-WORLD.halfSize, WORLD.halfSize);
      seeds[i * 2] = Math.random() * TAU;
      seeds[i * 2 + 1] = randRange(0.15, 0.5);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 2));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WORLD.halfSize * 1.6);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uTexture: { value: softCircleTexture() },
        uSize: { value: 24 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelRatio;
        attribute vec2 aSeed;
        varying float vAlpha;

        void main() {
          vec3 pos = position;
          float t = uTime * aSeed.y;
          pos.x += sin( t + aSeed.x ) * 2.4;
          pos.y += sin( t * 0.6 + aSeed.x * 2.0 ) * 1.1;
          pos.z += cos( t * 0.8 + aSeed.x * 1.4 ) * 2.4;

          vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          // Fade in the distance so motes never form a visible wall.
          float dist = -mvPosition.z;
          vAlpha = smoothstep( 60.0, 8.0, dist ) * ( 0.25 + 0.2 * sin( t * 2.0 + aSeed.x ) );
          gl_PointSize = uSize * uPixelRatio / max( dist, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTexture;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D( uTexture, gl_PointCoord );
          gl_FragColor = vec4( vec3( 1.0, 0.92, 0.78 ), tex.a * vAlpha );
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.group.add(points);
    this.tickables.push({ material });
  }

  // -------------------------------------------------------------------------

  setPixelRatio(ratio: number): void {
    for (const { material } of this.tickables) {
      const uniforms = (material as THREE.ShaderMaterial).uniforms;
      if (uniforms?.uPixelRatio) uniforms.uPixelRatio.value = ratio;
    }
  }

  /** Weather / intensity hook: scales leaf drift and dust motion. */
  setWind(strength: number): void {
    this.windStrength = strength;
  }

  update(dt: number): void {
    this.elapsed += dt;
    for (const { material } of this.tickables) {
      const uniforms = (material as THREE.ShaderMaterial).uniforms;
      if (uniforms?.uTime) uniforms.uTime.value = this.elapsed;
      if (uniforms?.uWind) uniforms.uWind.value = this.windStrength;
    }
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      const obj = child as THREE.Mesh | THREE.Points;
      obj.geometry?.dispose();
      const material = obj.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
      this.group.remove(child);
    }
    this.tickables.length = 0;
    this.grassCount = 0;
  }

  dispose(): void {
    this.clear();
  }
}
