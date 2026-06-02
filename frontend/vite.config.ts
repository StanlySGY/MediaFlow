/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../app/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/asr': 'http://localhost:8999',
      '/auth': 'http://localhost:8999',
      '/health': 'http://localhost:8999',
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
})
