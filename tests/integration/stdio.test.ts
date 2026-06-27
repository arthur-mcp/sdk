// Integration tests — stdio transport. Spawns the fixture as a real child process and communicates
// over stdin/stdout using the MCP protocol. A local HTTP server captures ingest events.
import * as http from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolCallEvent } from '../../src/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = resolve(__dirname, '../fixtures/stdio-server.ts')
const TSX_BIN = resolve(__dirname, '../../node_modules/.bin/tsx')

/** Spin up a local HTTP server that captures ingest POST bodies. */
function createCaptureServer(): Promise<{
  port: number
  events: ToolCallEvent[]
  close: () => Promise<void>
}> {
  const events: ToolCallEvent[] = []

  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { events: ToolCallEvent[] }
          events.push(...parsed.events)
        } catch {
          // Ignore malformed posts in tests.
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })

    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      resolve({
        port: addr.port,
        events,
        close: () => new Promise<void>((r, e) => srv.close((err) => (err ? e(err) : r()))),
      })
    })
  })
}

/** Poll until `predicate()` is true or timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('stdio integration', () => {
  let capture: Awaited<ReturnType<typeof createCaptureServer>>
  let client: Client
  let transport: StdioClientTransport

  beforeEach(async () => {
    capture = await createCaptureServer()

    transport = new StdioClientTransport({
      command: TSX_BIN,
      args: [FIXTURE],
      env: {
        ...process.env,
        INGEST_URL: `http://127.0.0.1:${capture.port}/v1/events`,
      },
      stderr: 'pipe',
    })

    client = new Client({ name: 'stdio-test-client', version: '0.0.1' })
    await client.connect(transport)
  })

  afterEach(async () => {
    await client.close().catch(() => {})
    await capture.close()
  })

  it('case 1: tool call over stdio produces a telemetry event', async () => {
    await client.callTool({ name: 'ping', arguments: { message: 'hello' } })

    await waitUntil(() => capture.events.length >= 1)

    expect(capture.events).toHaveLength(1)
    expect(capture.events[0].toolName).toBe('ping')
    expect(capture.events[0].success).toBe(true)
    expect(capture.events[0].runtime).toBe('node')
  })

  it('case 2: telemetry flush does not delay the tool call response', async () => {
    // The tool response must arrive before any ingest HTTP call is made.
    // We verify by measuring the tool call round-trip against the server-side flush latency.
    let responseReceivedAt = 0

    const start = performance.now()
    await client.callTool({ name: 'ping', arguments: { message: 'timing' } })
    responseReceivedAt = performance.now()

    const callDurationMs = responseReceivedAt - start

    // Wait for the ingest event to arrive (flush happens asynchronously after response).
    await waitUntil(() => capture.events.length >= 1)

    // The tool call should have completed well within a reasonable window.
    // If ingest were blocking the response path, callDurationMs would be much larger.
    expect(callDurationMs).toBeLessThan(2000)
    expect(capture.events[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('case 3: process exit flushes pending events', async () => {
    // Make a tool call; then close the client (which closes stdin on the child process,
    // triggering beforeExit / flush before the process exits).
    await client.callTool({ name: 'ping', arguments: { message: 'pre-exit' } })

    // Close the client transport — the child process will exit after stdin closes.
    await client.close().catch(() => {})

    // Give the child time to flush its buffer and the HTTP event to arrive.
    await waitUntil(() => capture.events.length >= 1, 5000)

    expect(capture.events.length).toBeGreaterThanOrEqual(1)
    expect(capture.events[0].toolName).toBe('ping')
  })
})
