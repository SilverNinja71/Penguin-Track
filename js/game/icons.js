// Inline SVG icons (24×24, drawn with currentColor) for buttons, moods and effects.
import { h } from './dom.js';

const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const PATHS = {
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    next: '<path d="M9 5l7 7-7 7"/>',
    retry: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    import: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
    export: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 17v3h16v-3"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><rect x="8" y="13" width="8" height="5"/>',
    film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>',
    gamepad: '<path d="M7 8h10a4 4 0 0 1 4 4.5l-.6 3.5a2.5 2.5 0 0 1-4.3 1.2L14 15h-4l-2.1 2.2a2.5 2.5 0 0 1-4.3-1.2L3 12.5A4 4 0 0 1 7 8z"/><path d="M8 10.5v3M6.5 12h3"/><circle cx="15.5" cy="11" r="0.7" fill="currentColor"/><circle cx="17" cy="13" r="0.7" fill="currentColor"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.2c2.6.3 4.5 2.6 4.5 5.3"/>',
    brain: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4"/><circle cx="12" cy="3" r="1" fill="currentColor"/><circle cx="9.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><path d="M9.5 15.5h5M3 11v3M21 11v3"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M9.5 2.5h5"/>',
    tas: '<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4"/><path d="M9.5 2.5h5"/><path d="M7.5 13h1.5M12 8.5V10"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5v1.5A3 3 0 0 0 8 10.5M16 6h3v1.5a3 3 0 0 1-3 3"/><path d="M12 13v4M8.5 20h7M10 17h4v3h-4z"/>',
    ghost: '<path d="M4.5 20.5V11a7.5 7.5 0 0 1 15 0v9.5l-2.5-2-2.5 2-2.5-2-2.5 2-2.5-2z"/><circle cx="9.5" cy="10.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="14.5" cy="10.5" r="1.4" fill="currentColor" stroke="none"/>',
    camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.3"/>',
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
    snowflake: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7"/><path d="M9.5 3.5L12 5.5l2.5-2M9.5 20.5L12 18.5l2.5 2M3 10.2l3.2-.6-1-3M21 13.8l-3.2.6 1 3M3 13.8l3.2.6-1 3M21 10.2l-3.2-.6 1-3"/>',
    penguin: '<path d="M12 3c-3.5 0-6 3-6 7v5c0 3.3 2.7 6 6 6s6-2.7 6-6v-5c0-4-2.5-7-6-7z"/><path d="M12 9c-2 0-3.2 1.6-3.2 3.6v2.4a3.2 3.2 0 0 0 6.4 0v-2.4C15.2 10.6 14 9 12 9z" fill="currentColor" opacity="0.35"/><path d="M10.6 8.6l1.4 1.2 1.4-1.2"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    speed: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4.5-5"/>',
    map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    rewind: '<path d="M11 6l-7 6 7 6z" fill="currentColor"/><path d="M20 6l-7 6 7 6z" fill="currentColor"/>',
    forward: '<path d="M13 6l7 6-7 6z" fill="currentColor"/><path d="M4 6l7 6-7 6z" fill="currentColor"/>',
    volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    // Moods
    day: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
    sunset: '<path d="M6 16a6 6 0 0 1 12 0"/><path d="M2.5 16h19M5 20h14"/><path d="M12 5v3M4.6 9.6l1.8 1.4M19.4 9.6l-1.8 1.4"/>',
    night: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/><path d="M17 3.5v3M15.5 5h3"/>',
    aurora: '<path d="M3 15c3-6 6-6 9 0s6 6 9 0"/><path d="M3 10c3-5 6-5 9 0s6 5 9 0" opacity="0.6"/><path d="M3 20h18"/>',
    // Effects
    turbo: '<path d="M5 6l6 6-6 6M12 6l6 6-6 6"/>',
    turbo2: '<path d="M3 6l5 6-5 6M9 6l5 6-5 6M15 6l5 6-5 6"/>',
    noEngine: '<rect x="4" y="8" width="12" height="9" rx="1.5"/><path d="M16 11h3v3h-3M7 8V6h6v2"/><path d="M10 10.5v4M8.3 11.5l3.4 2M8.3 13.5l3.4-2"/>',
    noSteer: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/><path d="M12 14v6.5M10.2 11l-6.4-2.2M13.8 11l6.4-2.2"/>',
    noBrake: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M5 19L19 5"/>',
    slowmo: '<circle cx="12" cy="10" r="7"/><path d="M7 20h10l-1.5-3.5h-7z"/><path d="M10 8.5h.01M13.5 7h.01M12 11.5h.01M9.5 12h.01M14.5 11h.01"/>',
    cruise: '<path d="M3 16c4 0 6-8 10-8h8"/><path d="M17 4l4 4-4 4"/>',
    fragile: '<path d="M4 6h16v12H4z"/><path d="M11 6l-1.5 4 3 2-2 6"/>',
    broken: '<path d="M4 6h16v12H4z"/><path d="M11 6l-1.5 4 3 2-2 6M14 9l3 2"/>',
    reset: '<path d="M12 3c3 4 5 6.5 5 9.5a5 5 0 0 1-10 0C7 9.5 9 7 12 3z"/>',
};

