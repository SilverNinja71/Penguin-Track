// Vehicle physics for the penguin snow racer: a rigid body on four raycast
// wheels (spring-damper suspension) with six collision spheres for the body.
// The tyre model works at the velocity level (a lateral grip budget plus a
// grip-limited yaw-rate controller), which stays stable at 100 Hz and gives the
// assisted, very grippy Trackmania feel. Deterministic: only mathd + IEEE ops.
import { TICK, STEER_MAX, SURFACE_IDS, SURFACE_INDEX } from './constants.js';
import { TWO_PI, DEG, dtan, datan2, clamp, qrotate, qrotateInv, qintegrate } from './mathd.js';

export const GRAVITY = 20;          // m/s², ~2 g: short, snappy jumps
export const MAX_SPEED = 1000 / 3.6;
const KMH = 3.6;

// Geometry and suspension (car-local: forward +Z, up +Y, right -X; origin = centre of mass).
export const CAR = {
    length: 4.2,
    width: 2.0,
    wheelbase: 2.8,
    track: 1.7,
    wheelRadius: 0.38,
    travel: 0.35,               // suspension travel (m)
    spring: 60,                 // per wheel, m/s² per m of compression (mass-normalised)
    springCubic: 720,           // progressive term so compressions (loops, landings) stay inside the travel
    bumpStop: 2000,             // per wheel, beyond the travel: a stiff, frictionless stop (loops at 300 km/h)
    damperBump: 5,              // per wheel, m/s² per m/s
    damperRebound: 4,
    inertia: [1.5, 1.8, 0.75],  // per unit mass about local X (pitch), Y (yaw), Z (roll), m²
    weightTransferHeight: 0.5,  // longitudinal tyre force acts this far below the CoM (squat / dive)
    rollHeight: 0.2,            // lateral tyre force acts this far below the CoM (a little body roll)
    maxSteer: 27 * DEG,         // wheel angle at walking pace (full-lock radius ~6 m)
    steerFadeSpeed: 23,         // m/s; steering angle shrinks as 1 / (1 + (v / this)²)
    steerRate: 14,              // steering slew, in full locks per second (centre to full lock in ~70 ms)
    aeroDrag: 0.00055,          // a = c v² (sets the ~290 km/h plateau)
    rolling: 0.3,               // m/s² rolling resistance on the wheels
    coastDecel: 1.2,            // engine braking with neither gas nor brake
    brakeDecel: 22,             // 200 -> 0 km/h in ~2.5 s on packed snow
    reverseAccel: 9,
    reverseMax: 50 / KMH,
    downforce: 0.002,           // m/s² per (m/s)² pressing a grounded car onto the deck (~12 at 280 km/h)
    airYawRate: 1.6,            // rad/s of yaw from full steer in the air
    airYawResp: 2.5,
    airRight: 3.5,              // self-righting strength in the air (1/s²)
    airDamp: 0.9,               // pitch/roll damping in the air (1/s)
    driftMinSpeed: 70 / KMH,
    driftTapTicks: 15,          // a drift starts when the brake goes down (within this many ticks) while steering
    driftAngle: 14 * DEG,       // target slip angle at a light steer...
    driftAngleMax: 26 * DEG,    // ...and at full lock
    driftBrake: 4,              // deceleration while the brake is held in a drift
    driftGrip: 0.95,            // lateral grip factor while drifting
    turbo: 12,                  // m/s², decaying linearly over turboTime
    turbo2: 24,
    turboTime: 2,
    fragileWall: 11,            // normal impact speed (m/s) that breaks a fragile car
    fragileLanding: 20,         // a kicker gap (~19 m/s into flat ground) survives, a ski jump does not
    tyreHalfWidth: 0.15,        // a wheel still stands on a deck edge until its inner half is past it
    realignMinSpeed: 5,         // m/s: the realignment yaw is bounded below this speed...
    realignFadeSpeed: 3,        // ...and fades out toward a standstill
};

// Engine: forward acceleration (m/s²) versus forward speed (m/s), linearly interpolated.
export const ENGINE_CURVE = [
    [0, 16], [14, 16], [28, 12.4], [42, 9.2], [56, 6.6], [70, 4.9], [83, 3.75], [111, 2.6], [280, 1],
];

/**
 * Handling per surface (index = SURFACE_IDS):
 *   grip     lateral grip per unit of normal load (× g at rest = m/s² budget)
 *   yawGrip  how fast the heading may rotate relative to what grip lets the velocity follow (> 1 slides)
 *   align    how strongly the heading swings back toward the velocity when sliding (1/s)
 *   yawResp  yaw-rate response (1/s)
 *   engine, brake  traction factors; drag  linear drag (1/s); drift  brake-drift allowed
 */
export const SURFACE_PARAMS = [
    { grip: 1.5, yawGrip: 0.96, align: 3, yawResp: 30, engine: 1.0, brake: 1.0, drag: 0, drift: true },        // snow
    { grip: 1.0, yawGrip: 1.4, align: 1.5, yawResp: 18, engine: 0.9, brake: 0.8, drag: 0.02, drift: true },     // powder
    { grip: 0.36, yawGrip: 4.5, align: 0.8, yawResp: 3.5, engine: 0.6, brake: 0.3, drag: 0, drift: false },    // ice
    { grip: 0.6, yawGrip: 1.3, align: 1.5, yawResp: 14, engine: 0.75, brake: 0.7, drag: 0.26, drift: true },    // ground
    { grip: 0.25, yawGrip: 0.5, align: 1, yawResp: 3, engine: 0.3, brake: 0.3, drag: 0.1, drift: false },      // wall
];

export const SLOWMO_SCALES = [1, 0.85, 0.7, 0.55];
export const EFFECT_NAMES = ['turbo', 'turbo2', 'noEngine', 'noSteer', 'noBrake', 'slowmo', 'cruise', 'fragile', 'reset'];

