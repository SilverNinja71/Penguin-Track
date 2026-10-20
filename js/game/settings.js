// Player settings: defaults, validation and key names. Stored under
// 'penguintrack:settings'; everything unknown or malformed falls back to the default.

/** Every remappable action, in the order the settings and help screens list them. */
export const ACTIONS = [
    { id: 'gas', label: 'Accelerate' },
    { id: 'brake', label: 'Brake / reverse' },
    { id: 'left', label: 'Steer left' },
    { id: 'right', label: 'Steer right' },
    { id: 'respawn', label: 'Respawn at checkpoint' },
    { id: 'restart', label: 'Restart run' },
    { id: 'camera1', label: 'Camera 1 (chase)' },
    { id: 'camera2', label: 'Camera 2 (close)' },
    { id: 'camera3', label: 'Camera 3 (cockpit)' },
    { id: 'cameraCycle', label: 'Cycle cameras' },
    { id: 'ghost', label: 'Toggle ghosts' },
    { id: 'pause', label: 'Pause / menu' },
];

// Trackmania defaults (ARCHITECTURE.md, Controls). KeyboardEvent.code values, so
// the layout does not matter: on AZERTY 'KeyW' is the key labelled Z.
export const DEFAULT_BINDINGS = {
    gas: ['ArrowUp', 'KeyW'],
    brake: ['ArrowDown', 'KeyS'],
    left: ['ArrowLeft', 'KeyA'],
    right: ['ArrowRight', 'KeyD'],
    respawn: ['Enter', 'NumpadEnter'],
    restart: ['Backspace', 'Delete'],
    camera1: ['Digit1', 'Numpad1'],
    camera2: ['Digit2', 'Numpad2'],
    camera3: ['Digit3', 'Numpad3'],
    cameraCycle: ['KeyC'],
    ghost: ['KeyG'],
    pause: ['Escape', 'KeyP'],
};

export const CAMERAS = [
    { id: 'chase', label: 'Chase' },
    { id: 'close', label: 'Close' },
    { id: 'cockpit', label: 'Cockpit' },
];

export const QUALITIES = ['low', 'medium', 'high'];

function prefersReducedMotion() {
    try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
        return false;
    }
}

function defaultQuality() {
    try {
        const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        return coarse ? 'low' : 'medium';
    } catch (e) {
        return 'medium';
    }
}

export function defaultSettings() {
    return {
        volume: { master: 0.8, sfx: 0.9, music: 0.5 },
        quality: defaultQuality(),
        reducedMotion: prefersReducedMotion(),
        camera: 'chase',
        showGhost: true,          // personal-best ghost
        showEmperorGhost: false,  // the author run
        showSplits: true,
        showMinimap: true,
        units: 'kmh',
        touchControls: 'auto',    // 'auto' | 'on' | 'off'
        padSensitivity: 1,        // 0.5..2: steering gain on the stick
        padDeadzone: 0.12,        // 0..0.4
        bindings: cloneBindings(DEFAULT_BINDINGS),
    };
}

export function cloneBindings(b) {
    const out = {};
    for (const a of ACTIONS) out[a.id] = (b[a.id] || []).slice(0, 2);
    return out;
}

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);

/** Merges stored settings over the defaults, keeping only valid values. */
export function sanitizeSettings(raw) {
    const d = defaultSettings();
    if (!raw || typeof raw !== 'object') return d;
    const vol = raw.volume || {};
    const out = {
        volume: {
            master: num(vol.master, 0, 1, d.volume.master),
            sfx: num(vol.sfx, 0, 1, d.volume.sfx),
            music: num(vol.music, 0, 1, d.volume.music),
        },
        quality: pick(raw.quality, QUALITIES, d.quality),
        reducedMotion: bool(raw.reducedMotion, d.reducedMotion),
        camera: pick(raw.camera, CAMERAS.map((c) => c.id), d.camera),
        showGhost: bool(raw.showGhost, d.showGhost),
        showEmperorGhost: bool(raw.showEmperorGhost, d.showEmperorGhost),
        showSplits: bool(raw.showSplits, d.showSplits),
        showMinimap: bool(raw.showMinimap, d.showMinimap),
        units: pick(raw.units, ['kmh', 'mph'], d.units),
        touchControls: pick(raw.touchControls, ['auto', 'on', 'off'], d.touchControls),
        padSensitivity: num(raw.padSensitivity, 0.5, 2, d.padSensitivity),
        padDeadzone: num(raw.padDeadzone, 0, 0.4, d.padDeadzone),
        bindings: cloneBindings(d.bindings),
    };
    if (raw.bindings && typeof raw.bindings === 'object') {
        for (const a of ACTIONS) {
            const keys = raw.bindings[a.id];
            if (Array.isArray(keys)) out.bindings[a.id] = keys.filter((k) => typeof k === 'string' && k).slice(0, 2);
        }
    }
    return out;
}

const KEY_NAMES = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: 'Enter', NumpadEnter: 'Num Enter', Backspace: 'Backspace', Delete: 'Delete',
    Escape: 'Esc', Space: 'Space', Tab: 'Tab', ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
    MetaLeft: 'L Meta', MetaRight: 'R Meta', CapsLock: 'Caps', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`',
    Backslash: '\\', Comma: ',', Period: '.', Slash: '/', PageUp: 'PgUp', PageDown: 'PgDn',
    Home: 'Home', End: 'End', Insert: 'Ins',
};

/** Short label for a KeyboardEvent.code ('KeyW' -> 'W', 'ArrowUp' -> '↑'). */
export function keyLabel(code) {
    if (!code) return '—';
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    return code;
}

export function speedValue(kmh, units) {
    return units === 'mph' ? kmh / 1.609344 : kmh;
}
