// Track editor model (js/editor/model.js) and palette thumbnails: placement,
// fit, snapping, undo history, validation runs and medals. The screen itself is
// checked in the browser (docs/EDITOR.md).
import assert from 'node:assert/strict';
import { test } from './_harness.mjs';
import {
    EditorDoc, newTrack, placementAt, medalsFromAuthor, betterRun, footprintCells, docFromStored, CATEGORIES, blocksIn,
} from '../../js/editor/model.js';
import { blockThumb, decorThumb } from '../../js/editor/thumbs.js';
import { BLOCK_LIST, BLOCKS, rotateCell } from '../../js/core/blocks.js';
import { buildWorld, validateTrack } from '../../js/core/track.js';
import { encodeTrack, decodeTrack, trackHash } from '../../js/core/codec.js';
import { runAutopilot } from '../../js/core/autopilot.js';
import { medalFor } from '../../js/levels/medals.js';
import { getTrack } from '../../js/levels/index.js';

/** Lays pieces end to end through snapping, like a player clicking along open ends. */
function chain(doc, cell, ids, variant = () => 0) {
    for (const id of ids) {
        const vs = doc.snapVariants(id, cell, 'snow');
        assert.ok(vs.length, `${id} snaps at ${cell}`);
        const v = vs[variant(id) % vs.length];
        assert.ok(doc.place(v.block), `${id} fits at ${JSON.stringify(v.block)}`);
        cell = v.next;
    }
    return cell;
}

test('new track: one Start, open road ahead', () => {
    const doc = new EditorDoc(newTrack({ author: 'Pingu' }));
    assert.equal(doc.blocks.length, 1);
    assert.equal(doc.blocks[0].b, 'Start');
    assert.equal(doc.track.author, 'Pingu');
    const open = doc.openConnectors();
    assert.equal(open.road.length, 1);
    assert.deepEqual(open.road[0].cell, [23, 0, 20]);
    assert.equal(doc.dirty, true);
    const fresh = new EditorDoc(newTrack(), { pristine: true });
    assert.equal(fresh.dirty, false);
    assert.equal(fresh.savedId, null);
    fresh.place({ b: 'Straight', x: 23, y: 0, z: 21, r: 0 });
    assert.equal(fresh.dirty, true);
});

test('palette covers every catalog block exactly once', () => {
    const ids = CATEGORIES.flatMap((c) => blocksIn(c.id).map((d) => d.id));
    assert.equal(ids.length, BLOCK_LIST.length);
    assert.deepEqual(new Set(ids), new Set(BLOCK_LIST.map((d) => d.id)));
});

test('placementAt puts the entry connector on the cursor at every rotation', () => {
    for (const def of BLOCK_LIST) {
        for (let r = 0; r < 4; r++) {
            const b = placementAt(def.id, [20, 2, 20], r, 'ice');
            const off = rotateCell(def, r, def.connectors[0].cell);
            assert.deepEqual([b.x + off[0], b.y + off[1], b.z + off[2]], [20, 2, 20], `${def.id} r${r}`);
            assert.ok(footprintCells(b).some((c) => c.join() === '20,2,20'));
            assert.equal(b.s, def.surfaces.includes('ice') ? 'ice' : def.defaultSurface);
        }
    }
});

test('fit: overlaps and the map edge are refused', () => {
    const doc = new EditorDoc(newTrack());
    assert.deepEqual(doc.fits({ b: 'Straight', x: 23, y: 0, z: 20, r: 0 }), { ok: false, reason: 'overlap', overlaps: [0] });
    assert.equal(doc.fits({ b: 'Turn3', x: 46, y: 0, z: 10, r: 0 }).reason, 'outside');
    assert.equal(doc.fits({ b: 'Straight', x: 0, y: 0, z: 0, r: 0 }).ok, true);
    assert.equal(doc.fits({ b: 'Loop', x: 10, y: 29, z: 10, r: 0 }).reason, 'outside');   // 4 layers tall
    assert.equal(doc.place({ b: 'Straight', x: 23, y: 0, z: 20, r: 0 }), false);
    assert.equal(doc.blocks.length, 1);
    // Stacking over a road one layer up is fine.
    assert.equal(doc.fits({ b: 'Straight', x: 23, y: 1, z: 20, r: 0 }).ok, true);
});

