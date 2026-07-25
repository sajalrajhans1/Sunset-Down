/// <reference types="vite/client" />

/**
 * Vite's client types cover images, fonts and media, but not 3D model formats.
 * Declaring it here lets `import model from './x.glb'` resolve to the hashed
 * asset URL with full type safety.
 */
declare module '*.glb' {
  const src: string;
  export default src;
}

declare module '*.gltf' {
  const src: string;
  export default src;
}