// Wheel mounts (FL, FR, RL, RR) at CoM height; left is +X.
const HT = CAR.track / 2, HB = CAR.wheelbase / 2;
const WHEEL_MOUNTS = [[HT, 0, HB], [-HT, 0, HB], [HT, 0, -HB], [-HT, 0, -HB]];
// The inner edge of each tyre (toward the car's centre line).
const WHEEL_INNER = WHEEL_MOUNTS.map(([x, y, z]) => [x - Math.sign(x) * CAR.tyreHalfWidth, y, z]);
// Body spheres [x, y, z, r]: four corners plus the cabin sides; together ~2.0 × 3.9 m.
// Their undersides sit above the bump stop, so hard compressions stay on the wheels.
const SPHERES = [
    [0.5, 0.25, 1.45, 0.5], [-0.5, 0.25, 1.45, 0.5], [0.5, 0.25, -1.45, 0.5], [-0.5, 0.25, -1.45, 0.5],
    [0.45, 0.35, 0, 0.55], [-0.45, 0.35, 0, 0.55],
];
const RAY_LEN = CAR.travel + CAR.wheelRadius;
const MAX_SUBSTEP_DIST = 0.35;   // m per substep: no tunnelling through 1.5 m decks even at 1000 km/h
const MAX_SUBSTEPS = 10;
const BUMP_SUBSTEP = CAR.travel * 0.85;
const WHEEL_MIN_DOT = 0.45;      // contacts steeper than ~63° to the car floor are walls, not road
const WALL_FRICTION = 0.08;      // walls are slick so glancing hits keep their speed
const BODY_FRICTION = 0.4;       // body scraping on the road / ground
const LAND_MIN_AIR = 8;          // ticks in the air before a touchdown counts as a landing
const WALL = SURFACE_INDEX.wall;

/** Static compression where the four springs carry gravity on flat ground. */
function restCompression() {
    let x = GRAVITY / (4 * CAR.spring);
    for (let i = 0; i < 20; i++) {
        const f = CAR.spring * x + CAR.springCubic * x * x * x - GRAVITY / 4;
        x -= f / (CAR.spring + 3 * CAR.springCubic * x * x);
    }
    return x;
}
export const REST_COMPRESSION = restCompression();
/** Height of the centre of mass above flat ground at rest. */
export const RIDE_HEIGHT = RAY_LEN - REST_COMPRESSION;

