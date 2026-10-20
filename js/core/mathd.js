// Deterministic math for the core. Engines are free to implement Math.sin & co.
// differently, so everything transcendental here is built from + - * / and
// Math.sqrt/abs/floor only, which IEEE 754 makes bit-identical everywhere.

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const QUARTER_PI = 0.7853981633974483;
export const DEG = PI / 180;

// pi/2 split in two (fdlibm): the high part has 33 bits so k * PIO2_HI is exact.
const PIO2_HI = 1.57079632673412561417e+00;
const PIO2_LO = 6.07710050650619224932e-11;
const INV_PIO2 = 6.36619772367581382433e-01;

// Taylor coefficients, accurate to < 1e-16 on |x| <= pi/4.
const S1 = -1 / 6, S2 = 1 / 120, S3 = -1 / 5040, S4 = 1 / 362880, S5 = -1 / 39916800,
    S6 = 1 / 6227020800, S7 = -1 / 1307674368000, S8 = 1 / 355687428096000, S9 = -1 / 121645100408832000;
const C1 = -1 / 2, C2 = 1 / 24, C3 = -1 / 720, C4 = 1 / 40320, C5 = -1 / 3628800,
    C6 = 1 / 479001600, C7 = -1 / 87178291200, C8 = 1 / 20922789888000, C9 = -1 / 6402373705728000;

function sinPoly(x) {
    const z = x * x;
    return x + x * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * (S6 + z * (S7 + z * (S8 + z * S9))))))));
}

function cosPoly(x) {
    const z = x * x;
    return 1 + z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * (C6 + z * (C7 + z * (C8 + z * C9))))))));
}

// Reduces x to r in [-pi/4, pi/4] with x = r + k*pi/2; returns k (quadrant) and stores r.
let reduced = 0;
function reduce(x) {
    if (x >= -QUARTER_PI && x <= QUARTER_PI) {
        reduced = x;
        return 0;
    }
    const k = Math.floor(x * INV_PIO2 + 0.5);
    reduced = (x - k * PIO2_HI) - k * PIO2_LO;
    return k;
}

export function dsin(x) {
    const k = reduce(x) & 3;
    const r = reduced;
    if (k === 0) return sinPoly(r);
    if (k === 1) return cosPoly(r);
    if (k === 2) return -sinPoly(r);
    return -cosPoly(r);
}

export function dcos(x) {
    const k = reduce(x) & 3;
    const r = reduced;
    if (k === 0) return cosPoly(r);
    if (k === 1) return -sinPoly(r);
    if (k === 2) return -cosPoly(r);
    return sinPoly(r);
}

/** Writes [sin x, cos x] into out with a single range reduction. */
export function dsincos(x, out) {
    const k = reduce(x) & 3;
    const s = sinPoly(reduced), c = cosPoly(reduced);
    if (k === 0) { out[0] = s; out[1] = c; }
    else if (k === 1) { out[0] = c; out[1] = -s; }
    else if (k === 2) { out[0] = -s; out[1] = -c; }
    else { out[0] = -c; out[1] = s; }
    return out;
}

export function dtan(x) {
    const k = reduce(x) & 1;
    const s = sinPoly(reduced), c = cosPoly(reduced);
    return k === 0 ? s / c : -c / s;
}

// atan on [0, 1]: shift by a table angle so the series argument stays below tan(pi/16).
const TAN_PI_16 = 0.19891236737965800691;
const TAN_3PI_16 = 0.66817863791929891999;
const TAN_PI_8 = Math.SQRT2 - 1;
const PI_8 = 0.39269908169872415481;

// Horner evaluation of sum c[i] * w^i; a plain loop keeps the operation order fixed.
function horner(c, w) {
    let p = c[c.length - 1];
    for (let i = c.length - 2; i >= 0; i--) p = c[i] + w * p;
    return p;
}

const ATAN_C = [1, -1 / 3, 1 / 5, -1 / 7, 1 / 9, -1 / 11, 1 / 13, -1 / 15, 1 / 17, -1 / 19, 1 / 21, -1 / 23];

function atanSeries(z) {
    return z * horner(ATAN_C, z * z);
}

