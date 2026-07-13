import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@scorched-llm/engine': resolve(__dirname, '../engine/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
  },
})
