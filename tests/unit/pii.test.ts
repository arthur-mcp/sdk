// Unit tests for the PII-boundary functions (spec Part 6 — pii.test.ts, 14 cases).
import { describe, expect, it } from 'vitest'
import { extractInputShape, extractOutputTypes, sanitizeErrorMessage } from '../../src/pii.js'
import type { CaptureConfig } from '../../src/types.js'

const captureOn: CaptureConfig = { inputShape: true, outputTypes: true, errorMessages: true, sessionIds: true }
const captureOff: CaptureConfig = { ...captureOn, errorMessages: false }

describe('extractInputShape', () => {
  it('1. returns sorted key names', () => {
    expect(extractInputShape({ zebra: 1, apple: 2, mango: 3 })).toEqual(['apple', 'mango', 'zebra'])
  })

  it('2. returns null for non-object input', () => {
    expect(extractInputShape('hello')).toBeNull()
    expect(extractInputShape(42)).toBeNull()
    expect(extractInputShape(null)).toBeNull()
    expect(extractInputShape(['a', 'b'])).toBeNull()
  })

  it('3. filters "password" key', () => {
    expect(extractInputShape({ username: 'x', password: 'y' })).toEqual(['username'])
  })

  it('4. filters "api_key" key', () => {
    expect(extractInputShape({ query: 'x', api_key: 'y' })).toEqual(['query'])
  })

  it('5. filters "token" key', () => {
    expect(extractInputShape({ data: 'x', token: 'y', access_token: 'z' })).toEqual(['data'])
  })

  it('6. does not recurse into nested objects', () => {
    expect(extractInputShape({ outer: { password: 'secret', inner: 1 } })).toEqual(['outer'])
  })
})

describe('extractOutputTypes', () => {
  it('7. returns type array from content blocks', () => {
    expect(extractOutputTypes([{ type: 'text', text: 'hi' }, { type: 'image', data: '...' }])).toEqual(['text', 'image'])
  })

  it('8. returns "unknown" for blocks without type field', () => {
    expect(extractOutputTypes([{ text: 'hi' }, {}])).toEqual(['unknown', 'unknown'])
  })

  it('9. returns null for non-array input', () => {
    expect(extractOutputTypes({ type: 'text' })).toBeNull()
    expect(extractOutputTypes('text')).toBeNull()
    expect(extractOutputTypes(null)).toBeNull()
  })
})

describe('sanitizeErrorMessage', () => {
  it('10. truncates at 200 chars', () => {
    const long = 'a'.repeat(500)
    const result = sanitizeErrorMessage(long, captureOn)
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(200)
  })

  it('11. strips email addresses', () => {
    const result = sanitizeErrorMessage('failed for user alice@example.com today', captureOn)
    expect(result).not.toContain('alice@example.com')
    expect(result).toContain('[redacted]')
  })

  it('12. strips JWT-like strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const result = sanitizeErrorMessage(`token rejected: ${jwt}`, captureOn)
    expect(result).not.toContain(jwt)
    expect(result).toContain('[redacted]')
  })

  it('13. returns null when capture.errorMessages = false', () => {
    expect(sanitizeErrorMessage('some error', captureOff)).toBeNull()
  })

  it('14. returns null for undefined input', () => {
    expect(sanitizeErrorMessage(undefined, captureOn)).toBeNull()
  })
})