function atanUnit(t) {
    if (t <= TAN_PI_16) return atanSeries(t);
    if (t <= TAN_3PI_16) return PI_8 + atanSeries((t - TAN_PI_8) / (1 + t * TAN_PI_8));
    return QUARTER_PI + atanSeries((t - 1) / (1 + t));
}

export function datan(x) {
    const a = x < 0 ? -x : x;
    const r = a <= 1 ? atanUnit(a) : HALF_PI - atanUnit(1 / a);
    return x < 0 ? -r : r;
}

/** Angle of (x, y) in (-pi, pi], same conventions as Math.atan2. */
export function datan2(y, x) {
    const ax = x < 0 ? -x : x;
    const ay = y < 0 ? -y : y;
    if (ax === 0 && ay === 0) return x < 0 || Object.is(x, -0) ? (y < 0 || Object.is(y, -0) ? -PI : PI) : y;
    let a = ay <= ax ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
    if (x < 0) a = PI - a;
    return y < 0 || (y === 0 && 1 / y < 0) ? -a : a;
}

export function dasin(x) {
    if (x >= 1) return HALF_PI;
    if (x <= -1) return -HALF_PI;
    return datan2(x, Math.sqrt((1 - x) * (1 + x)));
}

export function dacos(x) {
    if (x >= 1) return 0;
    if (x <= -1) return PI;
    return datan2(Math.sqrt((1 - x) * (1 + x)), x);
}

const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.44269504088896338700e+00;

// 2^k for integer k, by squaring (exact for every representable result).
function pow2(k) {
    let base = k < 0 ? 0.5 : 2;
    let n = k < 0 ? -k : k;
    let r = 1;
    while (n > 0) {
        if (n & 1) r *= base;
        base *= base;
        n = Math.floor(n / 2);
    }
    return r;
}

const EXP_C = (() => {
    const c = [1];
    for (let i = 1; i <= 14; i++) c.push(c[i - 1] / i);
    return c;
})();

export function dexp(x) {
    if (x !== x) return NaN;
    if (x > 709.78) return Infinity;
    if (x < -745.2) return 0;
    const k = Math.floor(x * INV_LN2 + 0.5);
    const r = (x - k * LN2_HI) - k * LN2_LO;
    // |r| <= 0.347: degree-14 Taylor is below 1e-17.
    const p = horner(EXP_C, r);
    // Split the scale so neither factor over/underflows on its own.
    const k1 = Math.floor(k / 2);
    return p * pow2(k1) * pow2(k - k1);
}

const LOG_C = [1, 1 / 3, 1 / 5, 1 / 7, 1 / 9, 1 / 11, 1 / 13, 1 / 15, 1 / 17, 1 / 19, 1 / 21, 1 / 23];

export function dlog(x) {
    if (!(x > 0)) return x === 0 ? -Infinity : NaN;
    if (x === Infinity) return Infinity;
    let e = 0;
    let m = x;
    while (m >= 1.8446744073709552e19) { m *= 5.421010862427522e-20; e += 64; }
    while (m < 5.421010862427522e-20) { m *= 1.8446744073709552e19; e -= 64; }
    while (m >= 1.4142135623730951) { m *= 0.5; e += 1; }
    while (m < 0.7071067811865476) { m *= 2; e -= 1; }
    // log(m) = 2 atanh(z), |z| <= 0.1716
    const z = (m - 1) / (m + 1);
    const s = 2 * z * horner(LOG_C, z * z);
    return e * LN2_HI + (e * LN2_LO + s);
}

export function dpow(x, y) {
    if (y === 0) return 1;
    if (Number.isInteger(y) && Math.abs(y) <= 64) {
        let r = 1, b = y < 0 ? 1 / x : x, n = Math.abs(y);
        while (n > 0) {
            if (n & 1) r *= b;
            b *= b;
            n >>= 1;
        }
        return r;
    }
    if (x === 0) return y > 0 ? 0 : Infinity;
    if (x < 0) return NaN;
    return dexp(y * dlog(x));
}

export function dsqrt(x) {
    return Math.sqrt(x);
}

export function dhypot(x, y) {
    return Math.sqrt(x * x + y * y);
}

/** Length of (x, y, z). Spelled out because `**` is as engine-dependent as Math.pow. */
export function len3(x, y, z) {
    return Math.sqrt(x * x + y * y + z * z);
}

