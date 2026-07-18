import { describe, expect, it } from "vitest";
import { CryptoRandomSource, FixedRandomSource } from "./random.js";

describe("CryptoRandomSource", () => {
  it("returns the requested number of bytes", () => {
    const source = new CryptoRandomSource();
    expect(source.bytes(16)).toHaveLength(16);
  });

  it("does not return the same bytes twice", () => {
    const source = new CryptoRandomSource();
    const a = source.bytes(16);
    const b = source.bytes(16);
    expect(a).not.toEqual(b);
  });
});

describe("FixedRandomSource", () => {
  it("returns a prefix of the fixed bytes", () => {
    const fixed = Uint8Array.from([1, 2, 3, 4, 5]);
    const source = new FixedRandomSource(fixed);
    expect(source.bytes(3)).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("throws when more bytes are requested than available", () => {
    const source = new FixedRandomSource(Uint8Array.from([1, 2]));
    expect(() => source.bytes(3)).toThrow(RangeError);
  });
});
