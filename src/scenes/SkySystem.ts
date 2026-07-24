import * as THREE from 'three';
import { WORLD } from '../game/Config';
import { cloudTexture } from '../textures/ProceduralTextures';
import { clamp01, randRange, TAU } from '../utilities/MathUtils';

/**
 * Radius of the sky dome. The player camera's far plane is 400, so everything
 * in this file — dome, clouds, sun sprite, god rays — must sit comfortably
 * inside that or it gets clipped away entirely.
 */
const SKY_RADIUS = 340;

/**
 * Sky, sun and atmosphere.
 *
 * The dome is a single inverted sphere with a hand-tuned gradient shader that
 * outputs *linear HDR* values — the region around the sun exceeds 1.0 so the
 * bloom pass picks it up naturally, producing the glare you'd expect from
 * shooting into a sunset.
 *
 * On top of that sit three cheap layers: drifting billboard clouds, an additive
 * sun disc, and a fan of god-ray quads anchored to the sun direction.
 */
export class SkySystem {
  readonly group = new THREE.Group();

  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly clouds: THREE.Mesh[] = [];
  private readonly godRays: THREE.Mesh;
  private readonly sunSprite: THREE.Sprite;
  private readonly sunDirection = new THREE.Vector3(
    WORLD.sunDirection.x,
    WORLD.sunDirection.y,
    WORLD.sunDirection.z,
  ).normalize();

  private elapsed = 0;
  /** 0 = golden hour, 1 = deep dusk. Drives the slow day tint shift. */
  private duskAmount = 0;

