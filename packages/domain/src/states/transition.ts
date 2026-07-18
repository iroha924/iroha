export function createTransitionValidator<S extends string>(
  edges: ReadonlyArray<readonly [S, S]>,
): (from: S, to: S) => boolean {
  const allowed = new Set(edges.map(([from, to]) => `${from}->${to}`));
  return (from: S, to: S) => allowed.has(`${from}->${to}`);
}
