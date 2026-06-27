// The interception layer. Purely observational: it hooks both sides of the transport — onmessage for
// the incoming tools/call request and send for the outgoing response — correlates them by JSON-RPC id,
// and builds a ToolCallEvent. It never modifies messages, never adds latency, and never throws.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import { writeStderr } from './runtime.js'
import { extractInputShape, extractOutputTypes, sanitizeErrorMessage } from './pii.js'
import { extractTraceContext } from './trace.js'
import { SCHEMA_VERSION, toolCallEventSchema, type ResolvedConfig, type TraceContext, type ToolCallEvent } from './types.js'

/** Minimal event-sink contract — satisfied by TelemetryBuffer; lets tests inject a stub. */
export interface EventSink {
  enqueue(event: ToolCallEvent): void
}

/** Everything the instrumenter needs to build and route events. */
export interface WrapperContext {
  config: ResolvedConfig
  buffer: EventSink
  sdkVersion: string
  serverVersion: string
  runtime: string
}

/** Per-request state captured before dispatch, keyed by JSON-RPC id until the response is written. */
interface PendingCall {
  startedAt: number
  toolName: string
  traceCtx: TraceContext | null
  inputParamNames: string[] | null
  inputSizeBytes: number
  protocolVersion: string | null
}

/** Standard JSON-RPC / MCP error codes mapped to their string names. */
const ERROR_CODE_NAMES: Record<number, string> = {
  [-32700]: 'ParseError',
  [-32600]: 'InvalidRequest',
  [-32601]: 'MethodNotFound',
  [-32602]: 'InvalidParams',
  [-32603]: 'InternalError',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build a stable map key from a JSON-RPC id, preserving the string/number distinction. */
function idKey(id: unknown): string | null {
  if (typeof id === 'string') return `s:${id}`
  if (typeof id === 'number') return `n:${id}`
  return null
}

/** Light structural check for an incoming `tools/call` request — avoids a full schema parse on the hot path. */
function isToolCallRequest(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && message['method'] === 'tools/call' && 'id' in message
}

/** Light structural check for an outgoing JSON-RPC response or error. */
function isResponseLike(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && 'id' in message && ('result' in message || 'error' in message)
}

/** 32-bit FNV-1a hash as 8-char hex. Synchronous and portable — used to derive a correlation id. */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Map a numeric JSON-RPC error code to its MCP string name, falling back to the numeric string. */
function mapErrorCode(code: unknown): string | null {
  if (typeof code !== 'number') return null
  return ERROR_CODE_NAMES[code] ?? String(code)
}

/** JSON byte-size of a value; 0 when undefined, -1 when it cannot be serialized (circular ref). */
function safeSize(value: unknown): number {
  if (value === undefined) return 0
  try {
    return JSON.stringify(value).length
  } catch {
    return -1
  }
}

/**
 * Observes a transport's request/response pair to emit a {@link ToolCallEvent} per tools/call.
 * Hooks are installed by {@link TransportInstrumenter.attach}; the class itself holds no I/O.
 */
export class TransportInstrumenter {
  private readonly pending = new Map<string, PendingCall>()

  constructor(private readonly ctx: WrapperContext) {}

  /**
   * Wrap a transport in place. Chains `onmessage` (request capture, runs before dispatch) and wraps
   * `send` (response written first, then observed). Both observers swallow their own errors so the
   * server's behavior is never altered.
   *
   * @param transport - The transport the McpServer is about to take ownership of.
   */
  attach(transport: Transport): void {
    const priorOnmessage = transport.onmessage?.bind(transport)
    transport.onmessage = (message, extra) => {
      try {
        this.observeIncoming(message)
      } catch {
        // Telemetry must never break message handling.
      }
      priorOnmessage?.(message, extra)
    }

    const originalSend = transport.send.bind(transport)
    transport.send = (message, options?: TransportSendOptions): Promise<void> => {
      // Response is written first — telemetry happens strictly after, adding zero latency.
      const result = originalSend(message, options)
      try {
        this.observeOutgoing(message)
      } catch {
        // Telemetry must never break the response path.
      }
      return result
    }
  }

  /** Capture pre-dispatch state for a tools/call request, keyed by its id. */
  private observeIncoming(message: unknown): void {
    if (Array.isArray(message)) {
      for (const m of message) this.observeIncoming(m)
      return
    }
    if (!isToolCallRequest(message)) return
    const key = idKey(message['id'])
    if (key === null) return

    const params = isRecord(message['params']) ? message['params'] : {}
    const meta = isRecord(params['_meta']) ? params['_meta'] : undefined
    const args = params['arguments']

    let inputSizeBytes = safeSize(args)
    let inputParamNames: string[] | null = null
    if (inputSizeBytes === -1) {
      // Circular reference: cannot size or shape the input. (wrapper error rule 5)
      inputParamNames = null
    } else if (this.ctx.config.capture.inputShape) {
      inputParamNames = extractInputShape(args)
    }

    this.pending.set(key, {
      startedAt: Date.now(),
      toolName: typeof params['name'] === 'string' ? (params['name'] as string) : 'unknown',
      traceCtx: extractTraceContext(meta),
      inputParamNames,
      inputSizeBytes,
      protocolVersion: meta && typeof meta['protocolVersion'] === 'string' ? (meta['protocolVersion'] as string) : null,
    })
  }

  /** On the matching response, finalize and enqueue the event. */
  private observeOutgoing(message: unknown): void {
    if (Array.isArray(message)) {
      for (const m of message) this.observeOutgoing(m)
      return
    }
    if (!isResponseLike(message)) return
    const key = idKey(message['id'])
    if (key === null) return
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)

    const event = this.buildEvent(pending, message)
    if (!event) return

    // Drop events that fail schema validation rather than shipping malformed data. (wrapper error rule 2)
    if (!toolCallEventSchema.safeParse(event).success) {
      if (this.ctx.config.debug) writeStderr('Arthur MCP SDK: dropped an event that failed schema validation.')
      return
    }
    this.ctx.buffer.enqueue(event)
  }

  private buildEvent(pending: PendingCall, response: Record<string, unknown>): ToolCallEvent | null {
    const { capture } = this.ctx.config
    const durationMs = Math.max(0, Date.now() - pending.startedAt)

    let success: boolean
    let errorCode: string | null = null
    let errorMessage: string | null = null
    let outputContentTypes: string[] | null = null
    let outputSizeBytes = 0

    if (isRecord(response['error'])) {
      // Protocol-level JSON-RPC error: its message is protocol metadata (not user content), so it
      // may be sanitized and captured when enabled.
      const err = response['error']
      success = false
      errorCode = mapErrorCode(err['code'])
      errorMessage = sanitizeErrorMessage(typeof err['message'] === 'string' ? (err['message'] as string) : undefined, capture)
    } else {
      const result = isRecord(response['result']) ? response['result'] : {}
      const content = result['content']
      // Tool-level failure is signalled by isError; the message lives in content (output) which we
      // must never read, so errorCode/errorMessage stay null here.
      success = result['isError'] !== true
      outputContentTypes = capture.outputTypes ? extractOutputTypes(content) : null
      outputSizeBytes = safeSize(content)
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      publisherKey: this.ctx.config.publisherKey,
      serverSlug: this.ctx.config.serverSlug,
      toolName: pending.toolName,
      correlationId: this.computeCorrelationId(pending.traceCtx),
      traceParent: pending.traceCtx?.traceParent ?? null,
      startedAt: pending.startedAt,
      durationMs,
      success,
      errorCode,
      errorMessage,
      inputParamNames: pending.inputParamNames,
      inputSizeBytes: pending.inputSizeBytes,
      outputContentTypes,
      outputSizeBytes,
      sdkVersion: this.ctx.sdkVersion,
      serverVersion: this.ctx.serverVersion,
      runtime: this.ctx.runtime,
      protocolVersion: pending.protocolVersion,
    }
  }

  /** Hash of the incoming traceparent when present, else a fresh UUID. Null when sessionIds disabled. */
  private computeCorrelationId(traceCtx: TraceContext | null): string | null {
    if (!this.ctx.config.capture.sessionIds) return null
    if (traceCtx) return fnv1aHex(traceCtx.traceParent)
    return crypto.randomUUID()
  }
}