test('snapping: turns offer left and right, slopes up and down, Start replaces Start', () => {
    const doc = new EditorDoc(newTrack());
    const turn = doc.snapVariants('Turn1', [23, 0, 21], 'snow');
    assert.equal(turn.length, 2);
    assert.notEqual(turn[0].dir, turn[1].dir);
    assert.equal(doc.snapVariants('Straight', [23, 0, 21], 'snow').length, 1);   // symmetric
    const slope = doc.snapVariants('SlopeUp1', [23, 0, 21], 'snow');
    assert.equal(slope.length, 2);
    assert.deepEqual(slope.map((v) => v.next[1]).sort(), [-1, 1]);
    assert.equal(doc.snapVariants('Turn1', [10, 0, 10], 'snow').length, 0);
    // A second Start moves the start instead of breaking the track.
    assert.ok(doc.place({ b: 'Start', x: 5, y: 0, z: 5, r: 1 }));
    assert.equal(doc.blocks.filter((b) => b.b === 'Start').length, 1);
    assert.equal(doc.blocks[0].x, 5);
});

test('undo / redo walk the full history, a new edit clears redo', () => {
    const doc = new EditorDoc(newTrack());
    chain(doc, [23, 0, 21], ['Straight', 'Straight', 'Turn1', 'Finish']);
    assert.equal(doc.blocks.length, 5);
    doc.setProps({ name: '  Penguin Dash ', laps: 3.4, mood: 'night', mode: 'nope' });
    assert.equal(doc.track.name, 'Penguin Dash');
    assert.equal(doc.track.laps, 3);
    assert.equal(doc.track.mood, 'night');
    assert.equal(doc.track.mode, 'race');
    const labels = [];
    while (doc.canUndo) labels.push(doc.undo());
    assert.equal(labels.length, 5);
    assert.equal(doc.blocks.length, 1);
    assert.equal(doc.track.name, 'Untitled Track');
    while (doc.canRedo) doc.redo();
    assert.equal(doc.blocks.length, 5);
    assert.equal(doc.track.laps, 3);
    doc.undo();
    doc.remove(4);
    assert.equal(doc.canRedo, false);
    assert.equal(doc.place({ b: 'Straight', x: 23, y: 0, z: 20, r: 0 }), false, 'refused edits leave no history');
});

test('decor: one per cell, never inside a block', () => {
    const doc = new EditorDoc(newTrack());
    assert.equal(doc.placeDecor({ d: 'Igloo', x: 23, y: 0, z: 20, r: 0 }), false);
    assert.ok(doc.placeDecor({ d: 'Igloo', x: 20, y: 0, z: 20, r: 2 }));
    assert.equal(doc.placeDecor({ d: 'Pine', x: 20, y: 0, z: 20, r: 0 }), false);
    assert.equal(doc.decorAt(20, 0, 20), 0);
    assert.ok(doc.removeDecor(0));
    assert.equal(doc.decor.length, 0);
    doc.undo();
    assert.equal(doc.decor[0].d, 'Igloo');
});

test('medal formulas match the official bake', () => {
    assert.deepEqual(medalsFromAuthor(24410), { author: 24410, gold: 25900, silver: 30000, bronze: 37000 });
    assert.deepEqual(medalsFromAuthor(10000), { author: 10000, gold: 10600, silver: 12000, bronze: 15000 });
    assert.deepEqual(medalsFromAuthor(24410, 'platform'), { author: 24410, gold: 0, silver: 3, bronze: 10 });
    const p = medalsFromAuthor(30000, 'platform', 2);
    assert.deepEqual(p, { author: { respawns: 2, ms: 30000 }, gold: 2, silver: 5, bronze: 12 });
    // The author run itself earns the Emperor medal under the shared medal rules.
    assert.equal(medalFor({ mode: 'platform', medals: p }, { timeMs: 30000, respawns: 2 }), 'emperor');
    assert.equal(medalFor({ mode: 'platform', medals: p }, { timeMs: 25000, respawns: 3 }), 'silver');
    assert.equal(medalFor({ mode: 'race', medals: medalsFromAuthor(24410) }, { timeMs: 25900 }), 'gold');
    // Every official track's medals follow the same formula.
    for (const id of ['A01', 'C03', 'E05', 'T05']) {
        const t = getTrack(id);
        assert.deepEqual(medalsFromAuthor(t.medals.author, t.mode), t.medals, id);
    }
    assert.equal(betterRun('platform', { timeMs: 40000, respawns: 0 }, { timeMs: 30000, respawns: 1 }), true);
    assert.equal(betterRun('race', { timeMs: 40000 }, { timeMs: 30000 }), false);
});

