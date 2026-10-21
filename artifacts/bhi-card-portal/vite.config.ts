import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// The frontend's env file, artifacts/bhi-card-portal/.env. With an empty prefix
// loadEnv returns every key, and anything already in process.env wins — so the
// Docker build's ENV lines and one-off shell overrides still apply. Only VITE_*
// keys ever reach client code, so none of these end up in the bundle.
const env = loadEnv(
  process.env.NODE_ENV ?? 'development',
  import.meta.dirname,
  '',
);

const rawPort = env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = env.BASE_PATH;

// Optional. When set, the dev server forwards /api to the API so the app runs
// same-origin, exactly as it does behind nginx — no CORS configuration needed.
const apiProxyTarget = env.API_PROXY_TARGET;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

// A base of one path segment at most — "/" or "/portal". The pattern is here to
// catch one specific accident rather than to be strict for its own sake.
//
// Git Bash rewrites an argument that looks like a Unix absolute path into a
// Windows one, so `BASE_PATH=/ vite build` arrives as the Git installation
// directory. The build then succeeds and stamps every asset URL with it —
// "/Users/.../Programs/Git/assets/index-abc.js" — which no server maps to a
// file. The static server answers those with the SPA fallback, the browser
// parses index.html as JavaScript, and the app renders a blank white page with a
// single console error. Nothing before this check notices.
//
// Set it from PowerShell (`$env:BASE_PATH="/"`, as deploy/LOCAL-DEV.md shows) or
// prefix the shell call with MSYS_NO_PATHCONV=1. Widen the pattern if a deeper
// base is ever genuinely needed.
if (!/^\/(?:[\w.~-]+\/?)?$/.test(basePath)) {
  throw new Error(
    `Invalid BASE_PATH value: "${basePath}". Expected "/" or a single segment ` +
      'such as "/portal". A value like "/Users/.../Programs/Git" means the ' +
      'shell rewrote a leading slash — set BASE_PATH from PowerShell, or ' +
      'prefix the command with MSYS_NO_PATHCONV=1.',
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    ...(apiProxyTarget
      ? { proxy: { '/api': { target: apiProxyTarget, changeOrigin: true } } }
      : {}),
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
