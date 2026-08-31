import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.live.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
})

