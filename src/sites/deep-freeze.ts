// WP-07: `Object.freeze` is shallow, so freezing a site document leaves every
// nested `structures`, `floor` and `features` array writable. That makes the
// immutability the resource modules advertise nominal rather than real — a
// consumer holding a reference could mutate collision geometry in place and
// every other consumer would see it.
//
// Kept as its own module because the gameplay and presentation resources must
// not import each other, and neither should have to restate this.

/** Recursively freezes a value and everything reachable from it. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}
