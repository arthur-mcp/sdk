// Runtime detection (no side effects) plus a runtime-aware stderr sink for SDK-internal debug logs.
import type { Runtime } from './types.js'

/** Typed view of cross-runtime globals, accessed without importing any Node.js built-ins. */
const g = globalThis as unknown as {
  caches?: unknown
  WorkerGlobalScope?: unknown
  Deno?: unknown
  Bun?: unknown
  process?: { versions?: { node?: string }; stderr?: { write?: (s: string) => void } }
}

/**
 * Detect the current JavaScript runtime. Checked in a fixed order — Cloudflare Workers first, since
 * the Workers environment may partially expose process-like globals.
 *
 * @returns The detected {@link Runtime}.
 */
export function detectRuntime(): Runtime {
  if (typeof g.caches !== 'undefined' && typeof g.WorkerGlobalScope !== 'undefined') return 'cloudflare-workers'
  if (typeof g.Deno !== 'undefined') return 'deno'
  if (typeof g.Bun !== 'undefined') return 'bun'
  if (typeof g.process !== 'undefined' && g.process.versions?.node) return 'node'
  return 'unknown'
}

/**
 * Write a single line to stderr using whatever sink the runtime provides. Callers must gate this on
 * the `debug` config flag; this function does not check it.
 *
 * @param message - The line to write (a trailing newline is added if missing).
 */
export function writeStderr(message: string): void {
  const line = message.endsWith('\n') ? message : `${message}\n`
  const write = g.process?.stderr?.write
  if (typeof write === 'function') {
    write.call(g.process!.stderr, line)
    return
  }
  // Edge runtimes (Workers/Deno) have no process.stderr — console.error is the stderr-equivalent
  // sink. This is console.error (not console.log) and only ever reached as the edge fallback.
  console.error(message)
}