export function engineAccel(v) {
    const c = ENGINE_CURVE;
    if (v <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
        if (v <= c[i][0]) {
            const f = (v - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
            return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f;
        }
    }
    return c[c.length - 1][1];
}

/** Maximum front-wheel angle at forward speed v (rad). */
export function steerAngleMax(v) {
    const r = v / CAR.steerFadeSpeed;
    return CAR.maxSteer / (1 + r * r);
}

function makeEffects() {
    return {
        turbo: 0, turboTime: 0, noEngine: false, noSteer: false, noBrake: false,
        slowmo: 0, cruise: false, cruiseSpeed: 0, fragile: false, broken: false,
    };
}

function makeWheel() {
    return { contact: false, surface: null, compression: 0, steer: 0, spin: 0, pos: [0, 0, 0], slip: 0 };
}

const EMIT_NONE = () => {};

export class Car {
    constructor() {
        // Physics state (everything getState captures).
        this.pos = [0, 0, 0];
        this.vel = [0, 0, 0];
        this.quat = [0, 0, 0, 1];
        this.angVel = [0, 0, 0];
        this.steer = 0;                 // smoothed steering, -1..1 (+ = right)
        this.comp = [0, 0, 0, 0];       // suspension compression per wheel (m)
        this.spin = [0, 0, 0, 0];       // wheel rotation angle (cosmetic, rad)
        this.drifting = false;
        this.driftDir = 0;
        this.driftTime = 0;
        this.brakeTicks = 0;            // consecutive ticks with the brake held (drift taps vs trail braking)
        this.airTicks = 0;              // ticks since a wheel last touched (0 = grounded)
        this.wallTicks = 0;             // consecutive ticks touching a wall
        this.bodyTicks = 0;             // consecutive ticks the body rests on something (not a wall)
        this.gasHeld = false;           // effective gas of the last tick (only the rpm view reads it)
        this.effects = makeEffects();

        // Read-only view, refreshed after every step.
        this.speed = 0;
        this.speedKmh = 0;
        this.forwardSpeed = 0;
        this.rpm = 0;
        this.gear = 1;
        this.airborne = false;
        this.surfaceUnder = null;
        this.wheels = [makeWheel(), makeWheel(), makeWheel(), makeWheel()];
        this.slipAngle = 0;

        // Scratch (allocation-free stepping).
        this._fwd = [0, 0, 1]; this._up = [0, 1, 0];
        this._tmp = [0, 0, 0]; this._tmp2 = [0, 0, 0]; this._tmp3 = [0, 0, 0];
        this._mount = [0, 0, 0]; this._down = [0, -1, 0];
        this._hit = { t: 0, point: [0, 0, 0], normal: [0, 1, 0], surface: 0, surfaceId: 'snow', tri: -1, backface: false, u: 0, v: 0 };
        this._wc = [false, false, false, false];          // wheel contact this substep
        this._wn = [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]];
        this._ws = [0, 0, 0, 0];                          // surface index
        this._contacts = [];
        this._corr = [0, 0, 0];
        this._sphere = [0, 0, 0];
        this._N = [0, 1, 0]; this._H = [0, 0, 1]; this._R = [-1, 0, 0];
        this._landing = 0;     // strongest touchdown speed seen this tick
        this._wallHit = 0;     // strongest wall impact this tick
        this._wallPos = [0, 0, 0];
        this._wallN = [0, 0, 0];
        this._wallTouch = false;
        this._bodyTouch = false;
        this._groundSurf = -1;
        this._slip = 0;
    }

    /** Places the car at rest on a spawn { pos (on the deck), quat }. */
    place(pos, quat) {
        this.quat[0] = quat[0]; this.quat[1] = quat[1]; this.quat[2] = quat[2]; this.quat[3] = quat[3];
        qrotate(this._up, this.quat, AXIS_UP);
        for (let k = 0; k < 3; k++) {
            this.pos[k] = pos[k] + this._up[k] * RIDE_HEIGHT;
            this.vel[k] = 0;
            this.angVel[k] = 0;
        }
        this.steer = 0;
        for (let i = 0; i < 4; i++) { this.comp[i] = REST_COMPRESSION; this.spin[i] = 0; }
        this.drifting = false;
        this.driftDir = 0;
        this.driftTime = 0;
        this.brakeTicks = 0;
        this.airTicks = 0;
        this.wallTicks = 0;
        this.bodyTicks = 0;
        this.gasHeld = false;
        this._groundSurf = -1;
        this._slip = 0;
        for (let i = 0; i < 4; i++) { this._wc[i] = false; this._ws[i] = 0; }
        Object.assign(this.effects, makeEffects());
        this.refreshView();
    }

    // -------------------------------------------------------------------
    // Effects

    /** Applies a pad effect; returns true when something changed. emit(type, data) reports it. */
    applyEffect(name, emit = EMIT_NONE) {
        const e = this.effects;
        switch (name) {
            case 'turbo':
            case 'turbo2': {
                // A pad refreshes the boost but never weakens it: a Frost Boost taken during
                // a stronger Avalanche Boost keeps whichever pushes harder right now.
                const level = name === 'turbo2' ? 2 : 1;
                const now = e.turbo === 2 ? CAR.turbo2 : e.turbo === 1 ? CAR.turbo : 0;
                const fresh = level === 2 ? CAR.turbo2 : CAR.turbo;
                if (fresh >= now * (e.turboTime / CAR.turboTime)) {
                    e.turbo = level;
                    e.turboTime = CAR.turboTime;
                }
                emit('boost', { level });
                break;
            }
            case 'noEngine': e.noEngine = true; break;
            case 'noSteer': e.noSteer = true; break;
            case 'noBrake': e.noBrake = true; break;
            case 'slowmo': e.slowmo = Math.min(e.slowmo + 1, SLOWMO_SCALES.length - 1); break;
            case 'cruise':
                // Signed: a car reversing onto the pad keeps reversing at that speed.
                e.cruise = true;
                e.cruiseSpeed = this._forwardSpeedNow() + 0;
                break;
            case 'fragile': e.fragile = true; break;
            case 'reset':
                e.turbo = 0; e.turboTime = 0; e.noEngine = false; e.noSteer = false; e.noBrake = false;
                e.slowmo = 0; e.cruise = false; e.cruiseSpeed = 0; e.fragile = false; e.broken = false;
                break;
            default:
                return false;
        }
        emit('effect', { effect: name });
        return true;
    }

    /** Car-time step length for one tick (slow motion shrinks it). */
    tickDt() {
        return TICK * SLOWMO_SCALES[this.effects.slowmo];
    }

    _forwardSpeedNow() {
        qrotate(this._fwd, this.quat, AXIS_FWD);
        return this.vel[0] * this._fwd[0] + this.vel[1] * this._fwd[1] + this.vel[2] * this._fwd[2];
    }

    // -------------------------------------------------------------------
    // Stepping

    /**
     * Advances one tick. input = { steer, gas, brake }, already normalised (Sim.step
     * does that with clampSteer, the same rule the Recorder uses); collision =
     * CollisionMesh; emit(type, data) receives 'land', 'wallhit', 'fragileBreak'.
     */
    step(input, collision, emit = EMIT_NONE) {
        const e = this.effects;
        const dt = this.tickDt();
        const steerIn = e.noSteer ? 0 : clamp(input.steer / STEER_MAX, -1, 1);
        let gas = !!input.gas, brake = !!input.brake;
        if (e.noBrake) brake = false;
        if (e.cruise) { gas = false; brake = false; }
        const engineOn = !e.noEngine && !e.broken;
        this.brakeTicks = brake ? (this.brakeTicks < 1000 ? this.brakeTicks + 1 : 1000) : 0;

        // Steering slews toward the input (keyboard taps still feel instant, wheels animate).
        const ds = steerIn - this.steer, maxDs = CAR.steerRate * dt;
        this.steer += ds > maxDs ? maxDs : ds < -maxDs ? -maxDs : ds;

        const v = this.vel;
        const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        let n = Math.ceil((speed * dt) / MAX_SUBSTEP_DIST);
        // The bump stop is stiff: give it finer steps while the suspension is near the end.
        const deep = this.comp[0] > BUMP_SUBSTEP || this.comp[1] > BUMP_SUBSTEP || this.comp[2] > BUMP_SUBSTEP || this.comp[3] > BUMP_SUBSTEP;
        if (n < (deep ? 3 : 1)) n = deep ? 3 : 1;
        if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
        const h = dt / n;

        this._landing = 0;
        this._wallHit = 0;
        this._wallTouch = false;
        this._bodyTouch = false;
        const wasAir = this.airTicks;
        let groundedAny = false;
        for (let k = 0; k < n; k++) {
            if (this._substep(h, gas, brake, engineOn, collision, wasAir)) groundedAny = true;
        }

        // Effects and per-tick bookkeeping.
        if (e.turboTime > 0) {
            e.turboTime -= dt;
            if (e.turboTime <= 1e-9) { e.turboTime = 0; e.turbo = 0; }
        }
        this.airTicks = groundedAny ? 0 : this.airTicks + 1;
        this.bodyTicks = this._bodyTouch ? (this.bodyTicks < 1000 ? this.bodyTicks + 1 : 1000) : 0;
        if (this.drifting) this.driftTime += dt;

        if (this._landing > 0) {
            emit('land', { strength: this._landing, airTime: wasAir * TICK });
            if (e.fragile && !e.broken && this._landing > CAR.fragileLanding) this._break(emit, 'landing');
        }
        if (this._wallTouch) {
            if (this._wallHit > 2.5 && (this.wallTicks === 0 || this._wallHit > 6)) {
                emit('wallhit', { intensity: this._wallHit, pos: this._wallPos.slice() });
            }
            if (e.fragile && !e.broken && this._wallHit > CAR.fragileWall) this._break(emit, 'wall');
            this.wallTicks++;
        } else {
            this.wallTicks = 0;
        }
        // Wheel spin follows the road speed (cosmetic, but in the state so views are exact).
        const fs = this._forwardSpeedNow();
        for (let i = 0; i < 4; i++) {
            const a = this.spin[i] + (fs * dt) / CAR.wheelRadius;
            this.spin[i] = a - TWO_PI * Math.floor(a / TWO_PI);
        }
        this.gasHeld = gas;
        this._canonicalize();
        this._refreshView();
    }

    /** Turns -0 into 0 in the state so JSON savestates restore bit-identical runs. */
    _canonicalize() {
        const p = this.pos, v = this.vel, a = this.angVel, q = this.quat, c = this.comp, s = this.spin;
        for (let k = 0; k < 3; k++) { p[k] += 0; v[k] += 0; a[k] += 0; }
        for (let k = 0; k < 4; k++) { q[k] += 0; c[k] += 0; s[k] += 0; }
        this.steer += 0;
        this.driftTime += 0;
        this._slip += 0;
        this.effects.turboTime += 0;
        this.effects.cruiseSpeed += 0;
    }

    _break(emit, cause) {
        this.effects.broken = true;
        emit('fragileBreak', { cause });
    }

    /** One integration substep; returns true when any wheel touched. */
    _substep(h, gas, brake, engineOn, collision, wasAir) {
        const pos = this.pos, vel = this.vel, w = this.angVel, q = this.quat;
        const fwd = qrotate(this._fwd, q, AXIS_FWD);
        const up = qrotate(this._up, q, AXIS_UP);
        const e = this.effects;

        // --- Wheels: raycast suspension -------------------------------------
        const down = this._down;
        down[0] = -up[0]; down[1] = -up[1]; down[2] = -up[2];
        let contacts = 0, load = 0;
        let nx = 0, ny = 0, nz = 0;
        let ax = 0, ay = -GRAVITY, az = 0;     // linear acceleration
        let tx = 0, ty = 0, tz = 0;            // torque (world, per unit mass)
        const mount = this._mount, hit = this._hit, rv = this._tmp;
        let gripSum = 0, yawGripSum = 0, alignSum = 0, yawRespSum = 0, engSum = 0, brkSum = 0, dragSum = 0, driftOk = 0;
        let bestLoad = -1, bestSurf = -1;
        for (let i = 0; i < 4; i++) {
            qrotate(rv, q, WHEEL_MOUNTS[i]);
            mount[0] = pos[0] + rv[0]; mount[1] = pos[1] + rv[1]; mount[2] = pos[2] + rv[2];
            let hr = collision.raycast(mount, down, RAY_LEN, hit);
            let nDot = hr ? hit.normal[0] * up[0] + hit.normal[1] * up[1] + hit.normal[2] * up[2] : 0;
            // No wheel contact with steep faces, or with steep snowbanks / pillars even when the
            // car lies against them: the body spheres handle those, so nobody drives up a wall.
            let road = hr && !hit.backface && nDot >= WHEEL_MIN_DOT && !(hit.surface === WALL && hit.normal[1] < 0.7);
            if (!road && (hr || this._wc[i])) {
                // The tyre has width: with its centre just past a deck edge (onto the snowbank's
                // foot, or off an open side) its inner half still stands on the road. Without
                // this the corner drops, comes back, drops: endless rocking against a snowbank.
                const inner = this._tmp3;
                qrotate(inner, q, WHEEL_INNER[i]);
                inner[0] += pos[0]; inner[1] += pos[1]; inner[2] += pos[2];
                hr = collision.raycast(inner, down, RAY_LEN, hit);
                nDot = hr ? hit.normal[0] * up[0] + hit.normal[1] * up[1] + hit.normal[2] * up[2] : 0;
                road = hr && !hit.backface && nDot >= WHEEL_MIN_DOT && !(hit.surface === WALL && hit.normal[1] < 0.7);
            }
            if (!road) {
                this._wc[i] = false;
                this.comp[i] = 0;
                continue;
            }
            const x = RAY_LEN - hit.t;
            // Compression rate: mount velocity toward the (static) ground along the
            // suspension axis. Measured against the hit normal so a fast car with a
            // slightly pitched body does not read its forward speed as compression.
            const pvx = vel[0] + (w[1] * rv[2] - w[2] * rv[1]);
            const pvy = vel[1] + (w[2] * rv[0] - w[0] * rv[2]);
            const pvz = vel[2] + (w[0] * rv[1] - w[1] * rv[0]);
            const xdot = -(pvx * hit.normal[0] + pvy * hit.normal[1] + pvz * hit.normal[2]) / nDot;
            let f = CAR.spring * x + CAR.springCubic * x * x * x + (xdot > 0 ? CAR.damperBump : CAR.damperRebound) * xdot;
            if (x > CAR.travel) f += CAR.bumpStop * (x - CAR.travel) + 4 * CAR.damperBump * (xdot > 0 ? xdot : 0);
            if (f < 0) f = 0;
            this.comp[i] = x;
            this._wc[i] = true;
            const wn = this._wn[i];
            wn[0] = hit.normal[0]; wn[1] = hit.normal[1]; wn[2] = hit.normal[2];
            this._ws[i] = hit.surface;
            contacts++;
            load += f;
            // Weight the ground normal by load, but never let an unloaded wheel vanish entirely.
            const wgt = f + 0.5;
            nx += wn[0] * wgt; ny += wn[1] * wgt; nz += wn[2] * wgt;
            ax += up[0] * f; ay += up[1] * f; az += up[2] * f;
            tx += rv[1] * up[2] * f - rv[2] * up[1] * f;
            ty += rv[2] * up[0] * f - rv[0] * up[2] * f;
            tz += rv[0] * up[1] * f - rv[1] * up[0] * f;
            const sp = SURFACE_PARAMS[hit.surface];
            gripSum += sp.grip * wgt; yawGripSum += sp.yawGrip * wgt; alignSum += sp.align * wgt; yawRespSum += sp.yawResp * wgt;
            engSum += sp.engine * wgt; brkSum += sp.brake * wgt; dragSum += sp.drag * wgt;
            if (sp.drift) driftOk += wgt;
            if (wgt > bestLoad) { bestLoad = wgt; bestSurf = hit.surface; }
        }
        const grounded = contacts > 0;
        this._groundSurf = bestSurf;

        // --- Ground frame and tyre forces ----------------------------------
        let aLong = 0;
        const N = this._N, H = this._H, R = this._R;
        let G = 0, yawGrip = 1, align = 0, yawResp = 0, drag = 0, wsum = 1;
        if (grounded) {
            let l = Math.sqrt(nx * nx + ny * ny + nz * nz);
            N[0] = nx / l; N[1] = ny / l; N[2] = nz / l;
            const fd = fwd[0] * N[0] + fwd[1] * N[1] + fwd[2] * N[2];
            H[0] = fwd[0] - N[0] * fd; H[1] = fwd[1] - N[1] * fd; H[2] = fwd[2] - N[2] * fd;
            l = Math.sqrt(H[0] * H[0] + H[1] * H[1] + H[2] * H[2]);
            if (l < 1e-6) { H[0] = fwd[0]; H[1] = fwd[1]; H[2] = fwd[2]; l = 1; }
            H[0] /= l; H[1] /= l; H[2] /= l;
            // R = H x N (right-hand side in the deck plane)
            R[0] = H[1] * N[2] - H[2] * N[1];
            R[1] = H[2] * N[0] - H[0] * N[2];
            R[2] = H[0] * N[1] - H[1] * N[0];
            wsum = load + 0.5 * contacts;
            const gripK = gripSum / wsum;
            yawGrip = yawGripSum / wsum;
            align = alignSum / wsum;
            yawResp = yawRespSum / wsum;
            drag = dragSum / wsum;
            const engK = engSum / wsum, brkK = brkSum / wsum;
            const vf = vel[0] * H[0] + vel[1] * H[1] + vel[2] * H[2];
            // Fewer wheels down -> less drive (and less downforce).
            const traction = contacts >= 2 ? 1 : 0.5;
            // Downforce (TM style, grounded only) presses the car onto the deck, so fast
            // lines over crests and banked turns stay loaded. It reaches the grip through
            // the suspension: the grip budget is proportional to the springs' load.
            const sp2 = vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2];
            const down = CAR.downforce * sp2 * traction;
            ax -= N[0] * down; ay -= N[1] * down; az -= N[2] * down;
            G = gripK * load;

            // Drift state machine: tapping the brake while steering at speed on packed snow,
            // powder or deep snow. Holding the brake into a corner is plain trail braking.
            const steer = this.steer;
            const canDrift = driftOk * 2 > wsum;
            if (!this.drifting) {
                if (brake && this.brakeTicks <= CAR.driftTapTicks && canDrift && vf > CAR.driftMinSpeed
                    && (steer > 0.35 || steer < -0.35) && !e.cruise) {
                    this.drifting = true;
                    this.driftDir = steer > 0 ? 1 : -1;
                    this.driftTime = 0;
                }
            } else {
                const vl = vel[0] * R[0] + vel[1] * R[1] + vel[2] * R[2];
                const slip = -datan2(vl, vf > 0.1 ? vf : 0.1) * this.driftDir;   // > 0 = nose inside the turn
                const steering = steer * this.driftDir > 0.15;
                const settled = this.driftTime > 0.3 && slip < 3 * DEG;
                if ((!brake && !steering) || settled || vf < 0.7 * CAR.driftMinSpeed || !canDrift) {
                    this.drifting = false;
                    this.driftDir = 0;
                }
            }

            // Longitudinal: engine, brakes, reverse, coasting, cruise, turbo.
            if (e.cruise) {
                aLong = clamp((e.cruiseSpeed - vf) * 8, -25, 25);
            } else if (brake && vf > 1) {
                aLong = this.drifting ? -CAR.driftBrake : -CAR.brakeDecel * brkK;
            } else if (brake && !gas) {
                // Holding brake at a standstill reverses.
                if (engineOn && vf > -CAR.reverseMax) aLong = -CAR.reverseAccel * engK * (1 - (-vf > 0 ? -vf : 0) / CAR.reverseMax);
            } else if (gas && vf < -0.5) {
                aLong = CAR.brakeDecel * brkK;
            } else if (gas && engineOn) {
                aLong = engineAccel(vf) * engK;
            } else {
                const c = CAR.coastDecel * h;
                aLong = vf > c ? -CAR.coastDecel : vf < -c ? CAR.coastDecel : -vf / h;
            }
            if (e.turbo > 0) aLong += (e.turbo === 2 ? CAR.turbo2 : CAR.turbo) * (e.turboTime / CAR.turboTime);
            // Rolling resistance, faded near zero so a parked car does not jitter.
            const rr = CAR.rolling * clamp(vf * 2, -1, 1);
            aLong = aLong * traction - rr;
            ax += H[0] * aLong; ay += H[1] * aLong; az += H[2] * aLong;
            // Weight transfer: the drive force acts below the CoM (nose lifts under power).
            const wt = aLong * CAR.weightTransferHeight;
            tx += R[0] * wt; ty += R[1] * wt; tz += R[2] * wt;
        }

        // --- Integrate forces ---------------------------------------------------
        vel[0] += ax * h; vel[1] += ay * h; vel[2] += az * h;
        this._addTorque(tx * h, ty * h, tz * h);

        if (grounded) {
            this._tyres(h, G, yawGrip, align, yawResp, contacts, aLong);
            // Linear drag of deep snow / powder, in the deck plane.
            if (drag > 0) {
                const k = 1 - drag * h;
                const vn = vel[0] * N[0] + vel[1] * N[1] + vel[2] * N[2];
                vel[0] = (vel[0] - N[0] * vn) * k + N[0] * vn;
                vel[1] = (vel[1] - N[1] * vn) * k + N[1] * vn;
                vel[2] = (vel[2] - N[2] * vn) * k + N[2] * vn;
            }
            // Touchdown after a flight.
            if (wasAir >= LAND_MIN_AIR && this.airTicks > 0) this._touchdown(N, H);
        } else {
            if (this.drifting && wasAir > 25) { this.drifting = false; this.driftDir = 0; }
            // A car lying on its roof or balanced on its belly is not flying: no air steering
            // or self-righting, which would only make it creep and spin in place.
            if (this.bodyTicks === 0) this._airControl(h, wasAir);
        }

        // Aerodynamic drag.
        const sp2 = vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2];
        const spd = Math.sqrt(sp2);
        const dk = 1 - CAR.aeroDrag * spd * h;
        vel[0] *= dk; vel[1] *= dk; vel[2] *= dk;

        pos[0] += vel[0] * h; pos[1] += vel[1] * h; pos[2] += vel[2] * h;
        qintegrate(q, q, w, h);

        this._collideBody(collision);

        // Hard speed cap.
        const s2 = vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2];
        if (s2 > MAX_SPEED * MAX_SPEED) {
            const k = MAX_SPEED / Math.sqrt(s2);
            vel[0] *= k; vel[1] *= k; vel[2] *= k;
        }
        if (grounded) this.airTicks = 0;
        return grounded;
    }

    /** World torque impulse (per unit mass) -> angular velocity change through the inertia. */
    _addTorque(tx, ty, tz) {
        const t = this._tmp2;
        t[0] = tx; t[1] = ty; t[2] = tz;
        qrotateInv(t, this.quat, t);
        t[0] /= CAR.inertia[0]; t[1] /= CAR.inertia[1]; t[2] /= CAR.inertia[2];
        qrotate(t, this.quat, t);
        this.angVel[0] += t[0]; this.angVel[1] += t[1]; this.angVel[2] += t[2];
    }

    /**
     * Lateral grip and yaw at the velocity level. G is the lateral acceleration
     * budget (m/s²). The heading may rotate only about as fast as grip lets the
     * velocity follow (× yawGrip) and swings back toward the velocity when the
     * car slides (align), so packed snow grips, powder drifts and ice slides.
     */
    _tyres(h, G, yawGrip, align, yawResp, contacts, aLong) {
        const vel = this.vel, w = this.angVel, N = this._N, H = this._H, R = this._R;
        const vf = vel[0] * H[0] + vel[1] * H[1] + vel[2] * H[2];
        const vl = vel[0] * R[0] + vel[1] * R[1] + vel[2] * R[2];
        const afv = vf < 0 ? -vf : vf;
        const vPlane = Math.sqrt(vf * vf + vl * vl);
        const contactW = contacts >= 3 ? 1 : contacts * 0.33;
        const vRef = afv > 1 ? afv : 1;

        // Yaw-rate target: bicycle model, limited by grip, plus realignment.
        const delta = this.steer * steerAngleMax(afv);
        let target = (vf * dtan(delta)) / CAR.wheelbase;
        const cap = (G * yawGrip) / vRef;
        if (target > cap) target = cap; else if (target < -cap) target = -cap;
        // Realignment swings the nose toward the velocity: align · sin(slip), measured
        // against the total speed (not the forward speed, which is ~0 in a sideways
        // slide), bounded at low speed and faded out near a standstill, so a parked
        // car never yaws itself downhill or off a snowbank.
        const vMin = CAR.realignMinSpeed, vFade = CAR.realignFadeSpeed;
        target += ((align * vl) / (vPlane > vMin ? vPlane : vMin)) * (vPlane < vFade ? vPlane / vFade : 1);

        let latG = G;
        if (this.drifting) {
            // Hold a slip angle set by the steering; the heading leads the velocity into the turn.
            const d = this.driftDir;
            const slip = -datan2(vl, vf > 0.1 ? vf : 0.1) * d;
            const s = this.steer * d;   // > 0 steering into the drift
            const want = s > 0 ? CAR.driftAngle + (CAR.driftAngleMax - CAR.driftAngle) * s : CAR.driftAngle * (1 + s * 2);
            latG = G * CAR.driftGrip;
            const velTurn = latG / vRef;   // how fast the velocity direction can follow
            target = d * (velTurn + 4 * (want - slip));
            this._slip = slip;
        } else {
            this._slip = -datan2(vl, vf > 0.5 ? vf : 0.5) * (this.steer >= 0 ? 1 : -1);
        }

        const wr = -(w[0] * N[0] + w[1] * N[1] + w[2] * N[2]);   // + = turning right
        let k = yawResp * h * contactW;
        if (k > 1) k = 1;
        const dwr = (target - wr) * k;
        w[0] -= N[0] * dwr; w[1] -= N[1] * dwr; w[2] -= N[2] * dwr;

        // Lateral grip: cancel sideways sliding within the budget. While sliding, the
        // drive force along the heading also turns the velocity (by aLong · sin slip);
        // that share comes out of the same budget, so a power slide on ice cannot
        // corner harder than the grip allows.
        let budget = latG;
        if (aLong > 0 && vf > 0.5 && vPlane > 0) {
            const sinB = (vl < 0 ? -vl : vl) / vPlane, cosB = vf / vPlane;
            budget = (latG - aLong * sinB) / cosB;
            if (budget < 0) budget = 0; else if (budget > latG) budget = latG;
        }
        const maxDv = budget * h * contactW;
        let dv = -vl;
        if (dv > maxDv) dv = maxDv; else if (dv < -maxDv) dv = -maxDv;
        vel[0] += R[0] * dv; vel[1] += R[1] * dv; vel[2] += R[2] * dv;
        // The grip force acts below the CoM: a touch of body roll.
        const rt = dv * CAR.rollHeight;
        this._addTorque(H[0] * -rt, H[1] * -rt, H[2] * -rt);
    }

    /** Minimal air control: a little yaw from the steering, gentle self-righting. */
    _airControl(h, wasAir) {
        const w = this.angVel, vel = this.vel, up = this._up;
        // Yaw about world up.
        const target = -this.steer * CAR.airYawRate;
        let k = CAR.airYawResp * h;
        if (k > 1) k = 1;
        w[1] += (target - w[1]) * k;
        // Ease in so short hops (loops, crests) are not disturbed.
        const ease = clamp((wasAir - 10) / 30, 0, 1);
        if (ease <= 0) return;
        // Target up: perpendicular to the flight path (nose follows the arc), level otherwise.
        const sp = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
        const T = this._tmp3;
        T[0] = 0; T[1] = 1; T[2] = 0;
        if (sp > 5) {
            const ix = vel[0] / sp, iy = vel[1] / sp, iz = vel[2] / sp;
            // Follow the flight path only partially: a nose-down dive would land nose first.
            T[0] = -ix * iy * 0.6; T[1] = 1 - iy * iy * 0.6; T[2] = -iz * iy * 0.6;
            const l = Math.sqrt(T[0] * T[0] + T[1] * T[1] + T[2] * T[2]);
            T[0] /= l; T[1] /= l; T[2] /= l;
        }
        // axis = up x T rotates up toward T.
        const cx = up[1] * T[2] - up[2] * T[1];
        const cy = up[2] * T[0] - up[0] * T[2];
        const cz = up[0] * T[1] - up[1] * T[0];
        const s = CAR.airRight * ease * h;
        w[0] += cx * s; w[1] += cy * s; w[2] += cz * s;
        // Damp pitch and roll (not yaw).
        let d = CAR.airDamp * ease * h;
        if (d > 1) d = 1;
        const wy = w[1];
        w[0] -= w[0] * d; w[2] -= w[2] * d;
        w[1] = wy;
    }

    /** First wheel contact after a flight: landing strength and nose-first speed loss. */
    _touchdown(N, H) {
        const vel = this.vel, fwd = this._fwd;
        const vn = -(vel[0] * N[0] + vel[1] * N[1] + vel[2] * N[2]);
        if (vn > this._landing) this._landing = vn;
        if (vn < 4) return;
        // Pitch mismatch between the car and the surface it lands on.
        const mis = Math.abs(fwd[0] * N[0] + fwd[1] * N[1] + fwd[2] * N[2]);
        if (mis <= 0.15) return;
        const loss = clamp((mis - 0.15) * 1.2, 0, 0.5) * clamp(vn / 15, 0, 1);
        const vf = vel[0] * H[0] + vel[1] * H[1] + vel[2] * H[2];
        vel[0] -= H[0] * vf * loss; vel[1] -= H[1] * vf * loss; vel[2] -= H[2] * vf * loss;
    }

    /** Body spheres against the mesh: push out, then impulses with low wall friction. */
    _collideBody(collision) {
        const pos = this.pos, q = this.quat;
        const corr = this._corr;
        corr[0] = 0; corr[1] = 0; corr[2] = 0;
        const c = this._sphere, rv = this._tmp, list = this._contacts, push = this._tmp3;
        for (let s = 0; s < SPHERES.length; s++) {
            const sph = SPHERES[s];
            qrotate(rv, q, sph);
            // Query where earlier spheres already moved the car this substep.
            c[0] = pos[0] + rv[0] + corr[0]; c[1] = pos[1] + rv[1] + corr[1]; c[2] = pos[2] + rv[2] + corr[2];
            const cnt = collision.querySphere(c, sph[3], list);
            if (cnt === 0) continue;
            push[0] = 0; push[1] = 0; push[2] = 0;
            for (let j = 0; j < cnt; j++) {
                const ct = list[j], n = ct.normal;
                // Only the depth not already removed by this sphere's earlier contacts.
                const need = ct.depth - (push[0] * n[0] + push[1] * n[1] + push[2] * n[2]);
                if (need > 0) { push[0] += n[0] * need; push[1] += n[1] * need; push[2] += n[2] * need; }
            }
            corr[0] += push[0]; corr[1] += push[1]; corr[2] += push[2];
            for (let j = 0; j < cnt; j++) {
                if (list[j].surface !== WALL) this._bodyTouch = true;
                this._impulse(list[j]);
            }
        }
        pos[0] += corr[0]; pos[1] += corr[1]; pos[2] += corr[2];
    }

    /** Velocity impulse for one body contact. */
    _impulse(ct) {
        const vel = this.vel, w = this.angVel;
        let n = ct.normal;
        const isWall = ct.surface === WALL || (n[1] < 0.6 && n[1] > -0.6);
        if (ct.surface === WALL) {
            // Snowbanks lean outward and pillars have edges: push the car only within its
            // own floor plane, so a hit never launches it up and onto the bank.
            const up = this._up, d = n[0] * up[0] + n[1] * up[1] + n[2] * up[2];
            const px = n[0] - up[0] * d, py = n[1] - up[1] * d, pz = n[2] - up[2] * d;
            const l = Math.sqrt(px * px + py * py + pz * pz);
            if (l > 0.3) {
                n = this._wallN;
                n[0] = px / l; n[1] = py / l; n[2] = pz / l;
            }
        }
        // Contact point relative to the CoM.
        const rx = ct.point[0] - this.pos[0], ry = ct.point[1] - this.pos[1], rz = ct.point[2] - this.pos[2];
        const pvx = vel[0] + (w[1] * rz - w[2] * ry);
        const pvy = vel[1] + (w[2] * rx - w[0] * rz);
        const pvz = vel[2] + (w[0] * ry - w[1] * rx);
        const vn = pvx * n[0] + pvy * n[1] + pvz * n[2];
        if (vn >= 0) return;
        if (isWall) {
            this._wallTouch = true;
            if (-vn > this._wallHit) {
                this._wallHit = -vn;
                this._wallPos[0] = ct.point[0]; this._wallPos[1] = ct.point[1]; this._wallPos[2] = ct.point[2];
            }
        } else if (-vn > 2 && -vn > this._landing && this.airTicks >= LAND_MIN_AIR) {
            // Body touchdown (nose first, roof): only real impacts, not a car resting on its side.
            this._landing = -vn;
        }
        const restitution = -vn > 3 ? 0.1 : 0;
        const k = this._effMass(rx, ry, rz, n);
        const j = (-(1 + restitution) * vn) / k;
        // Tangential friction.
        let tvx = pvx - n[0] * vn, tvy = pvy - n[1] * vn, tvz = pvz - n[2] * vn;
        const tl = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
        let jt = 0;
        if (tl > 1e-6) {
            tvx /= tl; tvy /= tl; tvz /= tl;
            const t = this._tmp3;
            t[0] = tvx; t[1] = tvy; t[2] = tvz;
            const kt = this._effMass(rx, ry, rz, t);
            const mu = isWall ? WALL_FRICTION : BODY_FRICTION;
            jt = Math.min(mu * j, tl / kt);
        }
        const ix = n[0] * j - tvx * jt, iy = n[1] * j - tvy * jt, iz = n[2] * j - tvz * jt;
        vel[0] += ix; vel[1] += iy; vel[2] += iz;
        // Angular part, softened: walls should redirect the car, not spin it.
        this._addTorque((ry * iz - rz * iy) * 0.5, (rz * ix - rx * iz) * 0.5, (rx * iy - ry * ix) * 0.5);
    }

    /** 1 / m + n · ((I⁻¹ (r × n)) × r) with m = 1 and the softened angular term. */
    _effMass(rx, ry, rz, n) {
        const t = this._tmp2;
        t[0] = ry * n[2] - rz * n[1]; t[1] = rz * n[0] - rx * n[2]; t[2] = rx * n[1] - ry * n[0];
        qrotateInv(t, this.quat, t);
        t[0] /= CAR.inertia[0]; t[1] /= CAR.inertia[1]; t[2] /= CAR.inertia[2];
        qrotate(t, this.quat, t);
        const cx = t[1] * rz - t[2] * ry, cy = t[2] * rx - t[0] * rz, cz = t[0] * ry - t[1] * rx;
        return 1 + 0.5 * (cx * n[0] + cy * n[1] + cz * n[2]);
    }

    // -------------------------------------------------------------------
    // View

    _refreshView() {
        const gas = this.gasHeld;
        const q = this.quat, v = this.vel;
        const fwd = qrotate(this._fwd, q, AXIS_FWD);
        const up = qrotate(this._up, q, AXIS_UP);
        const sp = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        this.speed = sp;
        this.speedKmh = sp * KMH;
        this.forwardSpeed = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
        this.airborne = this.airTicks > 0;
        this.surfaceUnder = this.airborne || this._groundSurf < 0 ? null : SURFACE_IDS[this._groundSurf];
        // Synthetic gearbox for audio.
        const kmh = (this.forwardSpeed < 0 ? -this.forwardSpeed : this.forwardSpeed) * KMH;
        let g = 1;
        while (g < GEARS.length && kmh >= GEARS[g]) g++;
        const lo = GEARS[g - 1], hi = g < GEARS.length ? GEARS[g] : 340;
        let rpm = 0.25 + 0.75 * clamp((kmh - lo) / (hi - lo), 0, 1);
        if (this.airborne && gas) rpm = 0.95;
        else if (gas && kmh < 5) rpm = 0.45;
        this.gear = g;
        this.rpm = rpm;
        this.slipAngle = this._slip;
        const steerAngle = this.steer * steerAngleMax(this.forwardSpeed < 0 ? -this.forwardSpeed : this.forwardSpeed);
        const rv = this._tmp;
        for (let i = 0; i < 4; i++) {
            const wh = this.wheels[i];
            wh.contact = this.airTicks === 0 && this._wc[i];
            wh.surface = wh.contact ? SURFACE_IDS[this._ws[i]] : null;
            const x = wh.contact ? this.comp[i] : 0;
            wh.compression = x;
            wh.steer = i < 2 ? steerAngle : 0;
            wh.spin = this.spin[i];
            qrotate(rv, q, WHEEL_MOUNTS[i]);
            const drop = CAR.travel - x;
            wh.pos[0] = this.pos[0] + rv[0] - up[0] * drop;
            wh.pos[1] = this.pos[1] + rv[1] - up[1] * drop;
            wh.pos[2] = this.pos[2] + rv[2] - up[2] * drop;
            const latSlip = wh.contact ? Math.abs(this._slip) / (20 * DEG) + (this.drifting ? 0.4 : 0) : 0;
            wh.slip = clamp(latSlip, 0, 1);
        }
    }

    /** Re-derives the read-only view (after place or setState). */
    refreshView() {
        this._refreshView();
    }

    // -------------------------------------------------------------------
    // State

    getState() {
        return carStateFrom({
            pos: this.pos, vel: this.vel, quat: this.quat, angVel: this.angVel, steer: this.steer,
            comp: this.comp, spin: this.spin, drifting: this.drifting, driftDir: this.driftDir,
            driftTime: this.driftTime, brakeTicks: this.brakeTicks, airTicks: this.airTicks,
            wallTicks: this.wallTicks, bodyTicks: this.bodyTicks, groundSurf: this._groundSurf,
            wc: this._wc, ws: this._ws, slip: this._slip, gas: this.gasHeld, effects: this.effects,
        });
    }

    setState(s) {
        for (let k = 0; k < 3; k++) {
            this.pos[k] = s.pos[k]; this.vel[k] = s.vel[k]; this.angVel[k] = s.angVel[k];
        }
        for (let k = 0; k < 4; k++) {
            this.quat[k] = s.quat[k];
            this.comp[k] = s.comp[k];
            this.spin[k] = s.spin[k];
            this._wc[k] = !!s.wc[k];
            this._ws[k] = s.ws[k];
        }
        this.steer = s.steer;
        this.drifting = !!s.drifting;
        this.driftDir = s.driftDir;
        this.driftTime = s.driftTime;
        this.brakeTicks = s.brakeTicks;
        this.airTicks = s.airTicks;
        this.wallTicks = s.wallTicks;
        this.bodyTicks = s.bodyTicks;
        this._groundSurf = s.groundSurf;
        this._slip = s.slip;
        this.gasHeld = !!s.gas;
        const e = this.effects, se = s.effects;
        e.turbo = se.turbo; e.turboTime = se.turboTime; e.noEngine = !!se.noEngine; e.noSteer = !!se.noSteer;
        e.noBrake = !!se.noBrake; e.slowmo = se.slowmo; e.cruise = !!se.cruise; e.cruiseSpeed = se.cruiseSpeed;
        e.fragile = !!se.fragile; e.broken = !!se.broken;
        this.refreshView();
    }
}

