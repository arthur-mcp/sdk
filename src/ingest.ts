// HTTP client for the Arthur ingest API. POSTs event batches with publisher-key bearer auth.
// Never throws: network errors and non-2xx responses resolve to a drop; 401 signals a permanent stop.
import type { EventSender, SendResult, ToolCallEvent } from './types.js'

/** Inputs needed to build an ingest sender. */
export interface IngestOptions {
  ingestUrl: string
  publisherKey: string
  sdkVersion: string
}

/**
 * Build an {@link EventSender} that ships batches to the Arthur ingest endpoint. The publisher key
 * (never a user or agent token) is sent as a bearer credential per RFC 8707 constraints.
 *
 * @param opts - Ingest endpoint, publisher key, and SDK version.
 * @returns A sender that resolves to a {@link SendResult} and never throws.
 */
export function createIngestSender(opts: IngestOptions): EventSender {
  return async (events: ToolCallEvent[]): Promise<SendResult> => {
    try {
      const res = await fetch(opts.ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.publisherKey}`,
          'x-arthur-sdk-version': opts.sdkVersion,
        },
        body: JSON.stringify({ events }),
      })
      if (res.status === 401) return { status: 'unauthorized' }
      if (!res.ok) return { status: 'error' }
      return { status: 'ok' }
    } catch {
      // Network error / DNS failure / abort → drop the batch silently. The tool call already succeeded.
      return { status: 'error' }
    }
  }
}
