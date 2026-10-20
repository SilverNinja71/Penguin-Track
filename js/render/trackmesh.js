// Track meshes from world.render.meshes: one draw per material, procedural
// textures, plus per-block highlight overlays built from the index ranges.
import * as THREE from 'three';
import {
    roadTexture, roadGlowTexture, platformTexture, borderTexture, wallTexture, groundTexture,
    roofTexture, lineTexture, padTexture,
} from './textures.js';

const GATE_BLOCKS = new Set(['Start', 'Finish', 'Checkpoint', 'StartFinish']);

function geometryOf(m, index = m.indices) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
}

function repeated(tex, rx, ry, ox = 0, oy = 0) {
    const t = tex.clone();
    t.repeat.set(rx, ry);
    t.offset.set(ox, oy);
    t.needsUpdate = true;
    return t;
}

/**
 * Material factory for one render material id. Materials are made per world
 * (cheap) so per-mood tweaks never leak between renderers; textures are shared.
 */
export function makeTrackMaterial(id, env) {
    const envMap = env?.envMap || null;
    if (id.startsWith('road_')) {
        const s = id.slice(5);
        const map = repeated(roadTexture(s), 1 / 24, 1 / 24, 0.5, 0);
        const glow = repeated(roadGlowTexture(s), 1 / 24, 1 / 24, 0.5, 0);
        const ice = s === 'ice';
        return new THREE.MeshStandardMaterial({
            map, emissiveMap: glow, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0,
            roughness: ice ? 0.32 : s === 'powder' ? 0.95 : 0.78, metalness: 0,
            envMap, envMapIntensity: ice ? 1.1 : 0.25,
            userData: { glowable: true },
        });
    }
    if (id.startsWith('platform_') || id.startsWith('crossing_')) {
        const s = id.slice(9);
        const span = id.startsWith('crossing_') ? 24 : 32;
        const ice = s === 'ice';
        return new THREE.MeshStandardMaterial({
            map: repeated(platformTexture(s), 1 / span, 1 / span, 0.5, 0),
            roughness: ice ? 0.32 : s === 'powder' ? 0.95 : 0.8, metalness: 0,
            envMap, envMapIntensity: ice ? 1.1 : 0.25,
        });
    }
    switch (id) {
        case 'border':
        case 'border_gate':
            return new THREE.MeshStandardMaterial({
                map: repeated(borderTexture(id === 'border_gate'), 1 / 4, 1 / 4),
                roughness: 0.85, envMap, envMapIntensity: 0.2,
            });
        case 'wall':
            return new THREE.MeshStandardMaterial({
                map: repeated(wallTexture(), 1 / 4, 1 / 4), roughness: 0.35, envMap, envMapIntensity: 0.6,
            });
        case 'roof_ice':
            return new THREE.MeshStandardMaterial({
                map: repeated(roofTexture(), 1 / 12, 1 / 12), roughness: 0.08, metalness: 0,
                transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false,
                envMap, envMapIntensity: 1.4, emissive: new THREE.Color(0x2a7fc0), emissiveIntensity: 0.15,
            });
        case 'ground':
            return new THREE.MeshStandardMaterial({
                map: repeated(groundTexture(), 1 / 128, 1 / 128), roughness: 0.95,
                polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4,
            });
        case 'line_start':
        case 'line_finish':
        case 'line_checkpoint': {
            const map = lineTexture(id.slice(5));
            return new THREE.MeshStandardMaterial({
                map, emissiveMap: map, emissive: new THREE.Color(0xffffff),
                emissiveIntensity: id === 'line_checkpoint' ? 0.55 : 0.12, roughness: 0.6,
                polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
            });
        }
        default:
            if (id.startsWith('pad_')) {
                const map = padTexture(id.slice(4));
                return new THREE.MeshStandardMaterial({
                    map, emissiveMap: map, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.55,
                    roughness: 0.45, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
                    userData: { pad: id.slice(4) },
                });
            }
            return new THREE.MeshStandardMaterial({ color: 0xff00ff });
    }
}

/**
 * Builds the track group. Returns { group, meshes: Map(material -> Mesh),
 * setHighlight(indices | null, color), materials, update(time), dispose() }.
 */
