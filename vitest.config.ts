// Vitest configuration — Node environment unit-test run for the Arthur MCP SDK.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // Workers pool + integration/contract suites are wired in Phase 2.
  },
})
