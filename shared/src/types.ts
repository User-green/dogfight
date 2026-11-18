// Branded primitives: a `Tick` is not an `EntityId` is not a `Seq`, though all three are numbers at runtime.
// The brand exists only in the type system (`declare` is erased), so it costs nothing at runtime.
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EntityId = Brand<number, 'EntityId'>;
export type Tick = Brand<number, 'Tick'>;
export type Seq = Brand<number, 'Seq'>;

/** The one brand cast: a brand is, by definition, a lie the type system believes. Every call site goes through
 *  a constructor below, so the lie is made in exactly one place (the caller validates: zod / codec). */
const makeBrand = <T extends Brand<number, string>>(n: number): T => n as T;
export const asEntityId = (n: number): EntityId => makeBrand<EntityId>(n);
export const asTick = (n: number): Tick => makeBrand<Tick>(n);
export const asSeq = (n: number): Seq => makeBrand<Seq>(n);

/** "Not assigned yet": the World hands out ids from 1. */
export const NO_ID: EntityId = asEntityId(0);

export interface Arena {
  readonly width: number;
  readonly height: number;
}

/** Rng: a function giving floats in [0, 1). */
export type Rng = () => number;

/** Tiny exhaustiveness helper: put it in the `default` of a switch over a union. Compile error if a case is missing; throws if the impossible happens anyway. */
export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
