# CLAUDE.md — Arthur MCP Analytics SDK

> This file is the authoritative spec for `packages/mcp-sdk`. Read it fully before writing any code.
> All rules here are non-negotiable unless explicitly overridden by a human in this file.

---

## What this package is

`@arthur/mcp-sdk` is a zero-friction telemetry wrapper for MCP servers. Publishers add one import and one function call. Every `tools/call` that passes through the server is automatically captured as a `ToolCallEvent` and shipped asynchronously to the Arthur ingest API.

**What the SDK must never do:**
- Add latency to a tool call response
- Throw an exception that the server does not throw
- Capture tool input values or output content
- Break when the ingest API is unreachable

---

## Part 1 — MCP Protocol Context

Read this before writing any code. The SDK's behavior is constrained by the protocol.

### 1.1 Transports

MCP supports two transports. The SDK must behave correctly on both.

| Transport | Context | SDK flush requirement |
|---|---|---|
| `stdio` | Local servers, Claude Desktop, Claude Code | `setImmediate()` after response write; synchronous attempt on `beforeExit` |
| Streamable HTTP | Remote servers, Cloudflare Workers, cloud | `ctx.waitUntil(flush())` on Workers; `res.on('finish')` on Node HTTP |

> **CRITICAL:** Telemetry flush must NEVER block the tool call response path. The response is written first. The flush happens after.

### 1.2 The 2026-07-28 Spec — What Changed

The SDK must be forward-compatible with MCP spec `2026-07-28` (RC locked May 21, 2026; final July 28, 2026).

**Stateless protocol core (breaking)**
Sessions (`Mcp-Session-Id`, `initialize`/`initialized` handshake) are removed from the protocol core. Every request carries its own identity in `params._meta`. Do not store any session-keyed state anywhere in the SDK.

**W3C Trace Context — SEP-414 (critical for Arthur)**
`traceparent`, `tracestate`, and `baggage` now propagate through `params._meta` with locked key names. This is the SDK's most important integration point:
- If `params._meta.traceparent` is present, the SDK MUST extract it and forward it in the `ToolCallEvent`
- The SDK MUST generate a child `traceparent` for the tool call span (same `traceId`, new `spanId`)
- This enables Arthur analytics events to correlate end-to-end with the caller's distributed trace in any OTel backend

**Extensions framework — SEP-2133**
Register the SDK as capability extension `com.arthurmcp.analytics` in the server's capability map during `initialize`. This signals to sophisticated hosts that the server has analytics instrumented.

**New required HTTP headers**
On Streamable HTTP, `Mcp-Method` and `Mcp-Name` headers are now present at the HTTP layer. The ingest worker can read these without parsing the body.

**HTTP caching metadata — SEP-2549**
`tools/list` and resource reads may include `ttlMs` and `cacheScope`. Capture these when present — they are useful publisher analytics signals.

**Deprecated (12-month runway, do not use)**
Sampling, Roots, and MCP Logging are deprecated. Use `stderr` or OpenTelemetry for any SDK-internal logging.

### 1.3 TypeScript SDK Integration Target

```
@modelcontextprotocol/sdk  v1.x  (production)
                           v2    (Q3 2026, align when stable)
```

