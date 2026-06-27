// Vitest configuration for Cloudflare Workers integration tests.
// Uses the cloudflareTest plugin from @cloudflare/vitest-pool-workers to run
// tests inside the actual Workers runtime via Miniflare.
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test-wrangler.toml' },
    }),
  ],
  test: {
    include: ['tests/integration/cloudflare.test.ts'],
    testTimeout: 15_000,
  },
})
