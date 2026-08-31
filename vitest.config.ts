import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      'tests/**/*.live.test.ts',
      'tests/composition.test.ts',
      'tests/evals.test.ts',
      'tests/headless.test.ts',
      'tests/isolation.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 20_000,
  },
})

