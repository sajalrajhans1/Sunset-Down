import * as THREE from 'three';

/**
 * Stylised motion blur.
 *
 * A true velocity-buffer blur would need a second geometry pass, which is far
 * too expensive for our frame budget. Instead we approximate the effect the
 * player actually perceives: when you whip the camera around or sprint, the
 * periphery smears radially outward while the screen centre stays sharp.
 *
 * Driven by camera angular velocity + sprint speed, this reads as convincing
 * motion blur at the cost of 8 texture taps on a fraction of the screen.
 */
export const RadialBlurShader = {
  name: 'RadialBlurShader',

  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 0 = disabled (early-outs), 1 = maximum smear. */
    uStrength: { value: 0.0 },
    /** Screen-space focal point, nudged by look direction for a lead-in feel. */
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    /** Radius at which the blur begins; inside this the image is untouched. */
    uInnerRadius: { value: 0.18 },
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
    uniform float uStrength;
    uniform vec2 uCenter;
    uniform float uInnerRadius;

    varying vec2 vUv;

    #define SAMPLES 8

    void main() {
      vec4 base = texture2D( tDiffuse, vUv );

      // Early-out keeps the pass effectively free when the player is still.
      if ( uStrength <= 0.001 ) {
        gl_FragColor = base;
        return;
      }

      vec2 toCenter = vUv - uCenter;
      float dist = length( toCenter );
      float falloff = smoothstep( uInnerRadius, 0.78, dist );

      if ( falloff <= 0.001 ) {
        gl_FragColor = base;
        return;
      }

      float amount = uStrength * falloff * 0.09;
      vec4 sum = base;
      float weightSum = 1.0;

      for ( int i = 1; i <= SAMPLES; i++ ) {
        float t = float( i ) / float( SAMPLES );
        // Weight nearer samples higher so the smear tapers instead of ghosting.
        float w = 1.0 - t * 0.72;
        vec2 uvOffset = vUv - toCenter * t * amount;
        sum += texture2D( tDiffuse, uvOffset ) * w;
        weightSum += w;
      }

      gl_FragColor = sum / weightSum;
    }
  `,
};
