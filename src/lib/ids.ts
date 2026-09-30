/**
 * Identifier generation.
 *
 * Session ids are security-relevant: they are the only thing standing between
 * one caller's order and another's, so they come from a CSPRNG and carry 128
 * bits of entropy. Line ids only need to be unique within an order, but they
 * use the same source for simplicity.
 */

import { randomUUID, randomBytes } from 'node:crypto';

/** 128-bit, unguessable. Used for session and order identifiers. */
export function newSessionId(): string {
  return randomUUID();
}

/** Short, collision-safe within a single order. */
export function newLineId(): string {
  return `ln_${randomBytes(6).toString('hex')}`;
}

/** Correlates every log line and error response for one HTTP request. */
export function newRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

/**
 * Timing-safe comparison for opaque identifiers, so that probing for a valid
 * session id cannot be sped up by measuring response times.
 */
export function idsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}
