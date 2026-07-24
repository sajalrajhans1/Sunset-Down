import * as THREE from 'three';

/**
 * The single biggest lever on "does this look like an animated film".
 *
 * Three.js's stock PBR shading is physically plausible but reads flat and cold
 * on stylised geometry. We patch the standard/toon shaders with three cheap
 * additions that animation studios lean on heavily:
 *
 *   1. **Rim light** — a fresnel term in the sunset colour that separates every
 *      silhouette from the background. This is what makes characters "pop".
 *   2. **Wrapped subsurface** — light bleeding through thin geometry when the
 *      sun is behind it (leaves, cloth, zombie ears).
 *   3. **Vertex wind** — per-vertex sway above a height threshold, so foliage,
 *      bunting and tent fabric never sit perfectly still.
 *
 * All three are injected via onBeforeCompile so we keep Three's shadow,
 * fog and tonemapping pipeline intact.
 */

export interface StylizedShadingOptions {
  /** Fresnel rim colour. Defaults to a warm sunset gold. */
  rimColor?: THREE.ColorRepresentation;
  rimStrength?: number;
  /** Higher = tighter rim confined to the silhouette edge. */
  rimPower?: number;
  /** Backlight bleed colour, usually a saturated version of the albedo. */
  subsurfaceColor?: THREE.ColorRepresentation;
  subsurfaceStrength?: number;
  wind?: WindOptions;
}

export interface WindOptions {
  strength: number;
  speed: number;
  /** Sway ramps in between these two local-space Y values. */
  minY: number;
  maxY: number;
  /** Randomises phase per material so props don't sway in lockstep. */
  phase?: number;
}

interface StylizedUniforms {
  uTime: { value: number };
  uRimColor: { value: THREE.Color };
  uRimStrength: { value: number };
  uRimPower: { value: number };
  uSssColor: { value: THREE.Color };
  uSssStrength: { value: number };
  uWindStrength: { value: number };
  uWindSpeed: { value: number };
  uWindMinY: { value: number };
  uWindMaxY: { value: number };
  uWindPhase: { value: number };
}

/** Every patched material's uniform block, ticked once per frame. */
const registry: StylizedUniforms[] = [];

let patchCounter = 0;

export function applyStylizedShading<T extends THREE.Material>(
  material: T,
  options: StylizedShadingOptions = {},
): T {
  const hasWind = !!options.wind;
  const uniforms: StylizedUniforms = {
    uTime: { value: 0 },
    uRimColor: { value: new THREE.Color(options.rimColor ?? 0xffb473) },
    uRimStrength: { value: options.rimStrength ?? 0.42 },
    uRimPower: { value: options.rimPower ?? 2.6 },
    uSssColor: { value: new THREE.Color(options.subsurfaceColor ?? 0xff8f5a) },
    uSssStrength: { value: options.subsurfaceStrength ?? 0.0 },
    uWindStrength: { value: options.wind?.strength ?? 0 },
    uWindSpeed: { value: options.wind?.speed ?? 1 },
    uWindMinY: { value: options.wind?.minY ?? 0 },
    uWindMaxY: { value: options.wind?.maxY ?? 1 },
    uWindPhase: { value: options.wind?.phase ?? Math.random() * 100 },
  };

  const cacheKey = `stylized-${hasWind ? 'wind' : 'still'}-${patchCounter++}`;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    if (hasWind) {
      shader.vertexShader = `
        uniform float uTime;
        uniform float uWindStrength;
        uniform float uWindSpeed;
        uniform float uWindMinY;
        uniform float uWindMaxY;
        uniform float uWindPhase;
      ${shader.vertexShader}`;

      // Two out-of-phase sine waves produce a lazy figure-of-eight sway that
      // looks far more organic than a single axis wobble.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        {
          float windT = uTime * uWindSpeed + uWindPhase;
          float influence = smoothstep(uWindMinY, uWindMaxY, position.y);
          influence *= influence;
          float swayX = sin(windT + position.x * 0.42 + position.z * 0.31);
          float swayZ = cos(windT * 0.83 + position.z * 0.37 - position.x * 0.22);
          // A faint high-frequency flutter on top of the base sway.
          float flutter = sin(windT * 3.1 + position.y * 2.4) * 0.22;
          transformed.x += (swayX + flutter) * uWindStrength * influence;
          transformed.z += swayZ * uWindStrength * 0.7 * influence;
          transformed.y -= abs(swayX) * uWindStrength * 0.14 * influence;
        }
        `,
      );
    }

    shader.fragmentShader = `
      uniform vec3 uRimColor;
      uniform float uRimStrength;
      uniform float uRimPower;
      uniform vec3 uSssColor;
      uniform float uSssStrength;
    ${shader.fragmentShader}`;

    // Injected before tonemapping so our contribution lives in linear space and
    // is correctly graded by ACES along with everything else.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      /* glsl */ `
      {
        vec3 viewDirStylized = normalize( vViewPosition );
        float fresnel = 1.0 - saturate( dot( viewDirStylized, normal ) );
        float rim = pow( fresnel, uRimPower ) * uRimStrength;
        gl_FragColor.rgb += uRimColor * rim;

        #if ( NUM_DIR_LIGHTS > 0 )
        if ( uSssStrength > 0.0 ) {
          // Light travelling *through* the surface toward the camera.
          vec3 sunDir = normalize( directionalLights[ 0 ].direction );
          float backScatter = saturate( dot( viewDirStylized, -sunDir ) );
          backScatter = pow( backScatter, 3.0 );
          float thinness = 1.0 - abs( dot( normal, sunDir ) ) * 0.55;
          gl_FragColor.rgb += uSssColor * directionalLights[ 0 ].color * backScatter * thinness * uSssStrength;
        }
        #endif
      }
      #include <tonemapping_fragment>
      `,
    );
  };

  // Without a distinct cache key Three would reuse one compiled program for all
  // materials sharing the same defines, and every patch would collapse into one.
  material.customProgramCacheKey = () => cacheKey;

  registry.push(uniforms);
  material.userData.stylizedUniforms = uniforms;
  return material;
}

/** Advances the shared shader clock. Called once per frame from the game loop. */
export function updateStylizedTime(elapsed: number): void {
  for (let i = 0; i < registry.length; i++) registry[i].uTime.value = elapsed;
}

/** Lets gameplay code pulse a material's rim (e.g. zombie hit flash). */
export function setRimStrength(material: THREE.Material, strength: number): void {
  const uniforms = material.userData.stylizedUniforms as StylizedUniforms | undefined;
  if (uniforms) uniforms.uRimStrength.value = strength;
}

export function clearStylizedRegistry(): void {
  registry.length = 0;
}

/**
 * Convenience factory: a stylised standard material tuned for the village.
 * Slightly high roughness and zero metalness keeps surfaces matte and painterly.
 */
export function stylizedStandard(
  params: THREE.MeshStandardMaterialParameters,
  stylize: StylizedShadingOptions = {},
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.82,
    metalness: 0.0,
    ...params,
  });
  return applyStylizedShading(mat, stylize);
}

/** Character shading: toon ramp + strong rim, deliberately distinct from props. */
export function stylizedToon(
  params: THREE.MeshToonMaterialParameters,
  stylize: StylizedShadingOptions = {},
): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial(params);
  return applyStylizedShading(mat, { rimStrength: 0.55, rimPower: 2.2, ...stylize });
}
