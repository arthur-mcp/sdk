// SDK-internal error classes. These never propagate into the host server's call path — they are
// used only for internal signalling (e.g. ingest auth failures) and never re-thrown to publishers.

/** Base class for all internal SDK errors. */
export class ArthurSdkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArthurSdkError'
  }
}

/** Raised internally when the ingest API rejects the publisher key (HTTP 401). */
export class IngestUnauthorizedError extends ArthurSdkError {
  constructor(message = 'Ingest rejected the publisher key (401)') {
    super(message)
    this.name = 'IngestUnauthorizedError'
  }
}
