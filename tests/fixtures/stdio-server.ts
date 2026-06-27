// Standalone MCP server for stdio integration tests. Spawned as a child process by stdio.test.ts.
// Reads INGEST_URL from the environment so tests can point it at a local capture server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { withArthurAnalytics } from '../../src/index.js'

const server = new McpServer({ name: 'stdio-test-server', version: '0.0.1' })

server.tool('ping', { message: z.string() }, async ({ message }) => ({
  content: [{ type: 'text' as const, text: `pong: ${message}` }],
}))

server.tool('slow', { delayMs: z.number() }, async ({ delayMs }) => {
  await new Promise((r) => setTimeout(r, delayMs))
  return { content: [{ type: 'text' as const, text: 'done' }] }
})

const ingestUrl = process.env['INGEST_URL'] ?? 'http://127.0.0.1:0'

const instrumented = withArthurAnalytics(server, {
  publisherKey: 'pk_test_stdio',
  serverSlug: 'stdio-test-server',
  ingestUrl,
  flushIntervalMs: 200,
  maxBatchSize: 50,
})

const transport = new StdioServerTransport()
await instrumented.connect(transport)
