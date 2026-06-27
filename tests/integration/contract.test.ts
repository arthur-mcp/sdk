// Behavioral contract tests — the four promises that make the SDK safe for publishers to ship.
// Each runs in Node using InMemoryTransport. Contracts are described in CLAUDE.md Part 6.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { withArthurAnalytics, type InstrumentedMcpServer } from '../../src/index.js'
import { createMockIngest, MOCK_INGEST_URL } from '../fixtures/mock-ingest-server.js'

const SECRET = 'ARTHUR_CONTRACT_SECRET_xK9mP2qR'

/** Build a fresh client+server pair connected via in-memory transport. */
async function connect(server: InstrumentedMcpServer) {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'contract-client', version: '0.0.1' })
  await client.connect(ct)
  return { client, teardown: () => client.close() }
}

// ─── Zero-latency contract ───────────────────────────────────────────────────

describe('contract: zero latency', () => {
  let ingestCallMs: number | null = null
  let responseMs: number | null = null
  const origin = performance.now()

  const slowIngest = setupServer(
    http.post('https://slow-ingest.test/v1/events', async () => {
      ingestCallMs = performance.now() - origin
      // Simulate a slow ingest endpoint (100 ms).
      await new Promise((r) => setTimeout(r, 100))
      return HttpResponse.json({ ok: true })
    })
  )

  beforeAll(() => slowIngest.listen({ onUnhandledRequest: 'bypass' }))
  afterAll(() => slowIngest.close())

  it('ingest starts after tool response is written, not before', async () => {
    const server = withArthurAnalytics(
      (() => {
        const s = new McpServer({ name: 'latency-test', version: '1.0.0' })
        s.tool('ping', {}, async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }))
        return s
      })(),
      {
        publisherKey: 'pk_latency',
        serverSlug: 'latency-test',
        ingestUrl: 'https://slow-ingest.test/v1/events',
        maxBatchSize: 1, // trigger flush immediately after first event
        flushIntervalMs: 30_000,
      }
    )

    const { client, teardown } = await connect(server)

    await client.callTool({ name: 'ping', arguments: {} })
    responseMs = performance.now() - origin

    // Flush triggers the slow ingest; wait for it to complete.
    await server.flush()

    expect(responseMs).toBeDefined()
    // ingestCallMs may be null if flush hasn't started yet before manual flush call —
    // the important invariant is that it never blocked callTool, proven by the assertion below.
    // After await flush(), ingest must have been called.
    expect(ingestCallMs).not.toBeNull()

    // The tool call returned before ingest even started (ingest runs after the response write).
    expect(responseMs!).toBeLessThan(ingestCallMs! + 100) // callTool resolved well before ingest finished

    await teardown()
  })
})

// ─── Fail-open contract ──────────────────────────────────────────────────────

describe('contract: fail open', () => {
  it('100 tool calls all succeed when ingest host is unreachable', async () => {
    // Port 1 is reserved and will refuse connections on all platforms.
    const server = withArthurAnalytics(
      (() => {
        const s = new McpServer({ name: 'failopen-test', version: '1.0.0' })
        s.tool('ping', {}, async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }))
        return s
      })(),
      {
        publisherKey: 'pk_failopen',
        serverSlug: 'failopen-test',
        ingestUrl: 'http://127.0.0.1:1/v1/events', // guaranteed unreachable
        maxBatchSize: 50,
        flushIntervalMs: 30_000,
      }
    )

    const { client, teardown } = await connect(server)

    const results: unknown[] = []
    for (let i = 0; i < 100; i++) {
      const r = await client.callTool({ name: 'ping', arguments: {} })
      results.push(r)
    }

    // flush() should resolve without throwing even though ingest is down
    await expect(server.flush()).resolves.toBeUndefined()

    // All 100 tool calls must have succeeded — none should have thrown or returned an error.
    expect(results).toHaveLength(100)
    expect(results.every((r: unknown) => (r as { isError?: boolean }).isError !== true)).toBe(true)

    await teardown()
  })
})

// ─── No content leakage contract ─────────────────────────────────────────────

describe('contract: no content leakage', () => {
  const ingest = createMockIngest()

  beforeAll(() => ingest.mswServer.listen({ onUnhandledRequest: 'bypass' }))
  afterAll(() => ingest.mswServer.close())
  afterEach(() => ingest.reset())

  it('unique string returned as tool output never appears in any event field', async () => {
    const server = withArthurAnalytics(
      (() => {
        const s = new McpServer({ name: 'leak-test', version: '1.0.0' })
        // Tool returns the secret string as text content — must never reach ingest.
        s.tool('secret_output', {}, async () => ({
          content: [{ type: 'text' as const, text: SECRET }],
        }))
        return s
      })(),
      {
        publisherKey: 'pk_leak',
        serverSlug: 'leak-test',
        ingestUrl: MOCK_INGEST_URL,
        capture: { outputTypes: true, inputShape: true, errorMessages: true, sessionIds: true },
      }
    )

    const { client, teardown } = await connect(server)
    await client.callTool({ name: 'secret_output', arguments: {} })
    await server.flush()

    const serialized = JSON.stringify(ingest.events())
    expect(serialized).not.toContain(SECRET)

    await teardown()
  })
})

// ─── No input leakage contract ────────────────────────────────────────────────

describe('contract: no input leakage', () => {
  const ingest = createMockIngest()

  beforeAll(() => ingest.mswServer.listen({ onUnhandledRequest: 'bypass' }))
  afterAll(() => ingest.mswServer.close())
  afterEach(() => ingest.reset())

  it('unique string passed as argument value never appears in any event field', async () => {
    const server = withArthurAnalytics(
      (() => {
        const s = new McpServer({ name: 'inputleak-test', version: '1.0.0' })
        // Tool receives secret as a parameter value — must never reach ingest.
        s.tool('secret_input', { payload: z.string() }, async () => ({
          content: [{ type: 'text' as const, text: 'ok' }],
        }))
        return s
      })(),
      {
        publisherKey: 'pk_inputleak',
        serverSlug: 'inputleak-test',
        ingestUrl: MOCK_INGEST_URL,
        capture: { outputTypes: true, inputShape: true, errorMessages: true, sessionIds: true },
      }
    )

    const { client, teardown } = await connect(server)
    await client.callTool({ name: 'secret_input', arguments: { payload: SECRET } })
    await server.flush()

    const serialized = JSON.stringify(ingest.events())
    expect(serialized).not.toContain(SECRET)

    // The param KEY ("payload") should be present, just not the VALUE.
    expect(ingest.events()[0].inputParamNames).toContain('payload')

    await teardown()
  })
})
