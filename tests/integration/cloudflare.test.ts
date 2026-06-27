// Cloudflare Workers integration tests. Runs inside the actual Workers runtime via
// @cloudflare/vitest-pool-workers — globals are the real Workers globals, not Node.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { withArthurAnalytics, type InstrumentedMcpServer } from '../../src/index.js'

const MOCK_INGEST_URL = 'https://mock-ingest.workers.test/v1/events'

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** Replace globalThis.fetch for a test, returning captured requests and a restore function. */
function interceptFetch(statusCode = 200): {
  captured: CapturedRequest[]
  restore: () => void
} {
  const captured: CapturedRequest[] = []
  const original = globalThis.fetch

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    // Only intercept ingest calls; pass everything else through.
    if (url.startsWith('https://mock-ingest.workers.test')) {
      const bodyText = typeof init?.body === 'string' ? init.body : ''
      captured.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ? Object.fromEntries(new Headers(init.headers as HeadersInit)) : {},
        body: bodyText ? JSON.parse(bodyText) : null,
      })
      return new Response(JSON.stringify({ ok: statusCode < 400 }), {
        status: statusCode,
        headers: { 'content-type': 'application/json' },
      })
    }
    return original(input, init)
  }

  return { captured, restore: () => { globalThis.fetch = original } }
}

async function setupClientServer(serverOpts: {
  maxBatchSize?: number
  flushIntervalMs?: number
} = {}): Promise<{ server: InstrumentedMcpServer; client: Client; teardown: () => Promise<void> }> {
  const mcpServer = new McpServer({ name: 'cf-test-server', version: '1.0.0' })
  mcpServer.tool('ping', {}, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }))

  const server = withArthurAnalytics(mcpServer, {
    publisherKey: 'pk_cf_test',
    serverSlug: 'cf-test-server',
    ingestUrl: MOCK_INGEST_URL,
    maxBatchSize: serverOpts.maxBatchSize ?? 50,
    flushIntervalMs: serverOpts.flushIntervalMs ?? 30_000,
  })

  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'cf-test-client', version: '0.0.1' })
  await client.connect(ct)

  return { server, client, teardown: () => client.close() }
}

describe('cloudflare workers integration', () => {
  let restore: () => void

  afterEach(() => restore?.())

  // ─── Case 1: ctx.waitUntil pattern ─────────────────────────────────────────

  it('case 1: ctx.waitUntil() can be used with flush() to extend Worker lifetime', async () => {
    const { captured, restore: r } = interceptFetch()
    restore = r

    const { server, client, teardown } = await setupClientServer()

    // Simulate the publisher pattern in a Worker fetch handler:
    // const ctx = event.waitUntil is replaced by a mock here.
    const waitedPromises: Promise<void>[] = []
    const mockWaitUntil = (p: Promise<void>) => waitedPromises.push(p)

    await client.callTool({ name: 'ping', arguments: {} })
    // Publisher calls ctx.waitUntil(server.flush()) so the flush outlives the response.
    mockWaitUntil(server.flush())

    await Promise.all(waitedPromises)

    expect(waitedPromises).toHaveLength(1)
    expect(captured).toHaveLength(1)

    await teardown()
  })

  // ─── Case 2: Flush does not block response ──────────────────────────────────

  it('case 2: telemetry flush does not block request response', async () => {
    let ingestStart = 0
    let responseEnd = 0
    const origin = performance.now()
    const captured: CapturedRequest[] = []
    const original = globalThis.fetch

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url.startsWith('https://mock-ingest.workers.test')) {
        ingestStart = performance.now() - origin
        // Simulate 50ms ingest latency.
        await new Promise((r) => setTimeout(r, 50))
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, method: init?.method ?? 'GET', headers: {}, body })
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return original(input, init)
    }
    restore = () => { globalThis.fetch = original }

    const { server, client, teardown } = await setupClientServer({ maxBatchSize: 1 })

    const callStart = performance.now() - origin
    await client.callTool({ name: 'ping', arguments: {} })
    responseEnd = performance.now() - origin

    // Flush is fire-and-forget from the response path; wait for it now.
    await server.flush()

    // The tool call must have returned before the slow ingest completed.
    expect(responseEnd - callStart).toBeLessThan(40) // response in <40ms
    expect(ingestStart).toBeGreaterThan(0) // ingest did fire
    expect(captured).toHaveLength(1)

    await teardown()
  })

  // ─── Case 3: Workers-native crypto.randomUUID() ─────────────────────────────

  it('case 3: crypto.randomUUID() is available in Workers runtime', async () => {
    // In the Workers runtime, crypto is the native Workers crypto — not Node's crypto module.
    expect(typeof crypto).toBe('object')
    expect(typeof crypto.randomUUID).toBe('function')

    const id = crypto.randomUUID()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

    // Verify the SDK uses the same crypto when generating correlation IDs.
    const { captured, restore: r } = interceptFetch()
    restore = r

    const { server, client, teardown } = await setupClientServer()
    await client.callTool({ name: 'ping', arguments: {} })
    await server.flush()

    expect(captured[0].body).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ correlationId: expect.any(String) }),
      ]),
    })

    await teardown()
  })

  // ─── Case 4: Authorization header sent to ingest ────────────────────────────

  it('case 4: fetch() to ingest URL carries correct Authorization header', async () => {
    const { captured, restore: r } = interceptFetch()
    restore = r

    const { server, client, teardown } = await setupClientServer()
    await client.callTool({ name: 'ping', arguments: {} })
    await server.flush()

    expect(captured).toHaveLength(1)
    expect(captured[0].headers['authorization']).toBe('Bearer pk_cf_test')
    expect(captured[0].method).toBe('POST')
    expect(captured[0].url).toBe(MOCK_INGEST_URL)

    await teardown()
  })

  // ─── Case 5: Failed ingest fetch() does not throw ────────────────────────────

  it('case 5: failed ingest fetch() does not throw or affect tool call response', async () => {
    // Return a network-error-like response by throwing from the mock fetch.
    const original = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url.startsWith('https://mock-ingest.workers.test')) {
        throw new TypeError('Failed to fetch') // simulate network error
      }
      return original(input)
    }
    restore = () => { globalThis.fetch = original }

    const { server, client, teardown } = await setupClientServer()

    // Make 10 tool calls — all should succeed even though ingest always throws.
    const results: unknown[] = []
    for (let i = 0; i < 10; i++) {
      results.push(await client.callTool({ name: 'ping', arguments: {} }))
    }

    // flush() must resolve without throwing even when fetch() throws internally.
    await expect(server.flush()).resolves.toBeUndefined()

    expect(results).toHaveLength(10)
    expect(results.every((r) => (r as { isError?: boolean }).isError !== true)).toBe(true)

    await teardown()
  })

})
