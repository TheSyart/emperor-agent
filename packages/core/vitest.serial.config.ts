import { defineConfig } from 'vitest/config'

/** Keep the existing HTML conversion time limits free of other test workers. */
export default defineConfig({
  test: {
    include: ['src/network/html-markdown.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    minWorkers: 1,
    maxWorkers: 1,
    fileParallelism: false,
  },
})
