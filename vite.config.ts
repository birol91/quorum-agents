import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer only. root = src/renderer; built to dist/renderer for Electron to load.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
