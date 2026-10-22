import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Its wall-clock budgets run separately, after the parallel workers exit.
    // `make check` and the root test command also run test:serial.
    exclude: [...configDefaults.exclude, 'src/network/html-markdown.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    // Git/process-heavy integration suites contend badly at the default
    // machine-wide worker count and can cross their safety timeout despite
    // passing in isolation. Bound concurrency without relaxing normal tests.
    minWorkers: 2,
    maxWorkers: 6,
  },
})
