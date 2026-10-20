// Silent stand-ins for the renderer and audio engine, so the menus keep
// working when WebGL is missing or a module fails to load, and so a renderer or
// audio engine missing an optional method never throws in the middle of a race.

class NullCar {
    setPose() {}
    setVisible() {}
    setColor() {}
    setLabel() {}
    teleported() {}
}

export class NullRenderer {
    constructor() {
        this.isNull = true;
        this.cameraControls = null;
        this.cameraMode = null;
        this.scene = null;
        this.camera = null;
        this.three = null;
        this.world = null;
    }
    loadWorld(world) { this.world = world || null; }
    clearWorld() { this.world = null; }
    setMood() {}
    setQuality() {}
    setReducedMotion() {}
    setCountdown() {}
    addCar() { return new NullCar(); }
    removeCar() {}
    setCameraMode() {}
    handleEvents() {}
    setViewports() {}
    render() {}
    resize() {}
    dispose() {}
}

export class NullAudio {
    constructor() {
        this.isNull = true;
    }
    unlock() { return Promise.resolve(false); }
    autoUnlock() {}
    setVolume() {}
    updateCar() {}
    handleEvents() {}
    countdown() {}
    go() {}
    ui() {}
    chime() {}
    play() { return 0; }
    music() {}
    stopCar() {}
    suspend() {}
    resume() {}
    dispose() {}
}

export const RENDERER_METHODS = ['loadWorld', 'clearWorld', 'setMood', 'setQuality', 'setReducedMotion', 'setCountdown', 'addCar', 'removeCar',
    'setCameraMode', 'handleEvents', 'setViewports', 'render', 'resize', 'dispose'];
export const AUDIO_METHODS = ['unlock', 'autoUnlock', 'setVolume', 'updateCar', 'handleEvents', 'countdown', 'go', 'ui', 'chime', 'play',
    'music', 'stopCar', 'suspend', 'resume', 'dispose'];

/** Gives `obj` a no-op for every contract method it lacks; wraps the rest so one failing call is logged, not fatal. */
function harden(obj, stub, methods, label) {
    const warned = new Set();
    for (const m of methods) {
        const fn = obj[m];
        if (typeof fn !== 'function') {
            obj[m] = stub[m].bind(stub);
            continue;
        }
        obj[m] = function (...args) {
            try {
                return fn.apply(obj, args);
            } catch (e) {
                if (!warned.has(m)) {
                    warned.add(m);
                    console.error(`[penguintrack] ${label}.${m} failed`, e);
                }
                return m === 'addCar' ? new NullCar() : undefined;
            }
        };
    }
    return obj;
}

export function hardenRenderer(r) {
    return harden(r, new NullRenderer(), RENDERER_METHODS, 'renderer');
}

export function hardenAudio(a) {
    return harden(a, new NullAudio(), AUDIO_METHODS, 'audio');
}
