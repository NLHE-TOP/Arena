import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
  // `vite dev` proxies the same-origin product API to the local product server
  // (default PORT=3001). Production serves dist/web from the API process.
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
});