Wrap `McpServer` (high-level API), not `Server` (low-level). Intercept at the **transport `onmessage` handler** — this is the single chokepoint all `tools/call` requests pass through. Do not intercept at `registerTool()` — that requires patching every tool individually and breaks with dynamic registration.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
```

### 1.4 Security Constraints

| Threat | SDK obligation |
|---|---|
| Prompt injection via tool descriptions | Never log or transmit tool description text — tool names only |
| Data exfiltration via telemetry | Never capture input values or output content — shapes only |
| Supply chain trust | Fail closed: drop telemetry silently if ingest is unreachable; the tool call always succeeds |
| Token mis-redemption (RFC 8707) | Auth to ingest API uses publisher keys only — never user or agent tokens |

---

## Part 2 — Package Structure

```
packages/mcp-sdk/
  src/
    index.ts          # Public API: withArthurAnalytics()
    wrapper.ts        # Transport interception logic
    buffer.ts         # Telemetry batch buffer + flush
    trace.ts          # W3C Trace Context extraction/generation
    pii.ts            # Input sanitization + shape extraction
    types.ts          # ToolCallEvent, SdkConfig, all public types
    runtime.ts        # Runtime detection (CF Workers, Node, Bun, Deno)
    ingest.ts         # HTTP client for Arthur ingest API
    errors.ts         # SDK-internal error classes
  tests/
    unit/
      buffer.test.ts
      trace.test.ts
      pii.test.ts
      wrapper.test.ts
    integration/
      cloudflare.test.ts
      node.test.ts
      stdio.test.ts
    fixtures/
      mock-mcp-server.ts
      mock-ingest-server.ts
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
```

---

## Part 3 — Public API

### `withArthurAnalytics(server, config): McpServer`

The only export. Returns the same `McpServer` instance with transport wrapped. Publishers replace their server export with the return value — no other changes required.

```ts
export function withArthurAnalytics(
  server: McpServer,
  config: ArthurSdkConfig
): McpServer
```

### `ArthurSdkConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `publisherKey` | `string` | required | Publisher API key from arthurmcp.com |
| `serverSlug` | `string` | required | Unique server identifier in the registry |
| `ingestUrl` | `string` | `https://ingest.arthurmcp.com/v1/events` | Override ingest endpoint |
| `capture.inputShape` | `boolean` | `true` | Capture parameter names (not values) |
| `capture.outputTypes` | `boolean` | `true` | Capture content types (not content) |
| `capture.errorMessages` | `boolean` | `false` | Include truncated error message strings |
| `capture.sessionIds` | `boolean` | `true` | Enable request-scoped correlation IDs |
| `flushIntervalMs` | `number` | `5000` | Max ms between flushes |
| `maxBatchSize` | `number` | `50` | Max events per batch before forced flush |
| `debug` | `boolean` | `false` | Log SDK activity to stderr |

---

## Part 4 — ToolCallEvent Schema

Every field must be present or explicitly `null`. Never add required fields without a schema version bump.

```ts
type ToolCallEvent = {
  schemaVersion: string         // "1.0" — bump only on breaking changes
  publisherKey: string          // From config — never logged in output
  serverSlug: string            // From config
  toolName: string              // From tools/call params.name
  correlationId: string | null  // Hash of traceparent if present, else crypto.randomUUID()
  traceParent: string | null    // Raw traceparent from params._meta — forwarded verbatim
  startedAt: number             // Date.now() before tool handler invoked
  durationMs: number            // Measured to response write completion
  success: boolean              // false if isError:true or exception thrown
  errorCode: string | null      // MCP error code string only (e.g. "InvalidParams")
  errorMessage: string | null   // Truncated to 200 chars. Null if capture.errorMessages=false
  inputParamNames: string[]|null// Sorted param key names. Null if capture.inputShape=false
  inputSizeBytes: number        // JSON.stringify(params.arguments).length
  outputContentTypes:string[]|null // e.g. ["text","image"]. Null if capture.outputTypes=false
  outputSizeBytes: number       // JSON.stringify(result.content).length
  sdkVersion: string            // Injected from package.json at build time
  serverVersion: string         // From McpServer info.version
  runtime: string               // cloudflare-workers | node | bun | deno | unknown
  protocolVersion: string|null  // MCP protocol version from request _meta if present
}
```

> **PII BOUNDARY:** `inputParamNames` contains ONLY parameter key names — never values. `outputContentTypes` contains ONLY the `type` field from each content block — never `text` or `data`. If capturing a field requires reading input values or output content, do not capture it.

---

## Part 5 — Module Specifications

### `types.ts`
All types and interfaces. No logic. Must compile cleanly before any other file is written.

### `pii.ts`
Pure functions. No I/O. No external dependencies.

**`extractInputShape(args: unknown): string[] | null`**
- If `args` is not a plain object → return `null`
- Return `Object.keys(args).sort()` — sorted for deterministic output
- Top-level keys only — never recurse
- Filter any key whose name contains: `token`, `key`, `secret`, `password`, `auth`, `credential`, `api_key`

