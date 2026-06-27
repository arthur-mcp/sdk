# @arthur/mcp-sdk

Zero-friction telemetry for MCP servers. Add one import and one function call — every `tools/call` is automatically captured and shipped asynchronously to Arthur, giving you usage analytics, latency metrics, and error tracking without touching your tool implementations.

The SDK never captures input values or output content, never adds latency to a tool call response, and silently no-ops when the ingest API is unreachable. Your server's behavior is always unchanged.

## Installation

```bash
npm install @arthur/mcp-sdk
```

## Quickstart

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { withArthurAnalytics } from "@arthur/mcp-sdk"

const server = new McpServer({ name: "my-server", version: "1.0.0" })
// ... register your tools ...

export default withArthurAnalytics(server, {
  publisherKey: "pk_live_...",
  serverSlug: "my-server",
})
```

That's it. Every `tools/call` is now tracked.

### Cloudflare Workers

On Workers, call `ctx.waitUntil(server.flush())` after writing the response so in-flight telemetry events aren't dropped when the isolate is recycled:

```ts
export default {
  async fetch(req, env, ctx) {
    const response = await ArthurMCP.serve("/mcp").fetch(req, env, ctx)
    ctx.waitUntil(server.flush())
    return response
  },
}
```

## Configuration

All fields on `ArthurSdkConfig`:

| Field | Type | Default | Description |
|---|---|---|---|
| `publisherKey` | `string` | **required** | Publisher API key from arthurmcp.com |
| `serverSlug` | `string` | **required** | Unique server identifier shown in the dashboard |
| `ingestUrl` | `string` | `https://ingest.arthurmcp.com/v1/events` | Override the ingest endpoint (useful for testing) |
| `capture.inputShape` | `boolean` | `true` | Capture parameter *key names* (never values) |
| `capture.outputTypes` | `boolean` | `true` | Capture content block *types* (never content) |
| `capture.errorMessages` | `boolean` | `false` | Include sanitized, truncated error message strings |
| `capture.sessionIds` | `boolean` | `true` | Generate request-scoped correlation IDs |
| `flushIntervalMs` | `number` | `5000` | Maximum milliseconds between automatic flushes |
| `maxBatchSize` | `number` | `50` | Events per batch before a forced flush |
| `debug` | `boolean` | `false` | Log SDK activity to stderr |

## Privacy

### What is captured

- **Tool name** — the string name passed to `tools/call`
- **Parameter key names** — the top-level keys of the `arguments` object, sorted, with sensitive-sounding keys filtered out (`token`, `key`, `secret`, `password`, `auth`, `credential`, `api_key`)
- **Input size** — `JSON.stringify(arguments).length` in bytes
- **Output content types** — the `type` field from each content block (`"text"`, `"image"`, etc.)
- **Output size** — `JSON.stringify(content).length` in bytes
- **Duration** — milliseconds from request to response write
- **Success / error code** — whether the call succeeded and the MCP error code if not
- **SDK and server version** — for debugging
- **W3C trace context** — `traceparent` forwarded verbatim from `params._meta` when present

### What is never captured

- Input **values** — the content of any argument, regardless of type
- Output **content** — the text, data, or blob inside any content block
- Error **messages** unless `capture.errorMessages: true`, in which case messages are truncated to 200 characters and stripped of email addresses, UUIDs, IP addresses, and JWT-like strings
- Anything from tool **descriptions**

## Runtime support

| Runtime | Supported | Notes |
|---|---|---|
| Cloudflare Workers | ✅ | Tested in real Workers runtime via Miniflare |
| Node.js 18+ | ✅ | `process.on('beforeExit')` flushes on exit |
| Bun | ✅ | Detected and supported |
| Deno | ✅ | Detected and supported |

## Troubleshooting

**Enable debug mode** to log SDK activity to stderr:

```ts
withArthurAnalytics(server, {
  publisherKey: "pk_live_...",
  serverSlug: "my-server",
  debug: true,
})
```

**Verify events are flowing** by pointing `ingestUrl` at a local server during development:

```ts
withArthurAnalytics(server, {
  publisherKey: "pk_dev_...",
  serverSlug: "my-server",
  ingestUrl: "http://localhost:4000/v1/events",
})
```

**Common errors**

| Symptom | Cause | Fix |
|---|---|---|
| No events appear in dashboard | `publisherKey` is wrong | Check the key in arthurmcp.com settings; SDK logs `401` once to stderr when `debug: true` |
| Events arrive late | Default `flushIntervalMs` is 5 s | Lower to `500` during development or call `server.flush()` explicitly |
| Events missing on Workers | Isolate recycled before flush | Add `ctx.waitUntil(server.flush())` in your fetch handler |
| TypeScript error on `flush()` | Return type is `McpServer`, not `InstrumentedMcpServer` | Annotate the variable: `const server: InstrumentedMcpServer = withArthurAnalytics(...)` |
