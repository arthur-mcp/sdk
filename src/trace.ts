// Pure W3C Trace Context (SEP-414) extraction and child-span generation. No I/O, no deps. Never throws.
import type { ChildSpan, TraceContext } from './types.js'

/** Strict traceparent format: version 00, 32-hex trace-id, 16-hex span-id, 2-hex flags. */
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
const ZERO_TRACE_ID = '0'.repeat(32)
const ZERO_SPAN_ID = '0'.repeat(16)

/** Generate `bytes` random bytes as a lowercase hex string using the global Web Crypto API. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Parse W3C Trace Context from a request's `params._meta`. Reads `traceparent`, `tracestate`, and
 * `baggage` under their locked key names. Rejects malformed or all-zero traceparents. Never throws.
 *
 * @param meta - The `params._meta` object, if present.
 * @returns The parsed {@link TraceContext}, or `null` when traceparent is absent or invalid.
 */
export function extractTraceContext(meta: Record<string, unknown> | undefined): TraceContext | null {
  if (!meta) return null
  const traceParent = meta['traceparent']
  if (typeof traceParent !== 'string' || !TRACEPARENT_RE.test(traceParent)) return null

  const parts = traceParent.split('-')
  const traceId = parts[1] as string
  const spanId = parts[2] as string
  const flags = parts[3] as string
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null

  const traceState = typeof meta['tracestate'] === 'string' ? (meta['tracestate'] as string) : null
  const baggage = typeof meta['baggage'] === 'string' ? (meta['baggage'] as string) : null
  return { traceId, spanId, flags, traceParent, traceState, baggage }
}

/**
 * Create a child span for the tool-call. With a parent: same trace-id and flags, a fresh span-id,
 * and verbatim tracestate/baggage. Without a parent: a brand-new sampled root span.
 *
 * @param parent - The extracted parent trace context, or `null` to start a new root.
 * @returns A {@link ChildSpan} carrying the new traceparent to record on the event.
 */
export function createChildSpan(parent: TraceContext | null): ChildSpan {
  if (parent) {
    const spanId = randomHex(8)
    return {
      traceId: parent.traceId,
      spanId,
      parentSpanId: parent.spanId,
      flags: parent.flags,
      traceParent: `00-${parent.traceId}-${spanId}-${parent.flags}`,
      traceState: parent.traceState,
      baggage: parent.baggage,
    }
  }

  const traceId = randomHex(16)
  const spanId = randomHex(8)
  const flags = '01'
  return {
    traceId,
    spanId,
    parentSpanId: null,
    flags,
    traceParent: `00-${traceId}-${spanId}-${flags}`,
    traceState: null,
    baggage: null,
  }
}
