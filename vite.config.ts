import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
} as any);
