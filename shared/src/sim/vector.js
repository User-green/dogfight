/**
 * 2D Vector with pure immutable operations (returning new Vector2 instances).
 * Optional in-place variants are provided for hot paths to avoid GC allocation.
 */
export class Vector2 {
  /**
   * @param {number} x
   * @param {number} y
   */
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  /**
   * Pure vector addition: a + b
   * @param {Vector2} v
   * @returns {Vector2}
   */
  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  /**
   * Pure vector subtraction: a - b
   * @param {Vector2} v
   * @returns {Vector2}
   */
  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  /**
   * Pure scalar multiplication: a * s
   * @param {number} s
   * @returns {Vector2}
   */
  scale(s) {
    return new Vector2(this.x * s, this.y * s);
  }

  /**
   * Dot product: a · b
   * @param {Vector2} v
   * @returns {number}
   */
  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  /**
   * Squared length: |v|² (no Math.sqrt, fast for comparisons)
   * @returns {number}
   */
  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  /**
   * Euclidean length: |v|
   * @returns {number}
   */
  length() {
    return Math.hypot(this.x, this.y);
  }

  /**
   * Pure unit vector (direction). Returns zero vector if length is 0.
   * @returns {Vector2}
   */
  normalize() {
    const len = this.length();
    if (len === 0) return new Vector2(0, 0);
    return new Vector2(this.x / len, this.y / len);
  }

  /**
   * Pure 2D rotation by angle in radians around the origin.
   * @param {number} rad
   * @returns {Vector2}
   */
  rotate(rad) {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return new Vector2(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos
    );
  }

  /**
   * Clone vector
   * @returns {Vector2}
   */
  clone() {
    return new Vector2(this.x, this.y);
  }

  // --- Hot-path mutable helpers (avoid heap allocation in 60Hz inner loops) ---

  /**
   * Mutates this vector by adding v in place.
   * @param {Vector2} v
   * @returns {this}
   */
  addInPlace(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  /**
   * Mutates this vector by scaling in place.
   * @param {number} s
   * @returns {this}
   */
  scaleInPlace(s) {
    this.x *= s;
    this.y *= s;
    return this;
  }

  /**
   * Create a unit direction vector from an angle in radians.
   * In canvas 2D: 0 rad points along +X (right), -PI/2 points along -Y (up).
   * @param {number} rad
   * @param {number} [length=1]
   * @returns {Vector2}
   */
  static fromAngle(rad, length = 1) {
    return new Vector2(Math.cos(rad) * length, Math.sin(rad) * length);
  }
}