test('validation follows the layout hash: edit invalidates, undo restores', () => {
    const doc = new EditorDoc(newTrack());
    chain(doc, [23, 0, 21], ['Straight', 'Turn2', 'Straight', 'Checkpoint', 'Turn1', 'Straight', 'Finish'], (id) => (id === 'Turn1' ? 1 : 0));
    const world = buildWorld(doc.toTrack());
    assert.ok(world.route, world.routeError);
    assert.equal(validateTrack(doc.toTrack()).ok, true);
    assert.equal(doc.validated, false);
    assert.deepEqual(doc.toTrack().medals, { author: null, gold: null, silver: null, bronze: null });
    const r = runAutopilot(world, { record: true });
    assert.ok(r.finished);
    assert.ok(doc.recordRun({ finished: true, timeMs: r.timeMs + 500, respawns: 0, replay: r.replay, by: 'driver' }));
    assert.ok(doc.recordRun({ finished: true, timeMs: r.timeMs, respawns: 0, replay: r.replay, by: 'autopilot' }), 'faster run becomes the author time');
    assert.equal(doc.recordRun({ finished: true, timeMs: r.timeMs + 900, respawns: 0, replay: r.replay }), false, 'slower run does not');
    assert.equal(doc.recordRun({ finished: false, timeMs: null }), false);
    assert.equal(doc.validation().timeMs, r.timeMs);
    assert.equal(doc.toTrack().medals.author, r.timeMs);
    const hash = doc.hash();
    assert.equal(r.replay.trackHash, hash);
    // Renaming keeps it validated; moving a block does not.
    doc.setProps({ name: 'Floe Ride' });
    assert.equal(doc.validated, true);
    doc.remove(doc.blocks.length - 1);
    assert.equal(doc.validated, false);
    assert.equal(doc.toTrack().medals.author, null);
    doc.undo();
    assert.equal(doc.validated, true);
    // A run on an older layout validates that layout only.
    doc.change((t) => { t.laps = 1; t.mode = 'platform'; });
    assert.equal(doc.validated, false);
    // Stored form round-trips the validation, share codes carry the medals.
    doc.undo();
    const stored = JSON.parse(JSON.stringify(doc.toStored()));
    assert.equal(stored.validation.hash, hash);
    const again = docFromStored(stored);
    assert.equal(again.validated, true);
    assert.equal(again.validation().timeMs, r.timeMs);
    const code = encodeTrack(doc.toTrack());
    const back = decodeTrack(code);
    assert.equal(trackHash(back), hash);
    assert.equal(back.medals.author, r.timeMs);
});

test('draft JSON round-trips the document', () => {
    const doc = new EditorDoc(newTrack());
    chain(doc, [23, 0, 21], ['Straight', 'Finish']);
    doc.markSaved(doc.track.id);
    assert.equal(doc.dirty, false);
    const copy = EditorDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    assert.equal(copy.dirty, false);
    assert.deepEqual(copy.blocks, doc.blocks);
    assert.equal(copy.hash(), doc.hash());
    copy.remove(1);
    assert.equal(copy.dirty, true);
});

test('an official track opens as an editable copy', () => {
    const t = getTrack('B03');
    const doc = new EditorDoc({ ...t, id: 'copy1', medals: null });
    assert.equal(doc.blocks.length, t.blocks.length);
    assert.equal(doc.hash(), trackHash(t));
    assert.equal(doc.validated, false);
    // Every block of an official track fits where it is (no self overlaps).
    doc.blocks.forEach((b, i) => assert.ok(doc.fits(b, i).ok, `block ${i}`));
});

test('thumbnails: every block and decor kind draws an SVG', () => {
    for (const d of BLOCK_LIST) {
        const svg = blockThumb(d.id);
        assert.match(svg, /^<svg[^>]+viewBox="[-\d. ]+"/, d.id);
        assert.ok(svg.endsWith('</svg>'));
        assert.ok(!svg.includes('NaN'), d.id);
    }
    for (const k of ['Pine', 'PineCluster', 'Igloo', 'Snowman', 'PenguinCrowd', 'Penguin', 'IceCrystal', 'Rock', 'Banner', 'Lamp', 'Mystery']) {
        assert.match(decorThumb(k), /^<svg.*<\/svg>$/);
    }
    assert.ok(BLOCKS.Turn2);
});
