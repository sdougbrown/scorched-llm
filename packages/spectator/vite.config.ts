import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@scorched-llm/engine': new URL('../engine/src/index.ts', import.meta.url).pathname,
    },
  },
})