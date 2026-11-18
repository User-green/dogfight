/**
 * 2D Vector with pure immutable operations (returning new Vector2 instances).
 * Optional in-place variants are provided for hot paths to avoid GC allocation.
 */
/** Read-only view of a point/vector: what snapshots and public APIs hand out. The sim's own Vector2 stays mutable (hot-path in-place math). */
export interface ReadonlyVec2 {
  readonly x: number;
  readonly y: number;
}

export class Vector2 implements ReadonlyVec2 {
  x: number;
  y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  /**
   * Pure vector addition: a + b
   */
  add(v: ReadonlyVec2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  /**
   * Pure vector subtraction: a - b
   */
  sub(v: ReadonlyVec2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  /**
   * Pure scalar multiplication: a * s
   */
  scale(s: number): Vector2 {
    return new Vector2(this.x * s, this.y * s);
  }

  /**
   * Dot product: a · b
   */
  dot(v: ReadonlyVec2): number {
    return this.x * v.x + this.y * v.y;
  }

  /**
   * Squared length: |v|² (no Math.sqrt, fast for comparisons)
   */
  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  /**
   * Euclidean length: |v|
   */
  length(): number {
    return Math.hypot(this.x, this.y);
  }

  /**
   * Pure unit vector (direction). Returns zero vector if length is 0.
   */
  normalize(): Vector2 {
    const len = this.length();
    if (len === 0) return new Vector2(0, 0);
    return new Vector2(this.x / len, this.y / len);
  }

  /**
   * Pure 2D rotation by angle in radians around the origin.
   */
  rotate(rad: number): Vector2 {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return new Vector2(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos
    );
  }

  /**
   * Clone vector
   */
  clone(): Vector2 {
    return new Vector2(this.x, this.y);
  }

  // --- Hot-path mutable helpers (avoid heap allocation in 60Hz inner loops) ---

  /**
   * Mutates this vector by adding v in place.
   */
  addInPlace(v: ReadonlyVec2): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  /**
   * Mutates this vector by scaling in place.
   */
  scaleInPlace(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }

  /**
   * Create a unit direction vector from an angle in radians.
   * In canvas 2D: 0 rad points along +X (right), -PI/2 points along -Y (up).
   */
  static fromAngle(rad: number, length = 1): Vector2 {
    return new Vector2(Math.cos(rad) * length, Math.sin(rad) * length);
  }
}
