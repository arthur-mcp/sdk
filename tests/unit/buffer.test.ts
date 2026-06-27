// Unit tests for the telemetry batch buffer (spec Part 6 — buffer.test.ts, 12 cases).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelemetryBuffer, type BufferOptions } from '../../src/buffer.js'
import type { IngestStatus, SendResult, ToolCallEvent } from '../../src/types.js'

function makeEvent(name = 'tool'): ToolCallEvent {
  return {
    schemaVersion: '1.0',
    publisherKey: 'pk',
    serverSlug: 'srv',
    toolName: name,
    correlationId: null,
    traceParent: null,
    startedAt: 0,
    durationMs: 1,
    success: true,
    errorCode: null,
    errorMessage: null,
    inputParamNames: null,
    inputSizeBytes: 0,
    outputContentTypes: null,
    outputSizeBytes: 0,
    sdkVersion: '0.1.0',
    serverVersion: '1.0.0',
    runtime: 'node',
    protocolVersion: null,
  }
}

function makeBuffer(overrides: Partial<BufferOptions> & { sender: BufferOptions['sender'] }): TelemetryBuffer {
  return new TelemetryBuffer({
    flushIntervalMs: 5000,
    maxBatchSize: 50,
    debug: false,
    installProcessHooks: false,
    runtime: 'node',
    ...overrides,
  })
}

function recordingSender(status: IngestStatus = 'ok') {
  const batches: ToolCallEvent[][] = []
  const fn = vi.fn(async (events: ToolCallEvent[]): Promise<SendResult> => {
    batches.push(events)
    return { status }
  })
  return { fn, batches }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('TelemetryBuffer', () => {
  it('1. enqueue() adds an event to the queue', () => {
    const { fn } = recordingSender()
    const buf = makeBuffer({ sender: fn, maxBatchSize: 100 })
    buf.enqueue(makeEvent())
    expect(buf.size()).toBe(1)
  })

  it('2. queue does not flush before reaching maxBatchSize', () => {
    const { fn } = recordingSender()
    const buf = makeBuffer({ sender: fn, maxBatchSize: 3 })
    buf.enqueue(makeEvent())
    buf.enqueue(makeEvent())
    expect(fn).not.toHaveBeenCalled()
    expect(buf.size()).toBe(2)
  })

  it('3. flush() is triggered when the queue reaches maxBatchSize', async () => {
    const { fn, batches } = recordingSender()
    const buf = makeBuffer({ sender: fn, maxBatchSize: 3 })
    buf.enqueue(makeEvent())
    buf.enqueue(makeEvent())
    buf.enqueue(makeEvent())
    await buf.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(batches[0]).toHaveLength(3)
  })

  it('4. flush() is triggered after flushIntervalMs elapses', async () => {
    vi.useFakeTimers()
    const { fn } = recordingSender()
    const buf = makeBuffer({ sender: fn, maxBatchSize: 100, flushIntervalMs: 5000 })
    buf.enqueue(makeEvent())
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('5. flush() empties the queue on success', async () => {
    const { fn } = recordingSender('ok')
    const buf = makeBuffer({ sender: fn, maxBatchSize: 100 })
    buf.enqueue(makeEvent())
    buf.enqueue(makeEvent())
    await buf.flush()
    expect(buf.size()).toBe(0)
  })

  it('6. flush() drops the batch on a network error without throwing', async () => {
    const fn = vi.fn(async (): Promise<SendResult> => ({ status: 'error' }))
    const buf = makeBuffer({ sender: fn, maxBatchSize: 100 })
    buf.enqueue(makeEvent())
    await expect(buf.flush()).resolves.toBeUndefined()
    expect(buf.size()).toBe(0)
  })

  it('7. drops oldest events when the queue exceeds 500 (overflow)', async () => {
    const { fn, batches } = recordingSender()
    const buf = makeBuffer({ sender: fn, maxBatchSize: 1_000_000 }) // never auto-flush
    for (let i = 0; i < 600; i++) buf.enqueue(makeEvent(String(i)))
    expect(buf.size()).toBe(500)
    await buf.flush()
    const sent = batches[0]!
    expect(sent).toHaveLength(500)
    expect(sent[0]!.toolName).toBe('100') // first 100 (0..99) dropped
    expect(sent[499]!.toolName).toBe('599')
  })

  it('8. concurrent flush() calls coalesce — only one in-flight at a time', async () => {
    let release!: (r: SendResult) => void
    const fn = vi.fn(() => new Promise<SendResult>((resolve) => (release = resolve)))
    const buf = makeBuffer({ sender: fn, maxBatchSize: 100 })
    buf.enqueue(makeEvent())
    const a = buf.flush()
    const b = buf.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    release({ status: 'ok' })
    await Promise.all([a, b])
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('9. manual flush() resolves after events are sent', async () => {
    const { fn } = recordingSender()
    const buf = makeBuffer({ sender: fn, maxBatchSize: 100 })
    buf.enqueue(makeEvent())
    await buf.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(buf.size()).toBe(0)
  })

  it('10. timer is cleared after a flush', async () => {
    const { fn } = recordingSender()
    const buf = makeBuffer({ sender: fn, maxBatchSize: 100 })
    buf.enqueue(makeEvent())
    expect(buf.hasTimer()).toBe(true)
    await buf.flush()
    expect(buf.hasTimer()).toBe(false)
  })

  it('11. a 401 stops future sends and logs to stderr once', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const fn = vi.fn(async (): Promise<SendResult> => ({ status: 'unauthorized' }))
    const buf = makeBuffer({ sender: fn, maxBatchSize: 100, debug: true })

    buf.enqueue(makeEvent())
    await buf.flush()
    expect(buf.isStopped()).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)

    // Further enqueues are dropped and no further sends happen.
    buf.enqueue(makeEvent())
    await buf.flush()
    expect(fn).toHaveBeenCalledTimes(1)

    const arthurLogs = stderr.mock.calls.filter((c) => String(c[0]).includes('Arthur'))
    expect(arthurLogs).toHaveLength(1)
  })

  it('12. debug=false suppresses all stderr output', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const fn = vi.fn(async (): Promise<SendResult> => ({ status: 'unauthorized' }))
    const buf = makeBuffer({ sender: fn, maxBatchSize: 100, debug: false })
    buf.enqueue(makeEvent())
    await buf.flush()
    const arthurLogs = stderr.mock.calls.filter((c) => String(c[0]).includes('Arthur'))
    expect(arthurLogs).toHaveLength(0)
  })
})
