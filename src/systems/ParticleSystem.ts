import * as THREE from 'three';
import {
  smokePuffTexture,
  softCircleTexture,
  sparkStreakTexture,
  sparkleTexture,
} from '../textures/ProceduralTextures';
import { randRange, TAU } from '../utilities/MathUtils';

/**
 * Pooled CPU-simulated particle system.
 *
 * Everything is packed into two draw calls — one additive layer for sparks and
 * glows, one alpha-blended layer for smoke and debris. Particle state lives in
 * flat typed arrays (structure-of-arrays) so the per-frame simulation is a
 * tight linear loop with no object churn.
 *
 * At the "ultra" budget this simulates ~1100 particles in well under 0.2 ms.
 */

interface LayerBuffers {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  rotations: Float32Array;

  // Simulation-only state.
  velX: Float32Array;
  velY: Float32Array;
  velZ: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  drag: Float32Array;
  gravity: Float32Array;
  sizeStart: Float32Array;
  sizeEnd: Float32Array;
  spin: Float32Array;
  alive: Uint8Array;
  /** Bounces off the ground plane instead of passing through. */
  bounce: Uint8Array;

  capacity: number;
  count: number;
  cursor: number;
}

export interface EmitOptions {
  position: THREE.Vector3;
  count: number;
  /** Base outward speed. */
  speed: number;
  speedVariance: number;
  /** Cone direction; omit for a spherical burst. */
  direction?: THREE.Vector3;
  /** Cone half-angle in radians. 0 = perfectly focused, PI = full sphere. */
  spread: number;
  color: THREE.Color | number;
  colorVariance: number;
  sizeStart: number;
  sizeEnd: number;
  life: number;
  lifeVariance: number;
  gravity: number;
  drag: number;
  spin: number;
  bounce?: boolean;
  /** Random positional jitter around the origin. */
  radius?: number;
}

type LayerName = 'additive' | 'alpha';

export class ParticleSystem {
  readonly group = new THREE.Group();

  private readonly layers = new Map<LayerName, LayerBuffers>();
  private readonly _color = new THREE.Color();
  private readonly _dir = new THREE.Vector3();

  constructor(maxParticles: number) {
    this.group.name = 'Particles';
    // Sparks are the most numerous; smoke is heavier per pixel so it gets less.
    this.layers.set('additive', this.createLayer(Math.round(maxParticles * 0.62), true));
    this.layers.set('alpha', this.createLayer(Math.round(maxParticles * 0.38), false));
  }