/**
 * Instrument a high-level McpServer: register the analytics capability extension (best-effort) and
 * patch `connect` so the transport hooks are installed before the Protocol takes ownership.
 *
 * NOTE: per the v1.0 event schema, `traceParent` carries the *incoming* traceparent verbatim. The
 * child-span generator in trace.ts is exercised and exported for a future schema field but is not
 * wired into the event here, to avoid hot-path work with no destination.
 *
 * @param server - The McpServer to instrument.
 * @param ctx - The wrapper context (config, buffer, version/runtime metadata).
 * @param instrumenter - The instrumenter that attaches to the transport on connect.
 */
export function instrumentServer(server: McpServer, ctx: WrapperContext, instrumenter: TransportInstrumenter): void {
  registerCapabilityExtension(server, ctx)

  const originalConnect = server.connect.bind(server)
  const patched = async (transport: Transport): Promise<void> => {
    try {
      instrumenter.attach(transport)
    } catch {
      // Never let instrumentation block the server from connecting.
    }
    return originalConnect(transport)
  }
  ;(server as unknown as { connect: (t: Transport) => Promise<void> }).connect = patched
}

/** Register the SDK as capability extension `com.arthurmcp.analytics`. Best-effort; never fatal. */
function registerCapabilityExtension(server: McpServer, ctx: WrapperContext): void {
  try {
    server.server.registerCapabilities({
      experimental: { 'com.arthurmcp.analytics': { version: ctx.sdkVersion } },
    })
  } catch (err) {
    // Already connected, or capability shape rejected by this SDK version — non-fatal.
    if (ctx.config.debug) writeStderr(`Arthur MCP SDK: capability registration skipped (${String(err)})`)
  }
}