  constructor(quality: { godRays: boolean; fogDetail: boolean }) {
    this.group.name = 'SkySystem';

    // ---- Gradient dome -----------------------------------------------------
    this.skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTopColor: { value: new THREE.Color(WORLD.skyTopColor) },
        uHorizonColor: { value: new THREE.Color(WORLD.skyHorizonColor) },
        uGroundColor: { value: new THREE.Color(0x6b4a5c) },
        uSunColor: { value: new THREE.Color(WORLD.skySunColor) },
        uSunDirection: { value: this.sunDirection.clone() },
        uExponent: { value: 0.72 },
        uSunIntensity: { value: 1.35 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldDirection;
        void main() {
          // Direction from the camera to this vertex, in world space.
          vWorldDirection = normalize( ( modelMatrix * vec4( position, 1.0 ) ).xyz );
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTopColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uGroundColor;
        uniform vec3 uSunColor;
        uniform vec3 uSunDirection;
        uniform float uExponent;
        uniform float uSunIntensity;
        uniform float uTime;

        varying vec3 vWorldDirection;

        // Cheap hash-based dithering kills the banding a smooth sky gradient
        // would otherwise show on 8-bit displays.
        float dither( vec2 p ) {
          return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
        }

        void main() {
          vec3 dir = normalize( vWorldDirection );
          float h = dir.y;

          // Sky gradient: horizon -> zenith above, muted bounce below.
          float t = pow( clamp( h, 0.0, 1.0 ), uExponent );
          vec3 color = mix( uHorizonColor, uTopColor, t );
          color = mix( color, uGroundColor, smoothstep( 0.0, -0.28, h ) );

          // Broad atmospheric scattering halo around the sun.
          float sunDot = max( dot( dir, uSunDirection ), 0.0 );
          float halo = pow( sunDot, 5.0 ) * 0.55 + pow( sunDot, 60.0 ) * 0.9;
          color += uSunColor * halo * uSunIntensity;

          // Tight core disc — the one thing deliberately over the bloom
          // threshold, so the sun glares and nothing else does.
          float disc = smoothstep( 0.9975, 0.9993, sunDot );
          color += uSunColor * disc * 2.6;

          // Warm band hugging the horizon.
          float horizonGlow = exp( -abs( h ) * 9.0 ) * 0.35;
          color += uHorizonColor * horizonGlow;

          color += ( dither( gl_FragCoord.xy ) - 0.5 ) * 0.008;
          gl_FragColor = vec4( color, 1.0 );
        }
      `,
    });

    // MUST stay inside the camera's far plane (400) or the entire dome is
    // clipped and the sky renders as the empty clear colour.
    const domeGeometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 20);
    const dome = new THREE.Mesh(domeGeometry, this.skyMaterial);
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    this.group.add(dome);

    // ---- Sun sprite --------------------------------------------------------
    const sunMaterial = new THREE.SpriteMaterial({
      map: cloudTexture(),
      color: 0xfff0c8,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.sunSprite = new THREE.Sprite(sunMaterial);
    this.sunSprite.scale.set(150, 95, 1);
    this.sunSprite.position.copy(this.sunDirection).multiplyScalar(SKY_RADIUS * 0.8);
    this.sunSprite.renderOrder = -998;
    this.group.add(this.sunSprite);

    // ---- Billboard clouds --------------------------------------------------
    this.buildClouds(quality.fogDetail ? 22 : 10);

    // ---- God rays ----------------------------------------------------------
    this.godRays = this.buildGodRays();
    this.godRays.visible = quality.godRays;
    this.group.add(this.godRays);
  }

  private buildClouds(count: number): void {
    const texture = cloudTexture();
    // One shared geometry, one shared material: the whole cloud layer costs a
    // handful of draw calls and no per-cloud allocation.
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < count; i++) {
      const mat = material.clone();
      // Clouds nearer the sun read hotter; distant ones drift toward lavender.
      const warmth = Math.random();
      mat.color.setHSL(0.06 + warmth * 0.06, 0.55, 0.72 + warmth * 0.18);
      mat.opacity = randRange(0.3, 0.72);

      const mesh = new THREE.Mesh(geometry, mat);
      const angle = (i / count) * TAU + randRange(-0.2, 0.2);
      const radius = randRange(SKY_RADIUS * 0.45, SKY_RADIUS * 0.82);
      const height = randRange(45, 150);
      mesh.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
      const scale = randRange(70, 170);
      mesh.scale.set(scale, scale * randRange(0.34, 0.52), 1);
      mesh.renderOrder = -999;
      mesh.userData.drift = randRange(0.0006, 0.0022);
      mesh.userData.bobPhase = Math.random() * TAU;
      mesh.userData.baseY = height;
      this.clouds.push(mesh);
      this.group.add(mesh);
    }
  }

  /**
   * God rays as a fan of additive quads radiating from the sun. Cheaper and
   * more art-directable than a screen-space radial blur, and it survives being
   * looked at from any angle.
   */
  private buildGodRays(): THREE.Mesh {
    const rayCount = 9;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < rayCount; i++) {
      const t = i / rayCount;
      const angle = t * TAU;
      const width = randRange(5, 16);
      const length = randRange(110, 200);
      const spread = randRange(1.4, 3.2);

      const base = i * 4;
      // A tapered quad, narrow at the sun and flaring outward.
      positions.push(
        Math.cos(angle) * width * 0.35, 0, Math.sin(angle) * width * 0.35,
        Math.cos(angle + 0.12) * width * 0.35, 0, Math.sin(angle + 0.12) * width * 0.35,
        Math.cos(angle + 0.12) * width * spread, -length, Math.sin(angle + 0.12) * width * spread,
        Math.cos(angle) * width * spread, -length, Math.sin(angle) * width * spread,
      );
      uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uColor: { value: new THREE.Color(0xffd9a0) },
        uOpacity: { value: 0.16 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          // Fade along the shaft and soften both long edges.
          float alongShaft = smoothstep( 0.0, 0.42, vUv.y ) * smoothstep( 1.0, 0.55, vUv.y );
          float acrossShaft = smoothstep( 0.0, 0.4, vUv.x ) * smoothstep( 1.0, 0.6, vUv.x );
          // Slow shimmer so the beams feel alive rather than painted on.
          float shimmer = 0.82 + 0.18 * sin( uTime * 0.6 + vUv.x * 8.0 );
          gl_FragColor = vec4( uColor, alongShaft * acrossShaft * uOpacity * shimmer );
        }
      `,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(this.sunDirection).multiplyScalar(SKY_RADIUS * 0.72);
    // Orient the fan so the shafts stream down-sun toward the village.
    mesh.lookAt(0, 0, 0);
    mesh.rotateX(Math.PI * 0.5);
    mesh.frustumCulled = false;
    mesh.renderOrder = -997;
    return mesh;
  }

  get sunWorldDirection(): THREE.Vector3 {
    return this.sunDirection;
  }

  setGodRaysEnabled(enabled: boolean): void {
    this.godRays.visible = enabled;
  }

  /**
   * Slowly shifts the palette toward dusk as waves progress, so wave 15 feels
   * meaningfully later in the evening than wave 1 without a hard cut.
   */
  setDusk(amount: number): void {
    this.duskAmount = clamp01(amount);
    const u = this.skyMaterial.uniforms;
    (u.uTopColor.value as THREE.Color)
      .set(WORLD.skyTopColor)
      .lerp(new THREE.Color(0x141033), this.duskAmount * 0.85);
    (u.uHorizonColor.value as THREE.Color)
      .set(WORLD.skyHorizonColor)
      .lerp(new THREE.Color(0xd2506a), this.duskAmount * 0.7);
    u.uSunIntensity.value = 2.6 - this.duskAmount * 1.5;
    (this.sunSprite.material as THREE.SpriteMaterial).opacity = 0.55 - this.duskAmount * 0.32;
    (this.godRays.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.16 * (1 - this.duskAmount * 0.75);
  }

  get dusk(): number {
    return this.duskAmount;
  }

  update(dt: number, cameraPosition: THREE.Vector3): void {
    this.elapsed += dt;
    this.skyMaterial.uniforms.uTime.value = this.elapsed;
    (this.godRays.material as THREE.ShaderMaterial).uniforms.uTime.value = this.elapsed;

    // The whole dome follows the camera so it can never be walked out of.
    this.group.position.set(cameraPosition.x, 0, cameraPosition.z);

    for (const cloud of this.clouds) {
      const drift = cloud.userData.drift as number;
      const angle = Math.atan2(cloud.position.z, cloud.position.x) + drift * dt * 60;
      const radius = Math.hypot(cloud.position.x, cloud.position.z);
      cloud.position.x = Math.cos(angle) * radius;
      cloud.position.z = Math.sin(angle) * radius;
      cloud.position.y =
        (cloud.userData.baseY as number) +
        Math.sin(this.elapsed * 0.18 + (cloud.userData.bobPhase as number)) * 4;
      // Billboards always face the camera's horizontal position.
      cloud.lookAt(cameraPosition.x, cloud.position.y, cameraPosition.z);
    }
  }

  dispose(): void {
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.group.clear();
  }
}
