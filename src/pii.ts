// Pure PII-boundary functions: derive parameter-name shapes and content-type lists without ever
// reading input values or output content. No I/O. No dependencies beyond the SDK's own types.
import type { CaptureConfig } from './types.js'

/** Substrings that mark a parameter key as sensitive — such keys are dropped from the shape. */
const SENSITIVE_KEY_SUBSTRINGS = ['token', 'key', 'secret', 'password', 'auth', 'credential', 'api_key']

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
const JWT_RE = /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
const REDACTED = '[redacted]'

/** Narrow `value` to a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True if a key name contains any sensitive substring (case-insensitive). */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_KEY_SUBSTRINGS.some((s) => lower.includes(s))
}

/**
 * Extract the sorted, sensitive-filtered top-level parameter *names* of a tool call's arguments.
 * Never reads values and never recurses into nested objects.
 *
 * @param args - The `params.arguments` value from a tools/call request.
 * @returns Sorted key names with sensitive keys removed, or `null` if `args` is not a plain object.
 */
export function extractInputShape(args: unknown): string[] | null {
  if (!isPlainObject(args)) return null
  return Object.keys(args)
    .filter((key) => !isSensitiveKey(key))
    .sort()
}

/**
 * Extract the `type` of each content block in a tool result. Reads only the `type` field —
 * never `.text`, `.data`, `.blob`, or any other content-bearing field.
 *
 * @param content - The `result.content` array from a tools/call response.
 * @returns Array of content-block type strings (`'unknown'` for blocks lacking a string type),
 *          or `null` if `content` is not an array.
 */
export function extractOutputTypes(content: unknown): string[] | null {
  if (!Array.isArray(content)) return null
  return content.map((item) => {
    const type = isPlainObject(item) ? item['type'] : undefined
    return typeof type === 'string' ? type : 'unknown'
  })
}

/**
 * Truncate and scrub an error message for transport. Strips emails, UUIDs, IPv4 addresses, and
 * JWT-like (`header.payload.signature`) strings. Gated entirely on `config.errorMessages`.
 *
 * @param msg - The raw error message, if any.
 * @param config - Capture configuration; when `errorMessages` is false, nothing is captured.
 * @returns A scrubbed message truncated to 200 chars, or `null` when disabled or absent.
 */
export function sanitizeErrorMessage(msg: string | undefined, config: CaptureConfig): string | null {
  if (msg === undefined || !config.errorMessages) return null
  return msg
    .slice(0, 200)
    .replace(EMAIL_RE, REDACTED)
    .replace(UUID_RE, REDACTED)
    .replace(JWT_RE, REDACTED)
    .replace(IPV4_RE, REDACTED)
}
