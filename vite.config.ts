/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    // Server mode in development: `npm run dev:server` serves the API on :8787.
    proxy: { '/api': { target: process.env.IMAGINARIUM_API ?? 'http://localhost:8787', changeOrigin: false } },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('@xyflow')) return 'flow';
          if (id.includes('jspdf') || id.includes('html2canvas') || id.includes('canvg') || id.includes('dompurify')) return 'pdf';
          if (id.includes('@supabase')) return 'supabase';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 60000,
    hookTimeout: 120000,
    globalSetup: ['tests/globalSetup.ts'],
  },
});