**`extractOutputTypes(content: unknown): string[] | null`**
- If `content` is not an array → return `null`
- Return `content.map(item => item?.type ?? 'unknown')`
- Never access `.text`, `.data`, `.blob`, or any other content field

**`sanitizeErrorMessage(msg: string | undefined, config: CaptureConfig): string | null`**
- If `msg` is undefined or `config.errorMessages` is false → return `null`
- Truncate to 200 characters
- Strip substrings matching: email addresses, UUIDs, IP addresses, JWT-like strings (`header.payload.signature`)

### `trace.ts`
Pure functions. No I/O. No external dependencies. Implements W3C Trace Context (SEP-414).

**`extractTraceContext(meta: Record<string, unknown> | undefined): TraceContext | null`**
- Reads `traceparent`, `tracestate`, `baggage` from `meta`
- Returns `null` if `traceparent` is absent or malformed
- Never throws

**`createChildSpan(parent: TraceContext | null): ChildSpan`**
- If `parent` is non-null: new `spanId`, same `traceId`, same sampled flag
- If `parent` is null: generate new root `traceparent`
- Returns child span context for inclusion in the event

**traceparent validation regex:** `/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/`
- `traceId` must not be all zeros
- `spanId` must not be all zeros
- Reject both and return `null` if either fails

### `runtime.ts`
Detection only. No side effects. Check in this exact order:

```ts
1. typeof caches !== 'undefined' && typeof WorkerGlobalScope !== 'undefined'  → 'cloudflare-workers'
2. typeof Deno !== 'undefined'                                                 → 'deno'
3. typeof Bun !== 'undefined'                                                  → 'bun'
4. typeof process !== 'undefined' && process.versions?.node                   → 'node'
5. fallback                                                                    → 'unknown'
```

Workers must be checked first — the Workers environment may partially expose process-like globals.

### `buffer.ts`
The core performance component. These flush rules are all required:

| Trigger | Condition | Action |
|---|---|---|
| Batch full | `queue.length >= maxBatchSize` | Immediate async flush, reset timer |
| Time window | `flushIntervalMs` elapsed | Flush whatever is queued |
| Node exit | `process.on('beforeExit')` | Synchronous flush attempt |
| CF Workers | `ctx.waitUntil()` on every request | Flush after response |
| Manual | `sdk.flush()` public method | Returns `Promise<void>` |

**Additional constraints:**
- Flush is fire-and-forget — never `await` inline in the tool call path
- Failed flushes drop the batch — no retry
- Concurrent flush calls coalesce — one in-flight at a time
- Max queue size: 500 events — drop oldest on overflow

### `ingest.ts`
HTTP client only. `POST` batches to the ingest URL with `Authorization: Bearer {publisherKey}`.

Error handling:
- Network error → drop batch silently, no throw
- 401 response → log to stderr once, stop sending, no throw
- Other non-2xx → drop batch silently, no throw

### `wrapper.ts`
The interception layer. Overrides the transport `onmessage` handler. Purely observational — must not modify requests or responses in any way.

Interception points:
1. **Before dispatch:** capture `startedAt`, extract `toolName` from request, extract `traceparent` from `params._meta`
2. **After dispatch success:** capture `durationMs`, extract output shape via `pii.ts`, enqueue event
3. **After dispatch error:** capture `durationMs`, error code, conditionally sanitize error message, enqueue event, re-throw original error unchanged

Error handling rules (apply in order):
1. Ingest unreachable → drop batch silently, never throw
2. Schema validation fails on event → drop that event, log to stderr if `debug=true`
3. Publisher key invalid (401) → log to stderr once, stop sending
4. Tool call throws → record error fields, enqueue, re-throw original unchanged
5. `JSON.stringify` throws (circular ref) → `inputSizeBytes = -1`, `inputParamNames = null`, continue

### `index.ts`
Assembles and exports `withArthurAnalytics`. No logic beyond wiring. Written last.

---

## Part 6 — Test Specification

### Testing stack

