import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Vite treats unknown extensions as JavaScript and tries to parse them for
  // imports. 3D model formats have to be declared explicitly so they're copied
  // and hashed as assets instead.
  assetsInclude: ['**/*.glb', '**/*.gltf'],
  server: {
    port: 5173,
    open: true,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
