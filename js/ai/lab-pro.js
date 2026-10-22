// The AI Lab's free tier and what Pro AI lifts (js/services/entitlements.js
// says who owns it): free training runs up to FREE_AI.generations on one
// worker with the presets; Pro AI unlocks unlimited generations, up to
// PRO_AI_WORKERS workers, custom rays / hidden layers / mutation settings and
// weight import / export.
import { h } from '../game/dom.js';
import { iconSvg } from '../game/icons.js';
import { requirePro } from '../game/paywall.js';
import { FREE_AI, PRO_AI_WORKERS, hasProAI, onEntitlementsChange } from '../services/entitlements.js';

/** Training settings only Pro AI may change by hand (the presets still set them). */
export const AI_PRO_SETTINGS = ['hidden', 'edgeRays', 'fov', 'wallRays', 'mutation', 'sigma', 'lr'];

export { FREE_AI };

/** Worker threads allowed for `wanted`. */
export function aiWorkerCap(wanted) {
    return hasProAI() ? Math.min(wanted, PRO_AI_WORKERS) : Math.min(wanted, FREE_AI.workers);
}

/** The generation to stop at for a run aiming at `goal` (0 = no end). */
export function aiGoalCap(goal) {
    if (hasProAI()) return goal;
    return goal > 0 ? Math.min(goal, FREE_AI.generations) : FREE_AI.generations;
}

/** True when a free run has used up its generations. */
export function atFreeLimit(generation) {
    return !hasProAI() && generation >= FREE_AI.generations;
}

/** The paywall for Pro AI when it is missing. Resolves true when the player may go on. */
export function requireProAI(app, reason) {
    return requirePro(app, 'pro_ai', reason);
}

/**
 * Locks the Pro-only inputs (by key in `inputs`) and shows a "free Lab" note
 * with an Unlock button at the top of `box`; unlocks on purchase. `onChange`
 * runs after each sync. Returns the teardown.
 */
export function mountAiProLock(app, inputs, box, onChange) {
    const note = h('div.ai-pro-note',
        h('span.pt-ico', { html: iconSvg('lock', 16) }),
        h('span.ai-pro-text', { title: `Pro AI: unlimited generations, ${PRO_AI_WORKERS} workers, custom networks, rays and mutation, weight import / export` }, `Free Lab: presets, ${FREE_AI.generations} generations, ${FREE_AI.workers} worker`),
        h('button.pt-btn.small.primary', { type: 'button', onclick: () => requireProAI(app, '') }, 'Unlock'));
    box.insertBefore(note, box.firstChild);
    const sync = () => {
        const pro = hasProAI();
        for (const k of AI_PRO_SETTINGS) {
            const el = inputs[k];
            if (!el) continue;
            el.disabled = !pro;
            if (pro) el.removeAttribute('title');
            else el.title = 'Needs Pro AI';
        }
        note.classList.toggle('pt-hidden', pro);
        if (onChange) onChange();
    };
    sync();
    return onEntitlementsChange(sync);
}
