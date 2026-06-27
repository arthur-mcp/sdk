// Unit tests for the transport interception layer (spec Part 6 — wrapper.test.ts, 16 cases + wiring).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TransportInstrumenter, instrumentServer, type EventSink, type WrapperContext } from '../../src/wrapper.js'
import { detectRuntime } from '../../src/runtime.js'
import { SDK_VERSION } from '../../src/version.js'
import type { ResolvedConfig, ToolCallEvent } from '../../src/types.js'

const VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    publisherKey: 'pk_test',
    serverSlug: 'srv',
    ingestUrl: 'https://ingest.example/v1/events',
    capture: { inputShape: true, outputTypes: true, errorMessages: true, sessionIds: true },
    flushIntervalMs: 5000,
    maxBatchSize: 50,
    debug: false,
    ...overrides,
  }
}

function makeHarness(configOverrides: Partial<ResolvedConfig> = {}, runtime = detectRuntime() as string) {
  const events: ToolCallEvent[] = []
  const buffer: EventSink = { enqueue: (e) => events.push(e) }
  const ctx: WrapperContext = {
    config: makeConfig(configOverrides),
    buffer,
    sdkVersion: SDK_VERSION,
    serverVersion: '1.2.3',
    runtime,
  }
  const instrumenter = new TransportInstrumenter(ctx)
  const sent: unknown[] = []
  const transport = {
    onmessage: undefined as undefined | ((m: unknown, e?: unknown) => void),
    send: vi.fn(async (m: unknown) => {
      sent.push(m)
    }),
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  instrumenter.attach(transport as unknown as Transport)
  return { events, transport, sent, ctx, instrumenter }
}

function request(id: number | string, name: string, args: unknown, meta?: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }
}
function successResponse(id: number | string, content: unknown[]) {
  return { jsonrpc: '2.0', id, result: { content } }
}
function errorResultResponse(id: number | string, content: unknown[]) {
  return { jsonrpc: '2.0', id, result: { content, isError: true } }
}
function jsonRpcError(id: number | string, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function call(h: ReturnType<typeof makeHarness>, req: unknown, res: unknown) {
  h.transport.onmessage!(req)
  await (h.transport.send as unknown as (m: unknown) => Promise<void>)(res)
}

afterEach(() => vi.restoreAllMocks())

describe('TransportInstrumenter', () => {
  it('1. success produces a ToolCallEvent with the correct toolName', async () => {
    const h = makeHarness()
    await call(h, request(1, 'echo', { query: 'x' }), successResponse(1, [{ type: 'text', text: 'x' }]))
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.toolName).toBe('echo')
  })

  it('2. success records durationMs > 0', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(1050)
    const h = makeHarness()
    await call(h, request(1, 'echo', {}), successResponse(1, []))
    expect(h.events[0]!.durationMs).toBe(50)
  })

  it('3. success sets success = true', async () => {
    const h = makeHarness()
    await call(h, request(1, 'echo', {}), successResponse(1, [{ type: 'text', text: 'ok' }]))
    expect(h.events[0]!.success).toBe(true)
  })

  it('4. a tool-level error result sets success = false', async () => {
    const h = makeHarness()
    await call(h, request(1, 'boom', {}), errorResultResponse(1, [{ type: 'text', text: 'nope' }]))
    expect(h.events[0]!.success).toBe(false)
  })

  it('5. a JSON-RPC error captures errorCode', async () => {
    const h = makeHarness()
    await call(h, request(1, 'boom', {}), jsonRpcError(1, -32602, 'Invalid params'))
    expect(h.events[0]!.success).toBe(false)
    expect(h.events[0]!.errorCode).toBe('InvalidParams')
  })

  it('6. re-throws the original error from send unchanged', () => {
    const events: ToolCallEvent[] = []
    const ctx: WrapperContext = {
      config: makeConfig(),
      buffer: { enqueue: (e) => events.push(e) },
      sdkVersion: SDK_VERSION,
      serverVersion: '1.0.0',
      runtime: 'node',
    }
    const boom = new Error('transport exploded')
    const transport = {
      onmessage: undefined,
      send: () => {
        throw boom
      },
    }
    new TransportInstrumenter(ctx).attach(transport as unknown as Transport)
    expect(() => (transport.send as unknown as (m: unknown) => Promise<void>)(successResponse(1, []))).toThrow(boom)
  })

  it('7. does not modify the tool call arguments', () => {
    const h = makeHarness()
    const args = { query: 'hello', count: 3 }
    const snapshot = structuredClone(args)
    const req = request(1, 'echo', args)
    h.transport.onmessage!(req)
    expect(args).toEqual(snapshot)
    expect(req.params.arguments).toBe(args)
  })

  it('8. does not modify the tool call response', async () => {
    const h = makeHarness()
    h.transport.onmessage!(request(1, 'echo', {}))
    const res = successResponse(1, [{ type: 'text', text: 'unchanged' }])
    const snapshot = structuredClone(res)
    await (h.transport.send as unknown as (m: unknown) => Promise<void>)(res)
    expect(res).toEqual(snapshot)
    expect(h.sent[0]).toBe(res)
  })

  it('9. traceparent present in _meta is forwarded to the event verbatim', async () => {
    const h = makeHarness()
    await call(h, request(1, 'echo', {}, { traceparent: VALID_TRACEPARENT }), successResponse(1, []))
    expect(h.events[0]!.traceParent).toBe(VALID_TRACEPARENT)
  })

  it('10. traceparent absent — a correlationId is generated', async () => {
    const h = makeHarness()
    await call(h, request(1, 'echo', {}), successResponse(1, []))
    expect(h.events[0]!.traceParent).toBeNull()
    expect(h.events[0]!.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('11. the event is enqueued to the buffer (not sent inline)', async () => {
    const enqueue = vi.fn()
    const ctx: WrapperContext = {
      config: makeConfig(),
      buffer: { enqueue },
      sdkVersion: SDK_VERSION,
      serverVersion: '1.0.0',
      runtime: 'node',
    }
    const instrumenter = new TransportInstrumenter(ctx)
    const transport = { onmessage: undefined, send: vi.fn(async () => {}) }
    instrumenter.attach(transport as unknown as Transport)
    transport.onmessage!(request(1, 'echo', {}))
    // The response must be written before any event is enqueued.
    expect(enqueue).not.toHaveBeenCalled()
    await (transport.send as unknown as (m: unknown) => Promise<void>)(successResponse(1, []))
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('12. inputParamNames is null when capture.inputShape = false', async () => {
    const h = makeHarness({ capture: { inputShape: false, outputTypes: true, errorMessages: true, sessionIds: true } })
    await call(h, request(1, 'echo', { a: 1, b: 2 }), successResponse(1, []))
    expect(h.events[0]!.inputParamNames).toBeNull()
    // size is still captured (shape boundary only hides names, not byte size)
    expect(h.events[0]!.inputSizeBytes).toBeGreaterThan(0)
  })

  it('13. outputContentTypes is null when capture.outputTypes = false', async () => {
    const h = makeHarness({ capture: { inputShape: true, outputTypes: false, errorMessages: true, sessionIds: true } })
    await call(h, request(1, 'echo', {}), successResponse(1, [{ type: 'text', text: 'x' }]))
    expect(h.events[0]!.outputContentTypes).toBeNull()
  })

  it('14. sdkVersion matches the package.json version', async () => {
    const h = makeHarness()
    await call(h, request(1, 'echo', {}), successResponse(1, []))
    expect(h.events[0]!.sdkVersion).toBe(SDK_VERSION)
  })

  it('15. runtime is propagated as "cloudflare-workers" when detected there (Workers env: Phase 2)', async () => {
    // Real in-Workers detection is validated by the vitest-pool-workers suite (Phase 2). Here we
    // verify the wrapper faithfully reports whatever runtime it is given.
    const h = makeHarness({}, 'cloudflare-workers')
    await call(h, request(1, 'echo', {}), successResponse(1, []))
    expect(h.events[0]!.runtime).toBe('cloudflare-workers')
  })

  it('16. runtime is "node" in the Node.js environment', async () => {
    const h = makeHarness() // runtime = real detectRuntime()
    await call(h, request(1, 'echo', {}), successResponse(1, []))
    expect(h.events[0]!.runtime).toBe('node')
  })
})

describe('instrumentServer wiring', () => {
  it('attaches the instrumenter to the transport on connect, then calls the original connect', async () => {
    const events: ToolCallEvent[] = []
    const ctx: WrapperContext = {
      config: makeConfig(),
      buffer: { enqueue: (e) => events.push(e) },
      sdkVersion: SDK_VERSION,
      serverVersion: '1.0.0',
      runtime: 'node',
    }
    const instrumenter = new TransportInstrumenter(ctx)
    const attachSpy = vi.spyOn(instrumenter, 'attach')
    const originalConnect = vi.fn(async () => {})
    const registerCapabilities = vi.fn()
    const fakeServer = { server: { registerCapabilities }, connect: originalConnect } as unknown as McpServer

    instrumentServer(fakeServer, ctx, instrumenter)
    expect(registerCapabilities).toHaveBeenCalledTimes(1)

    const transport = { onmessage: undefined, send: vi.fn(async () => {}), start: vi.fn(async () => {}) }
    await fakeServer.connect(transport as unknown as Transport)
    expect(attachSpy).toHaveBeenCalledTimes(1)
    expect(originalConnect).toHaveBeenCalledTimes(1)
  })

  it('registers the com.arthurmcp.analytics capability extension', () => {
    const ctx: WrapperContext = {
      config: makeConfig(),
      buffer: { enqueue: () => {} },
      sdkVersion: SDK_VERSION,
      serverVersion: '1.0.0',
      runtime: 'node',
    }
    const registerCapabilities = vi.fn()
    const fakeServer = { server: { registerCapabilities }, connect: vi.fn(async () => {}) } as unknown as McpServer
    instrumentServer(fakeServer, ctx, new TransportInstrumenter(ctx))
    expect(registerCapabilities).toHaveBeenCalledWith({
      experimental: { 'com.arthurmcp.analytics': { version: SDK_VERSION } },
    })
  })
})