/** Raw SVG markup for an icon (trusted constant strings only). */
export function iconSvg(name, size = 20) {
    const body = PATHS[name] || PATHS.snowflake;
    return `<svg class="pt-icon" width="${size}" height="${size}" viewBox="0 0 24 24" ${S} aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Icon as a <span> element. */
export function icon(name, size = 20, cls = '') {
    return h('span', { class: `pt-ico ${cls}`.trim(), html: iconSvg(name, size) });
}

export const MOOD_LABELS = { day: 'Clear day', sunset: 'Sunset', night: 'Night', aurora: 'Aurora' };

/** The penguin mascot used by the logo and the boot card (bigger, friendlier than the icon set). */
export function penguinSvg(size = 120) {
    return `<svg class="pt-penguin" width="${size}" height="${size}" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="ptBelly" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dbeefc"/></linearGradient>
    <linearGradient id="ptBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b3a4d"/><stop offset="1" stop-color="#141d29"/></linearGradient>
    <linearGradient id="ptCar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a8a"/><stop offset="1" stop-color="#d42c46"/></linearGradient>
  </defs>
  <g stroke="#0b1a2e" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">
    <path d="M60 18c-17 0-28 14-28 32v18h56V50c0-18-11-32-28-32z" fill="url(#ptBody)"/>
    <path d="M60 40c-10 0-16 8-16 18v12h32V58c0-10-6-18-16-18z" fill="url(#ptBelly)" stroke="none"/>
    <path d="M38 34h44a6 6 0 0 1 0 12H38a6 6 0 0 1 0-12z" fill="#7fdcff"/>
    <path d="M44 37.5h8M68 37.5h8" stroke="#e8fbff" stroke-width="2.4"/>
    <path d="M60 46l-7 4.5 7 4.5 7-4.5z" fill="#f7a21b"/>
    <path d="M12 74h96l-6 18H18z" fill="url(#ptCar)"/>
    <path d="M30 74l8-12h44l8 12" fill="#ff8c9b"/>
    <path d="M22 82h16M82 82h16" stroke="#ffd0d8" stroke-width="2.4"/>
    <circle cx="32" cy="94" r="10" fill="#1f2a36"/>
    <circle cx="88" cy="94" r="10" fill="#1f2a36"/>
    <circle cx="32" cy="94" r="3.5" fill="#9db8d9" stroke="none"/>
    <circle cx="88" cy="94" r="3.5" fill="#9db8d9" stroke="none"/>
    <path d="M38 20c6-9 20-12 30-5" stroke="#ff5d6c" stroke-width="6" fill="none"/>
    <path d="M84 58l12 8" stroke="#ff5d6c" stroke-width="6"/>
  </g>
</svg>`;
}
