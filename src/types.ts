// All public and internal types for the Arthur MCP Analytics SDK. Declarative only — no runtime logic.
import { z } from 'zod'

/** Current ToolCallEvent schema version. Bump only on breaking changes. */
export const SCHEMA_VERSION = '1.0'

/** Detected JavaScript runtime the SDK is executing in. */
export type Runtime = 'cloudflare-workers' | 'node' | 'bun' | 'deno' | 'unknown'

/** Outcome of an ingest attempt. `error` covers network failures and non-401 non-2xx responses. */
export type IngestStatus = 'ok' | 'unauthorized' | 'error'

/** Result of attempting to send a batch of events to ingest. */
export interface SendResult {
  status: IngestStatus
}

/** Pluggable batch sender — the buffer depends on this, decoupled from the concrete HTTP client. */
export type EventSender = (events: ToolCallEvent[]) => Promise<SendResult>

/** What the SDK is permitted to capture. Never includes input values or output content. */
export interface CaptureConfig {
  /** Capture top-level parameter *names* (never values). */
  inputShape: boolean
  /** Capture content block *types* (never content). */
  outputTypes: boolean
  /** Include truncated, scrubbed error message strings. */
  errorMessages: boolean
  /** Enable request-scoped correlation IDs. */
  sessionIds: boolean
}

/** Public configuration accepted by `withArthurAnalytics`. */
export interface ArthurSdkConfig {
  /** Publisher API key from arthurmcp.com. Required. */
  publisherKey: string
  /** Unique server identifier in the registry. Required. */
  serverSlug: string
  /** Override ingest endpoint. */
  ingestUrl?: string
  /** Partial capture toggles; unset fields fall back to defaults. */
  capture?: Partial<CaptureConfig>
  /** Max ms between flushes. */
  flushIntervalMs?: number
  /** Max events per batch before a forced flush. */
  maxBatchSize?: number
  /** Log SDK activity to stderr. */
  debug?: boolean
}

/** Fully-resolved configuration with all defaults applied (internal). */
export interface ResolvedConfig {
  publisherKey: string
  serverSlug: string
  ingestUrl: string
  capture: CaptureConfig
  flushIntervalMs: number
  maxBatchSize: number
  debug: boolean
}

/**
 * One telemetry record per `tools/call`. Every field is always present or
 * explicitly `null`. PII boundary: param *names* and content *types* only.
 */
export interface ToolCallEvent {
  schemaVersion: string
  publisherKey: string
  serverSlug: string
  toolName: string
  correlationId: string | null
  traceParent: string | null
  startedAt: number
  durationMs: number
  success: boolean
  errorCode: string | null
  errorMessage: string | null
  inputParamNames: string[] | null
  inputSizeBytes: number
  outputContentTypes: string[] | null
  outputSizeBytes: number
  sdkVersion: string
  serverVersion: string
  runtime: string
  protocolVersion: string | null
}

/** Parsed W3C Trace Context (SEP-414) extracted from `params._meta`. */
export interface TraceContext {
  /** 32 hex chars, never all-zero. */
  traceId: string
  /** 16 hex chars, never all-zero. */
  spanId: string
  /** 2 hex chars — the trace-flags byte (low bit = sampled). */
  flags: string
  /** Raw traceparent string, forwarded verbatim. */
  traceParent: string
  /** Raw tracestate, forwarded verbatim if present. */
  traceState: string | null
  /** Raw baggage, forwarded verbatim if present. */
  baggage: string | null
}

/** A freshly-minted child span for the tool-call, derived from a parent (or a new root). */
export interface ChildSpan {
  traceId: string
  /** Newly-generated span id for this tool call. */
  spanId: string
  /** Parent span id, or null when this is a new root. */
  parentSpanId: string | null
  flags: string
  /** New traceparent string: `00-<traceId>-<spanId>-<flags>`. */
  traceParent: string
  traceState: string | null
  baggage: string | null
}

/**
 * Runtime validation schema for a {@link ToolCallEvent}. Used by the wrapper to
 * drop malformed events before they reach the buffer. Mirrors the type exactly.
 */
export const toolCallEventSchema = z.object({
  schemaVersion: z.string(),
  publisherKey: z.string(),
  serverSlug: z.string(),
  toolName: z.string(),
  correlationId: z.string().nullable(),
  traceParent: z.string().nullable(),
  startedAt: z.number(),
  durationMs: z.number(),
  success: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  inputParamNames: z.array(z.string()).nullable(),
  inputSizeBytes: z.number(),
  outputContentTypes: z.array(z.string()).nullable(),
  outputSizeBytes: z.number(),
  sdkVersion: z.string(),
  serverVersion: z.string(),
  runtime: z.string(),
  protocolVersion: z.string().nullable(),
})
