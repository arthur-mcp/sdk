// Public API. Wires the ingest sender, telemetry buffer, and transport instrumenter onto an existing
// McpServer and returns it. No behavior beyond assembly — all logic lives in the modules it composes.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TelemetryBuffer } from './buffer.js'
import { createIngestSender } from './ingest.js'
import { detectRuntime, writeStderr } from './runtime.js'
import { SDK_VERSION } from './version.js'
import { TransportInstrumenter, instrumentServer, type WrapperContext } from './wrapper.js'
import type { ArthurSdkConfig, ResolvedConfig } from './types.js'

export type {
  ArthurSdkConfig,
  CaptureConfig,
  ToolCallEvent,
} from './types.js'
export { SDK_VERSION } from './version.js'

/** Default Arthur ingest endpoint. Overridable via `config.ingestUrl`. */
const DEFAULT_INGEST_URL = 'https://ingest.arthurmcp.com/v1/events'

/** An instrumented server also exposes a manual `flush()` for graceful shutdown / `waitUntil`. */
export type InstrumentedMcpServer = McpServer & { flush: () => Promise<void> }

/**
 * Wrap an MCP server so every `tools/call` is captured as a {@link ToolCallEvent} and shipped
 * asynchronously to Arthur. Returns the same server instance — publishers replace their export with
 * the return value and change nothing else. Never adds latency, never throws into the call path, and
 * silently no-ops (uninstrumented) on invalid configuration rather than breaking server startup.
 *
 * @param server - The high-level `McpServer` to instrument.
 * @param config - Publisher configuration; `publisherKey` and `serverSlug` are required.
 * @returns The same server, instrumented, with an added `flush()` method.
 */
export function withArthurAnalytics(server: McpServer, config: ArthurSdkConfig): InstrumentedMcpServer {
  const resolved = resolveConfig(config)

  if (!resolved) {
    // Required config missing — fail open: leave the server untouched and add a no-op flush.
    if (config.debug) writeStderr('Arthur MCP SDK: publisherKey and serverSlug are required — telemetry disabled.')
    return attachFlush(server, async () => {})
  }

  const sender = createIngestSender({
    ingestUrl: resolved.ingestUrl,
    publisherKey: resolved.publisherKey,
    sdkVersion: SDK_VERSION,
  })
  const buffer = new TelemetryBuffer({
    flushIntervalMs: resolved.flushIntervalMs,
    maxBatchSize: resolved.maxBatchSize,
    debug: resolved.debug,
    sender,
  })

  const ctx: WrapperContext = {
    config: resolved,
    buffer,
    sdkVersion: SDK_VERSION,
    serverVersion: readServerVersion(server),
    runtime: detectRuntime(),
  }
  instrumentServer(server, ctx, new TransportInstrumenter(ctx))

  return attachFlush(server, () => buffer.flush())
}

/** Attach a `flush()` method to the server and return it with the augmented type. */
function attachFlush(server: McpServer, flush: () => Promise<void>): InstrumentedMcpServer {
  const augmented = server as InstrumentedMcpServer
  augmented.flush = flush
  return augmented
}

/** Apply defaults to the public config. Returns `null` when a required field is missing. */
function resolveConfig(config: ArthurSdkConfig): ResolvedConfig | null {
  if (!config.publisherKey || !config.serverSlug) return null
  return {
    publisherKey: config.publisherKey,
    serverSlug: config.serverSlug,
    ingestUrl: config.ingestUrl ?? DEFAULT_INGEST_URL,
    capture: {
      inputShape: config.capture?.inputShape ?? true,
      outputTypes: config.capture?.outputTypes ?? true,
      errorMessages: config.capture?.errorMessages ?? false,
      sessionIds: config.capture?.sessionIds ?? true,
    },
    flushIntervalMs: config.flushIntervalMs ?? 5000,
    maxBatchSize: config.maxBatchSize ?? 50,
    debug: config.debug ?? false,
  }
}

/**
 * Read the server's own version. The low-level `Server` keeps `serverInfo` private with no public
 * getter in the 1.x API, so the documented private field is read defensively.
 */
function readServerVersion(server: McpServer): string {
  const info = (server.server as unknown as { _serverInfo?: { version?: string } })._serverInfo
  return typeof info?.version === 'string' ? info.version : 'unknown'
}
