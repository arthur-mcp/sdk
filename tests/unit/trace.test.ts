// Unit tests for W3C Trace Context handling (spec Part 6 — trace.test.ts, 10 cases).
import { describe, expect, it } from 'vitest'
import { createChildSpan, extractTraceContext } from '../../src/trace.js'

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'

describe('extractTraceContext', () => {
  it('1. extracts a valid traceparent from params._meta', () => {
    const ctx = extractTraceContext({ traceparent: VALID })
    expect(ctx).not.toBeNull()
    expect(ctx!.traceId).toBe(TRACE_ID)
    expect(ctx!.spanId).toBe('00f067aa0ba902b7')
    expect(ctx!.flags).toBe('01')
    expect(ctx!.traceParent).toBe(VALID)
  })

  it('2. returns null when traceparent is missing', () => {
    expect(extractTraceContext({})).toBeNull()
    expect(extractTraceContext(undefined)).toBeNull()
  })

  it('3. returns null for a malformed traceparent', () => {
    expect(extractTraceContext({ traceparent: 'not-a-traceparent' })).toBeNull()
    expect(extractTraceContext({ traceparent: '00-tooShort-00f067aa0ba902b7-01' })).toBeNull()
    expect(extractTraceContext({ traceparent: 42 })).toBeNull()
  })

  it('4. rejects an all-zero traceId', () => {
    expect(extractTraceContext({ traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' })).toBeNull()
  })

  it('5. rejects an all-zero spanId', () => {
    expect(extractTraceContext({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01' })).toBeNull()
  })

  it('10. forwards tracestate and baggage verbatim from the parent', () => {
    const ctx = extractTraceContext({
      traceparent: VALID,
      tracestate: 'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE',
      baggage: 'userId=alice,region=eu',
    })
    expect(ctx!.traceState).toBe('rojo=00f067aa0ba902b7,congo=t61rcWkgMzE')
    expect(ctx!.baggage).toBe('userId=alice,region=eu')

    const child = createChildSpan(ctx)
    expect(child.traceState).toBe(ctx!.traceState)
    expect(child.baggage).toBe(ctx!.baggage)
  })
})

describe('createChildSpan', () => {
  const parent = extractTraceContext({ traceparent: VALID })!

  it('6. child span has the same traceId as the parent', () => {
    expect(createChildSpan(parent).traceId).toBe(parent.traceId)
  })

  it('7. child span has a different spanId than the parent', () => {
    const child = createChildSpan(parent)
    expect(child.spanId).not.toBe(parent.spanId)
    expect(child.spanId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('8. child span inherits the sampled flag from the parent', () => {
    expect(createChildSpan(parent).flags).toBe(parent.flags)
    const unsampled = extractTraceContext({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00' })!
    expect(createChildSpan(unsampled).flags).toBe('00')
  })

  it('9. generates a new root span when parent is null', () => {
    const root = createChildSpan(null)
    expect(root.parentSpanId).toBeNull()
    expect(root.traceParent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
    expect(root.traceId).not.toBe('0'.repeat(32))
  })
})