export function sq(x) {
    return x * x;
}

export function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function smoothstep(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
}

export function smootherstep(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * t * (t * (t * 6 - 15) + 10);
}

export function sign(x) {
    return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Wraps an angle to (-pi, pi]. */
export function wrapAngle(a) {
    if (a > -PI && a <= PI) return a;
    a -= TWO_PI * Math.floor((a + PI) / TWO_PI);
    return a <= -PI ? a + TWO_PI : a;
}

/** Moves x toward target by at most step. */
export function approach(x, target, step) {
    if (x < target) return x + step > target ? target : x + step;
    return x - step < target ? target : x - step;
}

// ---------------------------------------------------------------------------
// vec3 helpers: plain arrays [x, y, z]; `out` first, may alias the inputs.

export function vec3(x = 0, y = 0, z = 0) {
    return [x, y, z];
}

export function vset(out, x, y, z) {
    out[0] = x; out[1] = y; out[2] = z;
    return out;
}

export function vcopy(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    return out;
}

export function vadd(out, a, b) {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
    return out;
}

export function vsub(out, a, b) {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
    return out;
}

export function vscale(out, a, s) {
    out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
    return out;
}

/** out = a + b * s */
export function vaddScaled(out, a, b, s) {
    out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s;
    return out;
}

export function vneg(out, a) {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2];
    return out;
}

export function vdot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vcross(out, a, b) {
    const x = a[1] * b[2] - a[2] * b[1];
    const y = a[2] * b[0] - a[0] * b[2];
    const z = a[0] * b[1] - a[1] * b[0];
    out[0] = x; out[1] = y; out[2] = z;
    return out;
}

export function vlen2(a) {
    return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function vlen(a) {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function vdist2(a, b) {
    const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
    return x * x + y * y + z * z;
}

export function vdist(a, b) {
    return Math.sqrt(vdist2(a, b));
}

/** Normalizes a into out; a zero vector stays zero. Returns out. */
export function vnormalize(out, a) {
    const l2 = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    if (l2 > 0) {
        const inv = 1 / Math.sqrt(l2);
        out[0] = a[0] * inv; out[1] = a[1] * inv; out[2] = a[2] * inv;
    } else {
        out[0] = 0; out[1] = 0; out[2] = 0;
    }
    return out;
}

export function vlerp(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
}

/** Removes the component of a along unit vector n. */
export function vreject(out, a, n) {
    const d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
    out[0] = a[0] - n[0] * d; out[1] = a[1] - n[1] * d; out[2] = a[2] - n[2] * d;
    return out;
}

// ---------------------------------------------------------------------------
// Quaternions [x, y, z, w], Hamilton product, rotate(v) = q v q*.
// Car-local axes: forward +Z, up +Y, right -X (right = forward x up).

export function quat(x = 0, y = 0, z = 0, w = 1) {
    return [x, y, z, w];
}

export function qset(out, x, y, z, w) {
    out[0] = x; out[1] = y; out[2] = z; out[3] = w;
    return out;
}

export function qcopy(out, q) {
    out[0] = q[0]; out[1] = q[1]; out[2] = q[2]; out[3] = q[3];
    return out;
}

export function qidentity(out) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return out;
}

export function qmul(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}

export function qconj(out, q) {
    out[0] = -q[0]; out[1] = -q[1]; out[2] = -q[2]; out[3] = q[3];
    return out;
}

export function qnormalize(out, q) {
    const l2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    if (l2 > 0) {
        const inv = 1 / Math.sqrt(l2);
        out[0] = q[0] * inv; out[1] = q[1] * inv; out[2] = q[2] * inv; out[3] = q[3] * inv;
    } else {
        qidentity(out);
    }
    return out;
}

/** Rotates vector v by unit quaternion q. */
export function qrotate(out, q, v) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const vx = v[0], vy = v[1], vz = v[2];
    // t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    out[0] = vx + qw * tx + (qy * tz - qz * ty);
    out[1] = vy + qw * ty + (qz * tx - qx * tz);
    out[2] = vz + qw * tz + (qx * ty - qy * tx);
    return out;
}

