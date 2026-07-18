/**
 * `lib.dom.d.ts` provides these normally, but this package deliberately keeps
 * `lib` to `es2023` (no "dom", no `@types/node`) since it must depend on
 * nothing but Zod. Both Node.js (>=19) and browsers expose `globalThis.crypto`
 * per the Web Crypto standard, so a minimal ambient declaration is enough.
 */
declare global {
  interface Crypto {
    getRandomValues<T extends ArrayBufferView>(array: T): T;
  }
  var crypto: Crypto;
}

export interface RandomSource {
  /** Returns `length` cryptographically random bytes. */
  bytes(length: number): Uint8Array;
}

export class CryptoRandomSource implements RandomSource {
  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    globalThis.crypto.getRandomValues(out);
    return out;
  }
}

export class FixedRandomSource implements RandomSource {
  readonly #fixed: Uint8Array;

  constructor(fixed: Uint8Array) {
    this.#fixed = fixed;
  }

  bytes(length: number): Uint8Array {
    if (length > this.#fixed.length) {
      throw new RangeError(
        `FixedRandomSource has only ${this.#fixed.length} bytes, requested ${length}`,
      );
    }
    return this.#fixed.slice(0, length);
  }
}
