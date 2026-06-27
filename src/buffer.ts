// The telemetry batch buffer: queues events and flushes them off the hot path. Flushing is always
// fire-and-forget, failed flushes drop their batch with no retry, and concurrent flushes coalesce.
import { detectRuntime, writeStderr } from './runtime.js'
import type { EventSender, Runtime, SendResult, ToolCallEvent } from './types.js'

/** Hard cap on queued events; oldest are dropped on overflow so memory is bounded. */
const MAX_QUEUE_SIZE = 500

/** Minimal shape of the Node `process` object used for the exit hook (avoids a built-in import). */
interface NodeProcessLike {
  on?: (event: string, listener: () => void) => void
}

/** Construction options for {@link TelemetryBuffer}. */
export interface BufferOptions {
  flushIntervalMs: number
  maxBatchSize: number
  debug: boolean
  /** Injected batch sender — real HTTP client in production, a mock in tests. */
  sender: EventSender
  /** Override runtime detection (mainly for tests). */
  runtime?: Runtime
  /** Install the Node `beforeExit` flush hook. Defaults to true; tests pass false to avoid leaks. */
  installProcessHooks?: boolean
}

/**
 * Bounded, self-flushing event queue. The single chokepoint between the wrapper and the ingest
 * client. Never blocks the caller and never throws.
 */
export class TelemetryBuffer {
  private readonly queue: ToolCallEvent[] = []
  private readonly maxBatchSize: number
  private readonly flushIntervalMs: number
  private readonly debug: boolean
  private readonly sender: EventSender

  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> | null = null
  private stopped = false
  private unauthorizedLogged = false

  constructor(opts: BufferOptions) {
    this.maxBatchSize = opts.maxBatchSize
    this.flushIntervalMs = opts.flushIntervalMs
    this.debug = opts.debug
    this.sender = opts.sender

    const installHooks = opts.installProcessHooks ?? true
    if (installHooks && (opts.runtime ?? detectRuntime()) === 'node') {
      this.installNodeExitHook()
    }
  }

  /**
   * Add an event to the queue. Triggers an async flush when the batch is full, otherwise arms the
   * time-window timer. Drops the event silently once sending has been stopped (post-401).
   *
   * @param event - The event to enqueue.
   */
  enqueue(event: ToolCallEvent): void {
    if (this.stopped) return
    this.queue.push(event)
    while (this.queue.length > MAX_QUEUE_SIZE) this.queue.shift() // overflow → drop oldest

    if (this.queue.length >= this.maxBatchSize) {
      void this.flush() // batch full → immediate async flush, fire-and-forget
    } else {
      this.ensureTimer()
    }
  }

  /**
   * Flush queued events to ingest. Concurrent calls coalesce onto a single in-flight flush. Always
   * resolves (never rejects); failures drop the batch.
   *
   * @returns A promise that resolves when the in-flight flush completes.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  /** Number of events currently queued (introspection / tests). */
  size(): number {
    return this.queue.length
  }

  /** Whether the time-window timer is currently armed (introspection / tests). */
  hasTimer(): boolean {
    return this.timer !== null
  }

  /** Whether sending has been permanently stopped (e.g. after a 401). */
  isStopped(): boolean {
    return this.stopped
  }

  private async doFlush(): Promise<void> {
    this.clearTimer()
    if (this.stopped || this.queue.length === 0) return

    // Remove the batch up front: on success or failure it is gone (drop, never retry).
    const batch = this.queue.splice(0, this.queue.length)

    let result: SendResult
    try {
      result = await this.sender(batch)
    } catch {
      // The sender should never throw; if it does, swallow so no unhandled rejection escapes.
      return
    }

    if (result.status === 'unauthorized') {
      this.stopped = true
      if (!this.unauthorizedLogged) {
        this.unauthorizedLogged = true
        this.log('Arthur MCP SDK: ingest returned 401 — telemetry stopped (check publisherKey).')
      }
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushIntervalMs)
    // Don't let the flush timer keep a Node process alive; the beforeExit hook handles final flush.
    const timer = this.timer as unknown as { unref?: () => void }
    if (typeof timer.unref === 'function') timer.unref()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private installNodeExitHook(): void {
    const proc = (globalThis as { process?: NodeProcessLike }).process
    proc?.on?.('beforeExit', () => {
      void this.flush()
    })
  }

  private log(message: string): void {
    if (this.debug) writeStderr(message)
  }
}