/** Rotates v by the inverse of unit quaternion q (world -> local). */
export function qrotateInv(out, q, v) {
    const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
    const vx = v[0], vy = v[1], vz = v[2];
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    out[0] = vx + qw * tx + (qy * tz - qz * ty);
    out[1] = vy + qw * ty + (qz * tx - qx * tz);
    out[2] = vz + qw * tz + (qx * ty - qy * tx);
    return out;
}

const sc = [0, 0];

/** Quaternion for a rotation of `angle` radians about unit `axis`. */
export function qfromAxisAngle(out, axis, angle) {
    dsincos(angle * 0.5, sc);
    out[0] = axis[0] * sc[0]; out[1] = axis[1] * sc[0]; out[2] = axis[2] * sc[0]; out[3] = sc[1];
    return out;
}

/** Rotation about +Y. yaw = 0 faces +Z; yaw = -pi/2 faces -X (heading 1). */
export function qfromYaw(out, yaw) {
    dsincos(yaw * 0.5, sc);
    out[0] = 0; out[1] = sc[0]; out[2] = 0; out[3] = sc[1];
    return out;
}

// Exact quaternions for the four cardinal headings (car forward = local +Z).
const R2 = Math.SQRT1_2;
export const DIR_QUATS = [[0, 0, 0, 1], [0, -R2, 0, R2], [0, 1, 0, 0], [0, R2, 0, R2]];

/** Unit quaternion whose local axes map to the given orthonormal world axes. */
export function qfromBasis(out, right, up, forward) {
    // Columns of the rotation matrix are the images of local X, Y, Z. Local X is -right.
    const m00 = -right[0], m10 = -right[1], m20 = -right[2];
    const m01 = up[0], m11 = up[1], m21 = up[2];
    const m02 = forward[0], m12 = forward[1], m22 = forward[2];
    const tr = m00 + m11 + m22;
    if (tr > 0) {
        const s = 0.5 / Math.sqrt(tr + 1);
        out[3] = 0.25 / s;
        out[0] = (m21 - m12) * s;
        out[1] = (m02 - m20) * s;
        out[2] = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
        const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
        out[3] = (m21 - m12) / s;
        out[0] = 0.25 * s;
        out[1] = (m01 + m10) / s;
        out[2] = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
        out[3] = (m02 - m20) / s;
        out[0] = (m01 + m10) / s;
        out[1] = 0.25 * s;
        out[2] = (m12 + m21) / s;
    } else {
        const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
        out[3] = (m10 - m01) / s;
        out[0] = (m02 + m20) / s;
        out[1] = (m12 + m21) / s;
        out[2] = 0.25 * s;
    }
    return qnormalize(out, out);
}

/**
 * Integrates a world-space angular velocity w (rad/s) over dt:
 * q' = normalize(q + 0.5 * dt * (w, 0) * q).
 */
export function qintegrate(out, q, w, dt) {
    const hx = w[0] * dt * 0.5, hy = w[1] * dt * 0.5, hz = w[2] * dt * 0.5;
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    out[0] = qx + (hx * qw + hy * qz - hz * qy);
    out[1] = qy + (hy * qw + hz * qx - hx * qz);
    out[2] = qz + (hz * qw + hx * qy - hy * qx);
    out[3] = qw + (-hx * qx - hy * qy - hz * qz);
    return qnormalize(out, out);
}

/** Normalized linear interpolation along the shorter arc (render interpolation). */
export function qnlerp(out, a, b, t) {
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = d < 0 ? -1 : 1;
    out[0] = a[0] + (b[0] * s - a[0]) * t;
    out[1] = a[1] + (b[1] * s - a[1]) * t;
    out[2] = a[2] + (b[2] * s - a[2]) * t;
    out[3] = a[3] + (b[3] * s - a[3]) * t;
    return qnormalize(out, out);
}

const AXIS_F = [0, 0, 1], AXIS_U = [0, 1, 0], AXIS_R = [-1, 0, 0];

export function qforward(out, q) {
    return qrotate(out, q, AXIS_F);
}

export function qup(out, q) {
    return qrotate(out, q, AXIS_U);
}

export function qright(out, q) {
    return qrotate(out, q, AXIS_R);
}

/** Heading angle of a horizontal direction: 0 for +Z, -pi/2 for -X (right turn is negative yaw). */
export function yawOf(dx, dz) {
    return datan2(dx, dz);
}
