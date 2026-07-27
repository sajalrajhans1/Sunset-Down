import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';

/**
 * Serves the `api/` Edge functions during `npm run dev`.
 *
 * In production Vercel runs these itself, but without this the leaderboard
 * would be untestable locally — every request would fall through to index.html
 * and the client would quietly drop into its offline board. The handlers are
 * loaded through Vite's own module runner, so they pick up edits on save just
 * like the game does.
 */
function apiDevServer(): Plugin {
  return {
    name: 'sunset-hollow-api-dev',
    apply: 'serve',
    config(_config, { mode }) {
      // On Vercel these arrive in process.env already. Locally they live in
      // .env.local, which Vite exposes to the client bundle but not to modules
      // it loads server-side — so copy them across for the handlers to read.
      const env = loadEnv(mode, process.cwd(), '');
      for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LEADERBOARD_SECRET']) {
        if (env[key] && !process.env[key]) process.env[key] = env[key];
      }
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();

        const route = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
        if (!/^[a-z0-9-]+$/i.test(route)) return next();

        try {
          const module = await server.ssrLoadModule(`/api/${route}.ts`);
          const handler = module.default as (request: Request) => Promise<Response>;
          if (typeof handler !== 'function') return next();

          // Node's stream into a Web Request the handler understands.
          const body =
            req.method === 'GET' || req.method === 'HEAD'
              ? undefined
              : await new Promise<string>((resolve) => {
                  let raw = '';
                  req.on('data', (chunk) => (raw += chunk));
                  req.on('end', () => resolve(raw));
                });

          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body,
          });

          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(await response.text());
        } catch (error) {
          // A broken API route should surface as a 500 with the reason, not as
          // a silent fall-through to the HTML page.
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [apiDevServer()],
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
