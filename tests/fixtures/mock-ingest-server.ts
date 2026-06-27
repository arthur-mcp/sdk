// MSW-based mock for the Arthur ingest API. Captures posted event batches for test assertions.
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import type { ToolCallEvent } from '../../src/types.js'

export const MOCK_INGEST_URL = 'https://mock-ingest.arthur.test/v1/events'

/** Wire a response handler so the server can reject specific requests for testing. */
export type IngestOverride = (request: Request) => Response | null

/**
 * Create an MSW-backed mock ingest server.
 * Call `.mswServer.listen()` in `beforeAll` and `.mswServer.close()` in `afterAll`.
 * Call `.reset()` between tests.
 *
 * @returns Controls for starting/stopping the mock and reading captured events.
 */
export function createMockIngest(opts: { statusCode?: number } = {}) {
  const batches: { events: ToolCallEvent[] }[] = []
  const requestHeaders: Record<string, string>[] = []

  const handler = http.post(MOCK_INGEST_URL, async ({ request }) => {
    const body = (await request.json()) as { events: ToolCallEvent[] }
    batches.push(body)
    requestHeaders.push(Object.fromEntries(request.headers.entries()))
    const status = opts.statusCode ?? 200
    return HttpResponse.json({ ok: status < 400 }, { status })
  })

  const mswServer = setupServer(handler)

  return {
    mswServer,
    /** All events received across all batches, in order. */
    events(): ToolCallEvent[] {
      return batches.flatMap((b) => b.events)
    },
    /** All HTTP request headers received, one entry per batch. */
    headers(): Record<string, string>[] {
      return requestHeaders
    },
    /** Number of POST requests received (one per flush). */
    flushCount(): number {
      return batches.length
    },
    reset() {
      batches.length = 0
      requestHeaders.length = 0
    },
  }
}
