// Shared factory for integration tests: an instrumented McpServer with three predictable tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { withArthurAnalytics, type InstrumentedMcpServer } from '../../src/index.js'

export interface TestServerOptions {
  ingestUrl: string
  maxBatchSize?: number
  flushIntervalMs?: number
  captureErrorMessages?: boolean
  captureInputShape?: boolean
  captureOutputTypes?: boolean
}

/**
 * Create a fresh {@link InstrumentedMcpServer} with three test tools wired up.
 * - `echo`: returns the input message as text content
 * - `fail`: always throws (simulates a broken tool)
 * - `multi_output`: returns N content blocks alternating text/image types
 *
 * @param options - Ingest URL and optional config overrides.
 */
export function createTestServer(options: TestServerOptions): InstrumentedMcpServer {
  const server = new McpServer({ name: 'test-server', version: '1.2.3' })

  server.tool('echo', { message: z.string() }, async ({ message }) => ({
    content: [{ type: 'text' as const, text: message }],
  }))

  server.tool('fail', {}, async () => {
    throw new Error('deliberate tool failure')
  })

  server.tool('multi_output', { count: z.number() }, async ({ count }) => ({
    content: Array.from({ length: count }, (_, i) =>
      i % 2 === 0
        ? { type: 'text' as const, text: `item ${i}` }
        : { type: 'image' as const, data: 'base64data', mimeType: 'image/png' }
    ),
  }))

  return withArthurAnalytics(server, {
    publisherKey: 'pk_test_integration',
    serverSlug: 'test-server',
    ingestUrl: options.ingestUrl,
    maxBatchSize: options.maxBatchSize ?? 50,
    flushIntervalMs: options.flushIntervalMs ?? 30_000,
    capture: {
      errorMessages: options.captureErrorMessages ?? false,
      inputShape: options.captureInputShape ?? true,
      outputTypes: options.captureOutputTypes ?? true,
    },
  })
}
