import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      thresholds: {
        // The repo's stated >80% aim, enforced (actuals run ~90+).
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