| Tool | Purpose |
|---|---|
| `vitest` | Test runner — Node and edge runtime simulation |
| `@cloudflare/vitest-pool-workers` | Run tests inside actual Workers runtime — required |
| `msw` | Intercepts `fetch()` to mock ingest API |
| `@modelcontextprotocol/sdk` | Real MCP server instances for integration tests |

### Unit tests

#### `buffer.test.ts` — 12 cases
1. `enqueue()` adds event to queue
2. Queue does not exceed `maxBatchSize` before flush
3. `flush()` is triggered when queue reaches `maxBatchSize`
4. `flush()` is triggered after `flushIntervalMs` elapses
5. `flush()` empties the queue on success
6. `flush()` drops the batch on network error without throwing
7. `flush()` drops oldest events when queue exceeds 500 (overflow)
8. Concurrent `flush()` calls coalesce — only one in-flight at a time
9. Manual `sdk.flush()` resolves after events are sent
10. Timer is cleared after batch flush
11. 401 from ingest stops future sends and logs to stderr once
12. `debug=false` suppresses all stderr output

#### `trace.test.ts` — 10 cases
1. Valid `traceparent` is extracted from `params._meta`
2. Missing `traceparent` returns `null`
3. Malformed `traceparent` (wrong format) returns `null`
4. All-zero `traceId` is rejected
5. All-zero `spanId` is rejected
6. Child span has same `traceId` as parent
7. Child span has different `spanId` than parent
8. Child span inherits sampled flag from parent
9. Root span is generated when parent is `null`
10. `tracestate` and `baggage` are forwarded verbatim from parent

#### `pii.test.ts` — 14 cases
1. `extractInputShape` returns sorted key names
2. `extractInputShape` returns `null` for non-object input
3. `extractInputShape` filters `"password"` key
4. `extractInputShape` filters `"api_key"` key
5. `extractInputShape` filters `"token"` key
6. `extractInputShape` does not recurse into nested objects
7. `extractOutputTypes` returns type array from content blocks
8. `extractOutputTypes` returns `"unknown"` for blocks without `type` field
9. `extractOutputTypes` returns `null` for non-array input
10. `sanitizeErrorMessage` truncates at 200 chars
11. `sanitizeErrorMessage` strips email addresses
12. `sanitizeErrorMessage` strips JWT-like strings
13. `sanitizeErrorMessage` returns `null` when `capture.errorMessages = false`
14. `sanitizeErrorMessage` returns `null` for undefined input

#### `wrapper.test.ts` — 16 cases
1. Tool call success produces a `ToolCallEvent` with correct `toolName`
2. Tool call success records `durationMs > 0`
3. Tool call success sets `success = true`
4. Tool call error sets `success = false`
5. Tool call error captures `errorCode`
6. Tool call re-throws original error unchanged after recording
7. Wrapper does not modify tool call arguments
8. Wrapper does not modify tool call response
9. `traceparent` present in `_meta` is forwarded to event
10. `traceparent` absent — `correlationId` is generated
11. Event is enqueued to buffer (not sent inline)
12. `inputParamNames` is `null` when `capture.inputShape = false`
13. `outputContentTypes` is `null` when `capture.outputTypes = false`
14. `sdkVersion` matches `package.json` version
15. `runtime` is `"cloudflare-workers"` in Workers environment
16. `runtime` is `"node"` in Node.js environment

### Integration tests

#### `node.test.ts` — 6 cases
Stand up a real `McpServer` with `withArthurAnalytics`. Use MSW to intercept ingest POSTs. Use the MCP TypeScript client to make real tool calls.

1. Single tool call produces exactly one event in the batch
2. 50 sequential tool calls produce exactly one flush with 50 events
3. Tool calls with `traceparent` propagate it to all events
4. Failed tool call produces event with `success=false` and does not break subsequent calls
5. `ingestUrl` override in config is respected
6. Flush completes before process exit (`beforeExit` handler)

#### `stdio.test.ts` — 3 cases
Spawn a child process with stdio transport. Communicate via MCP protocol over stdin/stdout pipes.

