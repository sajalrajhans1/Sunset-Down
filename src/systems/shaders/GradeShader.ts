import * as THREE from 'three';

/**
 * Final image-quality pass. Runs after tonemapping, so it works on
 * display-referred sRGB values.
 *
 * Bundles everything that would otherwise need its own pass:
 *   • split-tone colour grading (warm highlights / plum shadows)
 *   • saturation + contrast lift for the animated-film look
 *   • radial chromatic aberration at the frame edges
 *   • vignette
 *   • animated film grain that fades out in highlights
 *   • damage overlay (red pulse from the edges inward)
 *   • low-health desaturation
 *   • full-screen flash for explosions and wave transitions
 *
 * One pass instead of seven keeps the fragment cost to a single texture read
 * plus two extra taps for the aberration.
 */
export const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },

    uSaturation: { value: 1.14 },
    uContrast: { value: 1.06 },
    uBrightness: { value: 1.0 },
    uHighlightTint: { value: new THREE.Color(0xffd9a8) },
    uShadowTint: { value: new THREE.Color(0x5a4b86) },
    uTintStrength: { value: 0.16 },

    uVignette: { value: 0.28 },
    // Scaled by ~2.5 px at the frame edge — enough to feel like a lens, far
    // below the point where it reads as a broken display.
    uAberration: { value: 0.0011 },
    uGrain: { value: 0.016 },

    uDamage: { value: 0.0 },
    uLowHealth: { value: 0.0 },
    uFlash: { value: 0.0 },
    uFlashColor: { value: new THREE.Color(0xffffff) },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;

    uniform float uSaturation;
    uniform float uContrast;
    uniform float uBrightness;
    uniform vec3 uHighlightTint;
    uniform vec3 uShadowTint;
    uniform float uTintStrength;

    uniform float uVignette;
    uniform float uAberration;
    uniform float uGrain;

    uniform float uDamage;
    uniform float uLowHealth;
    uniform float uFlash;
    uniform vec3 uFlashColor;

    varying vec2 vUv;

    const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

    float hash( vec2 p ) {
      p = fract( p * vec2( 443.897, 441.423 ) );
      p += dot( p, p.yx + 19.19 );
      return fract( ( p.x + p.y ) * p.x );
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float dist = length( centered );

      // --- Chromatic aberration: red/blue drift outward, quadratic with radius.
      // The multiplier here is a UV-space scale: at dist 0.5 a value of 3.0
      // gives ~0.0008 UV of separation, roughly 1.5 px at 1080p.
      float aberration = uAberration * ( 1.0 + uDamage * 3.0 );
      vec2 offset = centered * dist * aberration * 3.0;
      vec3 color;
      color.r = texture2D( tDiffuse, uv + offset ).r;
      color.g = texture2D( tDiffuse, uv ).g;
      color.b = texture2D( tDiffuse, uv - offset ).b;

      // --- Split toning. Shadows drift plum, highlights drift gold.
      float luma = dot( color, LUMA );
      vec3 tint = mix( uShadowTint, uHighlightTint, smoothstep( 0.15, 0.85, luma ) );
      color = mix( color, color * tint * 2.0, uTintStrength );

      // --- Contrast around mid-grey, then saturation, then exposure.
      color = ( color - 0.5 ) * uContrast + 0.5;
      luma = dot( color, LUMA );
      color = mix( vec3( luma ), color, uSaturation );
      color *= uBrightness;

      // --- Low health drains the colour out of the world.
      if ( uLowHealth > 0.0 ) {
        float pulse = 0.5 + 0.5 * sin( uTime * 5.5 );
        float drain = uLowHealth * ( 0.55 + pulse * 0.45 );
        color = mix( color, vec3( dot( color, LUMA ) ) * vec3( 1.1, 0.82, 0.86 ), drain * 0.7 );
      }

      // --- Vignette.
      float vig = smoothstep( 0.92, 0.22, dist );
      color *= mix( 1.0, vig, uVignette );

      // --- Damage overlay bleeding in from the corners.
      if ( uDamage > 0.0 ) {
        float edge = smoothstep( 0.18, 0.72, dist );
        vec3 hurt = vec3( 1.0, 0.16, 0.24 );
        color = mix( color, hurt, edge * uDamage * 0.72 );
      }

      // --- Screen flash (explosions, wave start, boss spawn).
      color = mix( color, uFlashColor, clamp( uFlash, 0.0, 1.0 ) );

      // --- Animated grain, suppressed in the highlights so skies stay clean.
      float grain = hash( uv * uResolution + fract( uTime ) * 137.0 ) - 0.5;
      color += grain * uGrain * ( 1.0 - smoothstep( 0.55, 1.0, dot( color, LUMA ) ) );

      gl_FragColor = vec4( clamp( color, 0.0, 1.0 ), 1.0 );
    }
  `,
};
