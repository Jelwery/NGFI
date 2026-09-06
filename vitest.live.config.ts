import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.live.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
})