  private createLayer(capacity: number, additive: boolean): LayerBuffers {
    capacity = Math.max(32, capacity);

    const positions = new Float32Array(capacity * 3);
    const colors = new Float32Array(capacity * 3);
    const sizes = new Float32Array(capacity);
    const alphas = new Float32Array(capacity);
    const rotations = new Float32Array(capacity);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute('aRotation', new THREE.BufferAttribute(rotations, 1));
    geometry.setDrawRange(0, 0);
    // Particles are scattered all over the map; a fixed huge bounding sphere
    // avoids recomputing it every frame and prevents false culling.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      // Premultiplied output. Straight-alpha blending lets a texture's black
      // transparent border bleed in and darken the quad — with point sprites
      // that shows up as a dark SQUARE. Premultiplying makes that impossible:
      // a zero-alpha texel contributes exactly nothing.
      premultipliedAlpha: true,
      uniforms: {
        uTexture: { value: additive ? softCircleTexture() : smokePuffTexture() },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        attribute float aRotation;

        uniform float uPixelRatio;

        varying vec3 vColor;
        varying float vAlpha;
        varying float vRotation;

        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vRotation = aRotation;

          vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          // Perspective-correct sizing, with a floor so distant sparks remain
          // visible rather than disappearing into sub-pixel nothing.
          gl_PointSize = max( 1.0, aSize * uPixelRatio * 320.0 / max( -mvPosition.z, 0.6 ) );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTexture;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vRotation;

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float s = sin( vRotation );
          float c = cos( vRotation );
          uv = mat2( c, -s, s, c ) * uv + 0.5;
          vec4 tex = texture2D( uTexture, uv );
          float alpha = tex.a * vAlpha;
          if ( alpha < 0.004 ) discard;
          gl_FragColor = vec4( vColor * alpha, alpha );
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = additive ? 12 : 11;
    this.group.add(points);

    return {
      points,
      geometry,
      material,
      positions,
      colors,
      sizes,
      alphas,
      rotations,
      velX: new Float32Array(capacity),
      velY: new Float32Array(capacity),
      velZ: new Float32Array(capacity),
      life: new Float32Array(capacity),
      maxLife: new Float32Array(capacity),
      drag: new Float32Array(capacity),
      gravity: new Float32Array(capacity),
      sizeStart: new Float32Array(capacity),
      sizeEnd: new Float32Array(capacity),
      spin: new Float32Array(capacity),
      alive: new Uint8Array(capacity),
      bounce: new Uint8Array(capacity),
      capacity,
      count: 0,
      cursor: 0,
    };
  }

  setPixelRatio(ratio: number): void {
    for (const layer of this.layers.values()) layer.material.uniforms.uPixelRatio.value = ratio;
  }

  /** Swaps the sprite used by a layer, so callers can pick spark vs. sparkle. */
  private setLayerTexture(layer: LayerBuffers, texture: THREE.Texture): void {
    if (layer.material.uniforms.uTexture.value !== texture) {
      layer.material.uniforms.uTexture.value = texture;
    }
  }

  emit(layerName: LayerName, options: EmitOptions): void {
    const layer = this.layers.get(layerName);
    if (!layer) return;

    this._color.set(options.color as THREE.ColorRepresentation);
    const radius = options.radius ?? 0;

    for (let i = 0; i < options.count; i++) {
      const index = this.allocate(layer);
      if (index < 0) break;

      // --- Direction ---
      if (options.direction) {
        this._dir.copy(options.direction).normalize();
        // Random rotation within the cone.
        const theta = Math.random() * TAU;
        const cosSpread = Math.cos(options.spread);
        const z = randRange(cosSpread, 1);
        const sinPhi = Math.sqrt(Math.max(0, 1 - z * z));

        // Build an orthonormal basis around the cone axis.
        const ax = Math.abs(this._dir.x) < 0.9 ? 1 : 0;
        const ay = ax === 1 ? 0 : 1;
        const ux = this._dir.y * ay - this._dir.z * 0;
        const uy = this._dir.z * ax - this._dir.x * ay;
        const uz = this._dir.x * 0 - this._dir.y * ax;
        const uLen = Math.hypot(ux, uy, uz) || 1;
        const u = [ux / uLen, uy / uLen, uz / uLen];
        const v = [
          this._dir.y * u[2] - this._dir.z * u[1],
          this._dir.z * u[0] - this._dir.x * u[2],
          this._dir.x * u[1] - this._dir.y * u[0],
        ];

        const cosT = Math.cos(theta) * sinPhi;
        const sinT = Math.sin(theta) * sinPhi;
        this._dir.set(
          this._dir.x * z + u[0] * cosT + v[0] * sinT,
          this._dir.y * z + u[1] * cosT + v[1] * sinT,
          this._dir.z * z + u[2] * cosT + v[2] * sinT,
        );
      } else {
        // Uniform sphere.
        const z = randRange(-1, 1);
        const theta = Math.random() * TAU;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        this._dir.set(r * Math.cos(theta), z, r * Math.sin(theta));
      }

      const speed = options.speed + randRange(-options.speedVariance, options.speedVariance);

      layer.positions[index * 3] = options.position.x + randRange(-radius, radius);
      layer.positions[index * 3 + 1] = options.position.y + randRange(-radius, radius);
      layer.positions[index * 3 + 2] = options.position.z + randRange(-radius, radius);

      layer.velX[index] = this._dir.x * speed;
      layer.velY[index] = this._dir.y * speed;
      layer.velZ[index] = this._dir.z * speed;

      const variance = options.colorVariance;
      layer.colors[index * 3] = Math.max(0, this._color.r + randRange(-variance, variance));
      layer.colors[index * 3 + 1] = Math.max(0, this._color.g + randRange(-variance, variance));
      layer.colors[index * 3 + 2] = Math.max(0, this._color.b + randRange(-variance, variance));

      const life = Math.max(0.05, options.life + randRange(-options.lifeVariance, options.lifeVariance));
      layer.life[index] = life;
      layer.maxLife[index] = life;
      layer.sizeStart[index] = options.sizeStart * randRange(0.75, 1.3);
      layer.sizeEnd[index] = options.sizeEnd;
      layer.sizes[index] = layer.sizeStart[index];
      layer.alphas[index] = 1;
      layer.rotations[index] = Math.random() * TAU;
      layer.spin[index] = randRange(-options.spin, options.spin);
      layer.gravity[index] = options.gravity;
      layer.drag[index] = options.drag;
      layer.bounce[index] = options.bounce ? 1 : 0;
      layer.alive[index] = 1;
    }
  }

  /** Finds a free slot, recycling the oldest particle when the layer is full. */
  private allocate(layer: LayerBuffers): number {
    for (let attempt = 0; attempt < layer.capacity; attempt++) {
      const index = layer.cursor;
      layer.cursor = (layer.cursor + 1) % layer.capacity;
      if (!layer.alive[index]) {
        if (index >= layer.count) layer.count = index + 1;
        return index;
      }
    }
    // Every slot is busy — overwrite the one at the cursor.
    const index = layer.cursor;
    layer.cursor = (layer.cursor + 1) % layer.capacity;
    return index;
  }

  update(dt: number): void {
    for (const layer of this.layers.values()) this.updateLayer(layer, dt);
  }

  private updateLayer(layer: LayerBuffers, dt: number): void {
    let highest = 0;
    let anyAlive = false;

    for (let i = 0; i < layer.count; i++) {
      if (!layer.alive[i]) continue;

      layer.life[i] -= dt;
      if (layer.life[i] <= 0) {
        layer.alive[i] = 0;
        layer.alphas[i] = 0;
        layer.sizes[i] = 0;
        continue;
      }

      anyAlive = true;
      highest = i + 1;

      // Integrate.
      layer.velY[i] += layer.gravity[i] * dt;
      const dragFactor = Math.max(0, 1 - layer.drag[i] * dt);
      layer.velX[i] *= dragFactor;
      layer.velY[i] *= dragFactor;
      layer.velZ[i] *= dragFactor;

      const p = i * 3;
      layer.positions[p] += layer.velX[i] * dt;
      layer.positions[p + 1] += layer.velY[i] * dt;
      layer.positions[p + 2] += layer.velZ[i] * dt;

      // Ground bounce for debris.
      if (layer.bounce[i] && layer.positions[p + 1] < 0.02) {
        layer.positions[p + 1] = 0.02;
        layer.velY[i] = Math.abs(layer.velY[i]) * 0.38;
        layer.velX[i] *= 0.7;
        layer.velZ[i] *= 0.7;
        if (Math.abs(layer.velY[i]) < 0.35) layer.bounce[i] = 0;
      }

      // Fade and shrink over the particle's normalised lifetime.
      const t = 1 - layer.life[i] / layer.maxLife[i];
      layer.sizes[i] = layer.sizeStart[i] + (layer.sizeEnd[i] - layer.sizeStart[i]) * t;
      // Quick fade-in, long fade-out reads better than a linear ramp.
      layer.alphas[i] = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
      layer.rotations[i] += layer.spin[i] * dt;
    }

    layer.count = highest;
    layer.geometry.setDrawRange(0, highest);

    if (anyAlive || highest > 0) {
      (layer.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (layer.geometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
      (layer.geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      (layer.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
      (layer.geometry.attributes.aRotation as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  // Preset effects
  // -------------------------------------------------------------------------

  /** Bullet striking world geometry: sparks along the normal plus a dust puff. */
  bulletImpact(position: THREE.Vector3, normal: THREE.Vector3, surfaceColor: number): void {
    const additive = this.layers.get('additive')!;
    this.setLayerTexture(additive, sparkStreakTexture());

    this.emit('additive', {
      position,
      count: 7,
      speed: 5.5,
      speedVariance: 3,
      direction: normal,
      spread: 1.1,
      color: 0xffcf7a,
      colorVariance: 0.12,
      sizeStart: 0.03,
      sizeEnd: 0.004,
      life: 0.22,
      lifeVariance: 0.1,
      gravity: -9,
      drag: 3.2,
      spin: 8,
    });

    this.emit('alpha', {
      position,
      count: 4,
      speed: 1.4,
      speedVariance: 0.9,
      direction: normal,
      spread: 1.5,
      color: surfaceColor,
      colorVariance: 0.06,
      sizeStart: 0.05,
      sizeEnd: 0.16,
      life: 0.5,
      lifeVariance: 0.2,
      gravity: -1.2,
      drag: 3.4,
      spin: 2,
      radius: 0.04,
    });
  }

  /** Non-gory zombie hit: a burst of coloured confetti-like motes. */
  zombieHit(position: THREE.Vector3, direction: THREE.Vector3, color: number, critical: boolean): void {
    const additive = this.layers.get('additive')!;
    this.setLayerTexture(additive, critical ? sparkleTexture() : softCircleTexture());

    this.emit('additive', {
      position,
      count: critical ? 14 : 8,
      speed: critical ? 6.5 : 4.2,
      speedVariance: 2.4,
      direction,
      spread: critical ? 1.5 : 1.0,
      color: critical ? 0xfff0a0 : color,
      colorVariance: 0.18,
      sizeStart: critical ? 0.09 : 0.055,
      sizeEnd: 0.005,
      life: critical ? 0.5 : 0.34,
      lifeVariance: 0.14,
      gravity: -5.5,
      drag: 2.6,
      spin: 10,
      radius: 0.08,
    });
  }

  /** Death "poof": a cheerful cloud, deliberately nothing like blood. */
  zombiePoof(position: THREE.Vector3, color: number, scale: number): void {
    this.emit('alpha', {
      position,
      count: Math.round(12 * scale),
      speed: 2.4 * scale,
      speedVariance: 1.4,
      spread: Math.PI,
      color,
      colorVariance: 0.14,
      sizeStart: 0.22 * scale,
      sizeEnd: 0.62 * scale,
      life: 0.72,
      lifeVariance: 0.24,
      gravity: 1.1,
      drag: 2.9,
      spin: 1.6,
      radius: 0.22 * scale,
    });

    const additive = this.layers.get('additive')!;
    this.setLayerTexture(additive, sparkleTexture());
    this.emit('additive', {
      position,
      count: Math.round(10 * scale),
      speed: 3.6 * scale,
      speedVariance: 1.8,
      spread: Math.PI,
      color: 0xfff2c8,
      colorVariance: 0.2,
      sizeStart: 0.08 * scale,
      sizeEnd: 0.01,
      life: 0.6,
      lifeVariance: 0.2,
      gravity: -3,
      drag: 2.2,
      spin: 7,
      radius: 0.2 * scale,
    });
  }

  /** Big cartoon detonation. */
  explosion(position: THREE.Vector3, radius: number): void {
    const additive = this.layers.get('additive')!;
    this.setLayerTexture(additive, softCircleTexture());

    this.emit('additive', {
      position,
      count: 34,
      speed: radius * 2.6,
      speedVariance: radius * 1.2,
      spread: Math.PI,
      color: 0xffb04a,
      colorVariance: 0.2,
      sizeStart: 0.3,
      sizeEnd: 0.02,
      life: 0.55,
      lifeVariance: 0.2,
      gravity: -3,
      drag: 3.4,
      spin: 5,
      radius: 0.3,
    });

    this.emit('alpha', {
      position,
      count: 22,
      speed: radius * 1.4,
      speedVariance: radius * 0.6,
      spread: Math.PI,
      color: 0xdcc8b4,
      colorVariance: 0.1,
      sizeStart: 0.4,
      sizeEnd: 1.5,
      life: 1.1,
      lifeVariance: 0.4,
      gravity: 1.3,
      drag: 2.2,
      spin: 1.2,
      radius: 0.4,
    });
  }

  /** Muzzle smoke, emitted along the barrel. */
  muzzleSmoke(position: THREE.Vector3, direction: THREE.Vector3, scale: number): void {
    // Spawn down-barrel rather than at the muzzle itself: anything closer than
    // ~0.4 m fills a huge portion of the screen and reads as a smear, not smoke.
    const origin = position.clone().addScaledVector(direction, 0.42);
    this.emit('alpha', {
      position: origin,
      count: Math.round(3 * scale),
      speed: 2.6,
      speedVariance: 1.1,
      direction,
      spread: 0.55,
      color: 0xe4dcd0,
      colorVariance: 0.04,
      sizeStart: 0.03 * scale,
      sizeEnd: 0.16 * scale,
      life: 0.42,
      lifeVariance: 0.16,
      gravity: 0.7,
      drag: 4.6,
      spin: 2.2,
      radius: 0.02,
    });
  }

  /** Dust kicked up where a zombie's feet or a landing hits the ground. */
  groundDust(position: THREE.Vector3, amount: number): void {
    this.emit('alpha', {
      position,
      count: amount,
      speed: 1.6,
      speedVariance: 0.9,
      direction: new THREE.Vector3(0, 1, 0),
      spread: 1.35,
      color: 0xd0c0a4,
      colorVariance: 0.06,
      sizeStart: 0.1,
      sizeEnd: 0.42,
      life: 0.6,
      lifeVariance: 0.2,
      gravity: -0.6,
      drag: 3.6,
      spin: 1.4,
      radius: 0.15,
    });
  }

  /** Sparkle trail for coins flying toward the HUD. */
  coinSparkle(position: THREE.Vector3): void {
    const additive = this.layers.get('additive')!;
    this.setLayerTexture(additive, sparkleTexture());
    this.emit('additive', {
      position,
      count: 5,
      speed: 1.6,
      speedVariance: 0.9,
      spread: Math.PI,
      color: 0xffdc82,
      colorVariance: 0.1,
      sizeStart: 0.09,
      sizeEnd: 0.01,
      life: 0.55,
      lifeVariance: 0.2,
      gravity: 1.4,
      drag: 2.4,
      spin: 6,
      radius: 0.1,
    });
  }

  clear(): void {
    for (const layer of this.layers.values()) {
      layer.alive.fill(0);
      layer.alphas.fill(0);
      layer.sizes.fill(0);
      layer.count = 0;
      layer.cursor = 0;
      layer.geometry.setDrawRange(0, 0);
    }
  }

  dispose(): void {
    for (const layer of this.layers.values()) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
    this.layers.clear();
    this.group.clear();
  }
}