export function buildTrackMeshes(world, env, quality) {
    const group = new THREE.Group();
    group.name = 'track';
    const meshes = new Map();
    const materials = [];
    const gateBlocks = new Set(), crossBlocks = new Set();
    for (const b of world.blocks || []) {
        if (GATE_BLOCKS.has(b.b)) gateBlocks.add(b.index);
        if (b.b === 'Cross') crossBlocks.add(b.index);
    }
    const shadows = quality !== 'low';

    const add = (id, geo, src) => {
        const mat = makeTrackMaterial(id, env);
        materials.push(mat);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = id;
        mesh.userData.src = src;
        const decal = id.startsWith('pad_') || id.startsWith('line_');
        mesh.receiveShadow = shadows && id !== 'roof_ice';
        mesh.castShadow = shadows && !decal && id !== 'ground' && id !== 'roof_ice';
        if (id === 'roof_ice') mesh.renderOrder = 2;
        group.add(mesh);
        meshes.set(id, mesh);
        return mesh;
    };

    // Index slices of a merged mesh for the blocks that pass `pred` (and the rest).
    const split = (m, pred) => {
        const yes = [], no = [];
        for (const r of m.ranges) (pred(r.blockIndex) ? yes : no).push(r);
        const sliceOf = (list) => {
            let n = 0;
            for (const r of list) n += r.count;
            const index = new Uint32Array(n);
            const ranges = [];
            let k = 0;
            for (const r of list) {
                index.set(m.indices.subarray(r.start, r.start + r.count), k);
                ranges.push({ blockIndex: r.blockIndex, start: k, count: r.count });
                k += r.count;
            }
            return { ...m, indices: index, ranges };
        };
        return [sliceOf(yes), sliceOf(no)];
    };
    const addSplit = (m, pred, idYes, idNo) => {
        for (const [part, id] of split(m, pred).map((p, i) => [p, i ? idNo : idYes])) {
            if (part.indices.length) add(id, geometryOf(part, part.indices), part);
        }
    };

    for (const m of world.render.meshes) {
        if (m.material === 'border' && gateBlocks.size) {
            // Gate blocks get candy-striped banks.
            addSplit(m, (i) => gateBlocks.has(i), 'border_gate', 'border');
        } else if (m.material.startsWith('road_') && crossBlocks.size) {
            // Crossings get a lane-free deck: lane stripes would cut across the side openings.
            addSplit(m, (i) => crossBlocks.has(i), 'crossing_' + m.material.slice(5), m.material);
        } else {
            add(m.material, geometryOf(m), m);
        }
    }
    // Snowbanks read as soft mounds: bend their panel normals toward the sky.
    for (const id of ['border', 'border_gate']) {
        const mesh = meshes.get(id);
        if (!mesh) continue;
        const src = mesh.geometry.getAttribute('normal');
        const n = new Float32Array(src.array.length);
        for (let i = 0; i < n.length; i += 3) {
            const x = src.array[i], y = src.array[i + 1] + 0.9, z = src.array[i + 2];
            const l = Math.hypot(x, y, z) || 1;
            n[i] = x / l; n[i + 1] = y / l; n[i + 2] = z / l;
        }
        mesh.geometry.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    }

    // Highlight overlays share the attribute buffers; only their groups change.
    const hlMat = new THREE.MeshBasicMaterial({
        color: 0x7fdcff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, toneMapped: false,
    });
    const overlays = [];
    for (const [id, mesh] of meshes) {
        if (id === 'ground') continue;
        const g = new THREE.BufferGeometry();
        for (const k of ['position', 'normal']) g.setAttribute(k, mesh.geometry.getAttribute(k));
        g.setIndex(mesh.geometry.getIndex());
        g.boundingSphere = mesh.geometry.boundingSphere;
        const o = new THREE.Mesh(g, [hlMat]);
        o.visible = false;
        o.renderOrder = 5;
        o.name = 'highlight:' + id;
        o.userData.ranges = mesh.userData.src.ranges;
        group.add(o);
        overlays.push(o);
    }

    let time = 0;
    return {
        group, meshes, materials,
        setHighlight(indices, color = 0x7fdcff) {
            const set = indices == null ? null : new Set(Array.isArray(indices) ? indices : [indices]);
            hlMat.color.set(color);
            for (const o of overlays) {
                o.geometry.clearGroups();
                if (set) for (const r of o.userData.ranges) if (set.has(r.blockIndex)) o.geometry.addGroup(r.start, r.count, 0);
                o.visible = o.geometry.groups.length > 0;
            }
        },
        padGlow: 0.35,
        setGlow(k) {
            for (const m of materials) if (m.userData.glowable) m.emissiveIntensity = k;
            // Pads glow a little less at night, where emissive dominates.
            this.padGlow = k > 0.5 ? 0.28 : 0.35;
        },
        update(dt) {
            time += dt;
            // Pads breathe so they read as active from a distance.
            const p = this.padGlow * (0.75 + 0.25 * Math.sin(time * 4));
            for (const m of materials) if (m.userData.pad) m.emissiveIntensity = p;
            hlMat.opacity = 0.42 + 0.16 * Math.sin(time * 6);
        },
        dispose() {
            group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
            for (const m of materials) {
                for (const k of ['map', 'emissiveMap']) if (m[k] && m[k].isTexture) m[k].dispose();
                m.dispose();
            }
            hlMat.dispose();
        },
    };
}
