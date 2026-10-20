// Quick TAS (Race & Rewind): savestate markers over a live race. The player
// drives normally while a Recorder keeps every tick's input; a marker is an
// exact Sim savestate (car position, velocity, spin, wheels, effects, race
// progress) plus the inputs that led to it, so rewinding to one and driving on
// gives a replay that re-simulates to exactly what was seen.
//
// Markers always form one chain from the Start marker: rewinding to marker k
// keeps the later ones (cycle forward to get them back, their inputs come with
// them), and placing a new marker after k overwrites them, since they belong
// to the attempt that was just abandoned. Each marker keeps only the inputs
// since the previous one, so long runs with many markers stay small.
// DOM-free: race.js drives it and tools/tests/quick-tas.test.mjs checks it.

/** Most markers a run keeps (the Start marker included); the oldest others merge away. */
export const MAX_MARKERS = 100;

export class QuickTas {
    /**
     * sim: the race's Sim; recorder: its Recorder. Inputs must be pushed to the
     * recorder once per simulated tick while racing (recorder.length === sim.tick).
     */
    constructor(sim, recorder) {
        this.sim = sim;
        this.recorder = recorder;
        this.markers = [];
        this.current = -1;
        this.rewinds = 0;
        this.placed = 0;
        this._nextId = 1;
    }

    /** Starts a fresh run: just the Start marker, at the sim's current (start-line) state. */
    begin() {
        this.markers.length = 0;
        this.current = -1;
        this.rewinds = 0;
        this.placed = 0;
        this.markers.push(this._snap(null, 'Start'));
        this.current = 0;
    }

    /** True once any marker was placed or any rewind happened: the run is a TAS run. */
    get used() {
        return this.placed > 0 || this.rewinds > 0;
    }

    /** The marker R rewinds to (the newest placed, or the last one cycled to). */
    get marker() {
        return this.markers[this.current] || null;
    }

    /**
     * Drops a marker at the current tick. Markers after the current one (from an
     * abandoned attempt) are overwritten. Returns the new marker, or null when
     * the run is finished or a marker already sits on this tick.
     */
    mark() {
        const sim = this.sim;
        const cur = this.marker;
        if (!cur || sim.finished || sim.tick <= cur.tick) return null;
        this.markers.length = this.current + 1;
        const m = this._snap(cur, null);
        this.markers.push(m);
        this.current = this.markers.length - 1;
        this.placed++;
        if (this.markers.length > MAX_MARKERS) this._dropOldest();
        return m;
    }

    /** Back to the current marker (R / Backspace). Returns it, or null before begin(). */
    rewind() {
        if (this.current < 0) return null;
        return this._restore(this.current);
    }

    /**
     * Steps to the previous (dir -1) or next (dir 1) marker and rewinds there
     * ([ and ]). At either end it rewinds to the end marker.
     */
    cycle(dir) {
        if (this.current < 0) return null;
        const i = Math.max(0, Math.min(this.markers.length - 1, this.current + (dir < 0 ? -1 : 1)));
        return this._restore(i);
    }

    /** Index in `markers` of the given marker id, or -1. */
    indexOf(id) {
        for (let i = 0; i < this.markers.length; i++) if (this.markers[i].id === id) return i;
        return -1;
    }

    /** Inputs from the start line up to marker i (a fresh array). */
    inputsTo(i) {
        const out = [];
        for (let k = 1; k <= i; k++) {
            const seg = this.markers[k].seg;
            for (let j = 0; j < seg.length; j++) out.push(seg[j]);
        }
        return out;
    }

    _snap(parent, label) {
        const sim = this.sim, inputs = this.recorder.inputs;
        if (inputs.length !== sim.tick) {
            throw new Error(`Quick TAS: the recording holds ${inputs.length} inputs at tick ${sim.tick}`);
        }
        const car = sim.car;
        return {
            id: this._nextId++,
            label,
            tick: sim.tick,
            state: sim.getState(),
            // Recorder inputs are fresh normalised objects never written again, so sharing them is safe.
            seg: inputs.slice(parent ? parent.tick : 0, sim.tick),
            pos: [car.pos[0], car.pos[1], car.pos[2]],
            quat: [car.quat[0], car.quat[1], car.quat[2], car.quat[3]],
        };
    }

    _restore(i) {
        const m = this.markers[i];
        this.sim.setState(m.state);
        // Rebuild the recording in place: the chain's inputs up to this marker.
        const out = this.recorder.inputs;
        out.length = 0;
        for (let k = 1; k <= i; k++) {
            const seg = this.markers[k].seg;
            for (let j = 0; j < seg.length; j++) out.push(seg[j]);
        }
        this.current = i;
        this.rewinds++;
        return m;
    }

    /** Over the cap: the oldest placed marker goes, its inputs carried by the next one. */
    _dropOldest() {
        const gone = this.markers[1], next = this.markers[2];
        next.seg = gone.seg.concat(next.seg);
        this.markers.splice(1, 1);
        if (this.current >= 1) this.current--;
    }
}
