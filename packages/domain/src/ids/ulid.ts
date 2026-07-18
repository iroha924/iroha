import type { Clock } from "../ports/clock.js";
import type { RandomSource } from "../ports/random.js";

/**
 * Crockford Base32 alphabet (excludes I, L, O, U). Matches the ULID spec
 * and the `ulid` pattern in schemas/canonical-v1.schema.json.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

function encodeTimestamp(timestampMs: number): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffffffffffff) {
    throw new RangeError(`ULID timestamp out of 48-bit range: ${timestampMs}`);
  }
  let value = timestampMs;
  let output = "";
  for (let i = 0; i < 10; i++) {
    output = ENCODING.charAt(value % 32) + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandomness(bytes: Uint8Array): string {
  if (bytes.length !== 10) {
    throw new RangeError(`ULID randomness must be exactly 10 bytes, got ${bytes.length}`);
  }
  let buffer = 0;
  let bufferBits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferBits += 8;
    while (bufferBits >= 5) {
      bufferBits -= 5;
      output += ENCODING.charAt((buffer >>> bufferBits) & 0x1f);
    }
  }
  return output;
}

/** Generates a 26-character Crockford Base32 ULID: 10-char timestamp + 16-char randomness. */
export function generateUlid(clock: Clock, random: RandomSource): string {
  const timestampMs = clock.now().getTime();
  return encodeTimestamp(timestampMs) + encodeRandomness(random.bytes(10));
}
