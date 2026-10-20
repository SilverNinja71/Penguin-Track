// Renderer checks that run without WebGL: the scenery layout (pure), the low-poly
// models and the camera rig (three.js only, resolved to vendor/ through a module
// hook), and that renderer.js links and exposes the GameRenderer contract.
import assert from 'node:assert/strict';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, info } from './_harness.mjs';
import { getSamples, getSample } from '../../js/core/samples.js';
import { buildWorld } from '../../js/core/track.js';
import { CELL, LAYER } from '../../js/core/constants.js';
import { planScenery, terrainHeight } from '../../js/render/layout.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Map the browser import map ('three', 'three/addons/') onto vendor/ for Node.
let hooks = false;
if (typeof module.registerHooks === 'function') {
    module.registerHooks({
        resolve(specifier, context, next) {
            if (specifier === 'three') return { url: pathToFileURL(path.join(root, 'vendor/three.module.min.js')).href, shortCircuit: true };
            if (specifier.startsWith('three/addons/')) {
                return { url: pathToFileURL(path.join(root, 'vendor/addons', specifier.slice('three/addons/'.length))).href, shortCircuit: true };
            }
            return next(specifier, context);
        },
    });
    hooks = true;
}

const worlds = new Map();
function world(id) {
    if (!worlds.has(id)) worlds.set(id, buildWorld(getSample(id)));
    return worlds.get(id);
}

test('scenery plan is deterministic and differs per track', () => {
    const a = planScenery(world('S01')), b = planScenery(buildWorld(getSample('S01')));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    const c = planScenery(world('S02'));
    assert.notEqual(JSON.stringify(a.items.slice(0, 20)), JSON.stringify(c.items.slice(0, 20)));
    assert.ok(a.items.length > 100, 'a dressed landscape');
    assert.equal(a.mountains.length, 22);
});

test('auto scenery keeps clear of roads, jump gaps and decor', () => {
    for (const t of getSamples()) {
        const w = world(t.id);
        const plan = planScenery(w);
        const routeCells = new Set();
        const p = w.route.points;
        for (let i = 0; i < w.route.count; i++) routeCells.add(`${Math.floor(p[i * 3] / CELL)},${Math.floor(p[i * 3 + 2] / CELL)}`);
        let inside = 0;
        for (const it of plan.items) {
            const x = Math.floor(it.x / CELL), z = Math.floor(it.z / CELL);
            if (x < 0 || z < 0 || x >= 48 || z >= 48) continue;
            inside++;
            for (let y = 0; y < 4; y++) assert.equal(w.blockAt(x, y, z), -1, `${t.id}: ${it.kind} on block cell ${x},${y},${z}`);
            assert.ok(!routeCells.has(`${x},${z}`), `${t.id}: ${it.kind} under the route at ${x},${z}`);
            for (const d of t.decor || []) assert.ok(!(d.x === x && d.z === z), `${t.id}: ${it.kind} on decor cell`);
        }
        assert.ok(inside > 50, `${t.id}: scenery near the track`);
    }
});

test('penguin crowds stand beside ground-level gates, off the road', () => {
    const w = world('S04');
    const plan = planScenery(w);
    assert.ok(plan.crowds.length > 20);
    const gates = w.render.props.filter((p) => p.kind === 'gate');
    for (const c of plan.crowds) {
        const near = Math.min(...gates.map((g) => Math.hypot(g.pos[0] - c.x, g.pos[2] - c.z)));
        assert.ok(near < 30, 'crowd near a gate');
        assert.equal(w.blockAt(Math.floor(c.x / CELL), 0, Math.floor(c.z / CELL)), -1, 'crowd off the road');
    }
});

test('night lamps line flat road at the snowbank edge', () => {
    const w = world('S01');
    const plan = planScenery(w);
    assert.ok(plan.lamps.length >= 5);
    for (const l of plan.lamps) {
        const pr = w.route.project([l.x, l.y - 1.2, l.z]);
        assert.ok(Math.abs(Math.abs(pr.lateral) - 13.2) < 1.5, `lamp at the bank (lateral ${pr.lateral.toFixed(2)})`);
        const pool = w.route.project(l.road);
        assert.ok(Math.abs(pool.lateral) < pr.halfWidth, 'light pool on the road');
    }
});

test('terrain is flat on the map and rolls into hills beyond it', () => {
    assert.equal(terrainHeight(10, 10), 0);
    assert.equal(terrainHeight(1500, 700), 0);
    assert.ok(Math.abs(terrainHeight(-5, 700)) < 0.5, 'gentle at the edge');
    let max = -Infinity;
    for (let d = 200; d < 3000; d += 200) max = Math.max(max, terrainHeight(-d, 700), terrainHeight(1536 + d, 300));
    assert.ok(max > 25, 'hills further out');
});

test('scenery plan on an empty and on a decor-heavy track', () => {
    const blank = buildWorld({ blocks: [] });
    const p = planScenery(blank);
    assert.ok(p.items.length > 0 && p.lamps.length === 0);
    const t = JSON.parse(JSON.stringify(getSample('S06')));
    t.decor = [];
    for (let x = 0; x < 6; x++) t.decor.push({ d: 'Pine', x, y: 0, z: 0, r: 0 });
    const w = buildWorld(t);
    for (const it of planScenery(w).items) {
        const x = Math.floor(it.x / CELL), z = Math.floor(it.z / CELL);
        assert.ok(!(z === 0 && x >= 0 && x < 6), 'auto scenery avoids decor cells');
    }
});

