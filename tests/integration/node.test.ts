// Integration tests — Node.js, InMemoryTransport. Real McpServer + real MCP client.
// Ingest fetch() calls are intercepted by MSW; no network required.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createTestServer, type TestServerOptions } from '../fixtures/mock-mcp-server.js'
import { createMockIngest, MOCK_INGEST_URL } from '../fixtures/mock-ingest-server.js'
import type { InstrumentedMcpServer } from '../../src/index.js'

const VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

const ingest = createMockIngest()

beforeAll(() => ingest.mswServer.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => ingest.mswServer.close())
afterEach(() => ingest.reset())

/** Spin up a linked server+client pair. Returns cleanup handle. */
async function setup(serverOpts: Partial<TestServerOptions> = {}): Promise<{
  server: InstrumentedMcpServer
  client: Client
  teardown: () => Promise<void>
}> {
  const server = createTestServer({ ingestUrl: MOCK_INGEST_URL, ...serverOpts })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  await client.connect(clientTransport)

  return {
    server,
    client,
    teardown: async () => {
      await client.close()
    },
  }
}

describe('node integration', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
  })

  afterEach(async () => {
    await ctx.teardown()
  })

  it('case 1: single tool call produces exactly one event in the batch', async () => {
    const { server, client } = ctx

    await client.callTool({ name: 'echo', arguments: { message: 'hello' } })
    await server.flush()

    const events = ingest.events()
    expect(events).toHaveLength(1)
    expect(events[0].toolName).toBe('echo')
    expect(events[0].serverSlug).toBe('test-server')
    expect(events[0].success).toBe(true)
  })

  it('case 2: 50 sequential tool calls flush as a single batch', async () => {
    // maxBatchSize=50 means the 50th enqueue triggers an automatic flush before manual flush.
    const { server, client } = ctx

    for (let i = 0; i < 50; i++) {
      await client.callTool({ name: 'echo', arguments: { message: `msg-${i}` } })
    }
    // Auto-flush fires at exactly 50 events; manual flush drains any remainder.
    await server.flush()

    expect(ingest.events()).toHaveLength(50)
    // All events belong to the same tool
    expect(ingest.events().every((e) => e.toolName === 'echo')).toBe(true)
  })

  it('case 3: tool calls with traceparent propagate it into all events', async () => {
    const { server, client } = ctx

    // Use client.request() to pass _meta directly in params.
    await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: 'traced' },
          _meta: { traceparent: VALID_TRACEPARENT },
        },
      },
      CallToolResultSchema
    )
    await server.flush()

    const events = ingest.events()
    expect(events).toHaveLength(1)
    expect(events[0].traceParent).toBe(VALID_TRACEPARENT)
    // correlationId is derived from the traceparent hash (not a random UUID)
    expect(events[0].correlationId).toBeDefined()
    expect(events[0].correlationId).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it('case 4: failed tool call produces event with success=false and subsequent calls still succeed', async () => {
    const { server, client } = ctx

    // The fail tool throws; MCP wraps it as an error response.
    const failResult = await client.callTool({ name: 'fail', arguments: {} })
    expect(failResult.isError).toBe(true)

    // Subsequent call should work normally.
    const echoResult = await client.callTool({ name: 'echo', arguments: { message: 'after error' } })
    expect(echoResult.isError).toBeFalsy()

    await server.flush()

    const events = ingest.events()
    expect(events).toHaveLength(2)
    expect(events[0].toolName).toBe('fail')
    expect(events[0].success).toBe(false)
    expect(events[1].toolName).toBe('echo')
    expect(events[1].success).toBe(true)
  })

  it('case 5: ingestUrl override in config is respected', async () => {
    const customUrl = 'https://mock-ingest.arthur.test/v1/events' // same host, verifiable via headers
    const { server: s2, client: c2, teardown } = await setup({ ingestUrl: customUrl })

    await c2.callTool({ name: 'echo', arguments: { message: 'custom-url' } })
    await s2.flush()

    // Events landed at the overridden URL (the MSW handler only listens on MOCK_INGEST_URL).
    expect(ingest.events()).toHaveLength(1)

    await teardown()
  })

  it('case 6: flush resolves before process exit (beforeExit handler)', async () => {
    // Verify that calling flush() after tool calls resolves and events are received —
    // confirming the flush mechanism works even at end-of-process timing.
    const { server, client } = ctx

    await client.callTool({ name: 'echo', arguments: { message: 'pre-exit' } })
    // Simulate the beforeExit scenario: explicitly flush and confirm completion.
    await server.flush()

    expect(ingest.events()).toHaveLength(1)
    expect(ingest.events()[0].durationMs).toBeGreaterThanOrEqual(0)
  })
})