/**
 * The canonical car state: a fresh object with exactly the fields Car.getState
 * writes, in a fixed order, -0 normalised and unknown keys dropped. Car.getState
 * and the sim's checkpoint snapshot both go through it, so a state that passed
 * through any serializer (sorted keys, extra fields) restores to the same hash.
 */
export function carStateFrom(s) {
    const e = s.effects;
    return {
        pos: [s.pos[0] + 0, s.pos[1] + 0, s.pos[2] + 0],
        vel: [s.vel[0] + 0, s.vel[1] + 0, s.vel[2] + 0],
        quat: [s.quat[0] + 0, s.quat[1] + 0, s.quat[2] + 0, s.quat[3] + 0],
        angVel: [s.angVel[0] + 0, s.angVel[1] + 0, s.angVel[2] + 0],
        steer: s.steer + 0,
        comp: [s.comp[0] + 0, s.comp[1] + 0, s.comp[2] + 0, s.comp[3] + 0],
        spin: [s.spin[0] + 0, s.spin[1] + 0, s.spin[2] + 0, s.spin[3] + 0],
        drifting: !!s.drifting,
        driftDir: s.driftDir + 0,
        driftTime: s.driftTime + 0,
        brakeTicks: s.brakeTicks + 0,
        airTicks: s.airTicks + 0,
        wallTicks: s.wallTicks + 0,
        bodyTicks: s.bodyTicks + 0,
        groundSurf: s.groundSurf + 0,
        gas: !!s.gas,
        wc: [!!s.wc[0], !!s.wc[1], !!s.wc[2], !!s.wc[3]],
        ws: [s.ws[0] + 0, s.ws[1] + 0, s.ws[2] + 0, s.ws[3] + 0],
        slip: s.slip + 0,
        effects: {
            turbo: e.turbo + 0, turboTime: e.turboTime + 0, noEngine: !!e.noEngine, noSteer: !!e.noSteer,
            noBrake: !!e.noBrake, slowmo: e.slowmo + 0, cruise: !!e.cruise, cruiseSpeed: e.cruiseSpeed + 0,
            fragile: !!e.fragile, broken: !!e.broken,
        },
    };
}

const AXIS_FWD = [0, 0, 1], AXIS_UP = [0, 1, 0];
const GEARS = [0, 45, 90, 140, 190, 245];   // km/h where each synthetic gear starts

export { WHEEL_MOUNTS, SPHERES };