test('scenery models stay within their triangle budgets and stand on the ground', async () => {
    if (!hooks) return info('skipped: module.registerHooks needs Node >= 22.15');
    const M = await import('../../js/render/models.js');
    const budget = { pineGeometry: 140, rockGeometry: 100, crystalGeometry: 60, iglooGeometry: 260, snowmanGeometry: 720, penguinGeometry: 240, lampGeometry: 120 };
    const sizes = [];
    for (const [fn, max] of Object.entries(budget)) {
        const g = M[fn]();
        const tris = g.getAttribute('position').count / 3;
        g.computeBoundingBox();
        sizes.push(`${fn.replace('Geometry', '')} ${tris}`);
        assert.ok(tris <= max, `${fn}: ${tris} triangles > ${max}`);
        // Rocks and crystals are partly buried on purpose; nothing floats.
        assert.ok(g.boundingBox.min.y > -1.2 && g.boundingBox.min.y < 0.05, `${fn} stands on the ground (min y ${g.boundingBox.min.y.toFixed(2)})`);
        assert.ok(g.getAttribute('color'), `${fn} has vertex colours`);
    }
    info(sizes.join(', '));
    // Mountains face the sky (the upper faces' normals point up).
    const m = M.mountainGeometry(500, 600, 12345);
    const n = m.getAttribute('normal'), pos = m.getAttribute('position');
    let up = 0, total = 0;
    for (let i = 0; i < pos.count; i += 3) {
        if (pos.getY(i) < 100) continue;
        total++;
        if (n.getY(i) > 0) up++;
    }
    assert.ok(up / total > 0.95, `mountain faces point up (${up}/${total})`);
});

test('chase camera sits behind and above the car and snaps on a teleport', async () => {
    if (!hooks) return info('skipped: module.registerHooks needs Node >= 22.15');
    const THREE = await import('three');
    const { CameraRig, CAMERA_MODES } = await import('../../js/render/cameras.js');
    assert.deepEqual(CAMERA_MODES, ['chase', 'close', 'cockpit', 'free', 'orbit', 'top']);
    const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.2, 9000);
    const object = new THREE.Group();
    object.position.set(100, 8.65, 100);
    const car = { object, teleportSerial: 0, view: { vel: [0, 0, 30], speedKmh: 108, airborne: false, effects: {} }, setCockpit() {} };
    const rig = new CameraRig(cam, null);
    rig.setMode('chase', car);
    rig.update(1 / 60, 16 / 9);
    assert.ok(cam.position.z < 100 - 5 && cam.position.z > 100 - 9, `behind the car (z ${cam.position.z.toFixed(2)})`);
    assert.ok(cam.position.y > 8.65 + 1.5, 'above the car');
    // Turn the car around: without a teleport the camera swings smoothly...
    object.rotation.y = Math.PI;
    car.view.vel = [0, 0, -30];
    rig.update(1 / 60, 16 / 9);
    assert.ok(cam.position.z < 100, 'still on the old side after one frame');
    // ...with a teleport (respawn) it snaps behind the new heading at once.
    object.position.set(600, 16.65, 300);
    car.teleportSerial++;
    rig.update(1 / 60, 16 / 9);
    assert.ok(cam.position.z > 300 + 5, `snapped behind the respawned car (z ${cam.position.z.toFixed(2)})`);
    assert.ok(Math.abs(cam.position.x - 600) < 1);
    // Loops: the camera rolls with an upside-down car.
    object.rotation.set(0, 0, Math.PI);
    car.teleportSerial++;
    rig.update(1 / 60, 16 / 9);
    assert.ok(cam.up.y < -0.9, 'camera up follows the car through a loop');
    // Free and top cams.
    rig.setMode('top');
    rig.setTop({ center: [768, 0, 768], height: 300 });
    rig.update(1 / 60, 1);
    assert.ok(Math.abs(cam.position.y - 300) < 1e-6 && cam.getWorldDirection(new THREE.Vector3()).y < -0.99);
    rig.dispose();
});

test('renderer module links and exposes the GameRenderer contract', async () => {
    if (!hooks) return info('skipped: module.registerHooks needs Node >= 22.15');
    const mod = await import('../../js/render/renderer.js');
    const proto = mod.GameRenderer.prototype;
    for (const m of ['loadWorld', 'clearWorld', 'setMood', 'setQuality', 'setReducedMotion', 'addCar', 'removeCar', 'setCameraMode',
        'createCamera', 'removeCamera', 'setViewports', 'handleEvents', 'setCountdown', 'update', 'render', 'resize', 'dispose',
        'pick', 'screenRay', 'setTrackHighlight', 'stats', 'snapshotCar']) {
        assert.equal(typeof proto[m], 'function', `GameRenderer.${m}`);
    }
    assert.equal(typeof mod.snapshotCar, 'function');
    assert.equal(typeof mod.lerpCarSnapshot, 'function');
    assert.deepEqual(mod.QUALITIES, ['low', 'medium', 'high']);
    const env = await import('../../js/render/environment.js');
    assert.deepEqual(Object.keys(env.MOODS), ['day', 'sunset', 'night', 'aurora']);
    assert.ok(LAYER === 8);
});