1. Tool call over stdio produces telemetry event
2. Telemetry flush does not delay tool call response
3. Process exit flushes pending events

#### `cloudflare.test.ts` — 5 cases
Use `@cloudflare/vitest-pool-workers`. Runs inside the actual Workers runtime — not simulated.

1. `ctx.waitUntil()` is called for each flush
2. Telemetry flush does not block request response
3. `crypto.randomUUID()` is available (Workers native)
4. `fetch()` to ingest URL is made with correct `Authorization` header
5. Failed ingest `fetch()` does not throw or affect the tool call response

### Behavioral contract tests

Run in all three environments (Node, Workers, stdio). These are the most important tests.

**Zero-latency contract**
Measure `performance.now()` before and after tool call, and separately measure when the first ingest request fires. Assert: ingest starts AFTER tool response is written.

**Fail-open contract**
Point `ingestUrl` at a non-existent host. Make 100 tool calls. Assert: all 100 succeed, no exceptions propagate, no unhandled promise rejections.

**No content leakage contract**
Register a tool that returns a `TextRun` with a known unique string. Make the call. Inspect all events sent to the mock ingest server. Assert: the unique string does not appear anywhere in any event field.

**No input leakage contract**
Call a tool with a known unique string as an argument value. Inspect all events. Assert: the unique string does not appear anywhere in any event field.

---

## Part 7 — Build Order

Implement files in this order. Each gate must pass before proceeding.

| Step | File | Gate |
|---|---|---|
| 1 | `types.ts` | TypeScript strict compile with zero errors |
| 2 | `pii.ts` | All 14 `pii.test.ts` cases pass |
| 3 | `trace.ts` | All 10 `trace.test.ts` cases pass |
| 4 | `runtime.ts` | No gate — review only |
| 5 | `buffer.ts` | All 12 `buffer.test.ts` cases pass |
| 6 | `ingest.ts` | Mocked in unit tests — no standalone gate |
| 7 | `wrapper.ts` | All 16 `wrapper.test.ts` cases pass |
| 8 | `index.ts` | All integration tests pass in Node and Workers |
| 9 | `README.md` | Written last — all tests must be green first |

---

## Part 8 — Code Quality Rules

- TypeScript `strict: true` — no `any`, no `@ts-ignore` without a comment explaining why
- Every exported function: JSDoc with `@param` and `@returns`
- No dependencies beyond `@modelcontextprotocol/sdk` and `zod`
- No top-level imports of Node.js built-ins — dynamic import guarded by runtime detection
- Every file: one-sentence top comment describing its purpose
- No `console.log` — use `stderr` only, guarded by `debug` config flag

---

## Part 9 — Definition of Done

The SDK is complete when every item below is true. No exceptions.

- [ ] All 52 unit test cases pass in Node.js
- [ ] All 9 Node.js integration test cases pass
- [ ] All 5 Cloudflare Workers integration test cases pass in the actual Workers runtime
- [ ] All 4 behavioral contract tests pass in both Node and Workers
- [ ] Zero latency added to tool call response path — measured, not estimated
- [ ] `npm pack` produces a tarball under 50KB
- [ ] `tsc --strict` produces zero errors
- [ ] Arthur MCP server itself is instrumented and emitting events to a local ingest mock
- [ ] `README.md` contains a working quickstart followable in under 5 minutes

---

## Part 10 — README Requirements

The README is a first-class product artifact. It must contain all of the following:

1. One-paragraph description of what the SDK does and does not do
2. Installation: `npm install @arthur/mcp-sdk`
3. Quickstart: a complete working example in 5 lines or fewer
4. Configuration reference: every `ArthurSdkConfig` field with type, default, and description
5. Privacy section: explicit statement of what is and is not captured, in plain English
6. Runtime support table: CF Workers, Node.js 18+, Bun, Deno
7. Troubleshooting: how to enable debug mode, how to verify events are flowing, common errors

---

*Arthur MCP Analytics SDK — CLAUDE.md v1.0 — June 2026*
*The SDK is the trust layer between Arthur and every publisher. It cannot break a server, leak user data, or add latency. Write the contract tests before the implementation.*
