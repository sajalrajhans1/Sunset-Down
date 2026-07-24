/** Standard easing curves for animation and UI transitions. All take/return 0..1. */

export const Easing = {
  linear: (t: number): number => t,

  quadIn: (t: number): number => t * t,
  quadOut: (t: number): number => t * (2 - t),
  quadInOut: (t: number): number => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),

  cubicIn: (t: number): number => t * t * t,
  cubicOut: (t: number): number => 1 - Math.pow(1 - t, 3),
  cubicInOut: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),

  quartOut: (t: number): number => 1 - Math.pow(1 - t, 4),
  quintOut: (t: number): number => 1 - Math.pow(1 - t, 5),

  expoOut: (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  expoIn: (t: number): number => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),

  sineIn: (t: number): number => 1 - Math.cos((t * Math.PI) / 2),
  sineOut: (t: number): number => Math.sin((t * Math.PI) / 2),
  sineInOut: (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2,

  circOut: (t: number): number => Math.sqrt(1 - Math.pow(t - 1, 2)),

  /** Overshoots slightly past 1 then settles — great for UI pops. */
  backOut: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },

  elasticOut: (t: number): number => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },

  bounceOut: (t: number): number => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },

  /** Rises fast, falls back to 0 — one-shot impulse shape for recoil/kick. */
  impulse: (t: number): number => {
    const h = 8 * t;
    return h * Math.exp(1 - h);
  },
};

export type EasingFn = (t: number) => number;
