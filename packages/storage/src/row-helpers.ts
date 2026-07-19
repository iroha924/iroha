/** `libSQL` returns SQL `NULL` as JS `null`; these keep repository row mappers terse. */
export function nullableString(value: unknown): string | null {
  return value === null ? null : String(value);
}

export function nullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value);
}
