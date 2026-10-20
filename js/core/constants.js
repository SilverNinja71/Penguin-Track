// Units, limits and shared vocabulary of the deterministic core.
// The binding description lives in docs/ARCHITECTURE.md and docs/CORE_API.md.

// Time: fixed 100 Hz simulation.
export const TICK = 0.01;
export const TICK_MS = 10;
export const TICKS_PER_SECOND = 100;

// Block grid. Cell (x, y, z) spans [32x, 32x+32) × [8y, 8y+8) × [32z, 32z+32).
export const CELL = 32;
export const LAYER = 8;
export const MAP_X = 48;
export const MAP_Y = 32;
export const MAP_Z = 48;

export const STEER_MAX = 65536;

// Cardinal headings, clockwise seen from above. Right turn: d -> (d + 1) % 4.
export const DIRS = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]];
export const DIR_NAMES = ['+Z', '-X', '-Z', '+X'];

// Road cross-section (metres). The drivable deck is centred in the 32 m cell;
// snowbank borders sit just outside it, leaving a 2 m margin to the cell edge.
export const ROAD_WIDTH = 24;
export const ROAD_HALF = ROAD_WIDTH / 2;
export const BORDER_WIDTH = 2;
export const BORDER_HEIGHT = 1.2;
export const BORDER_SLANT = 0.3;     // the snowbank's inner face leans outward by this much
export const DECK_THICKNESS = 1.5;
export const NARROW_WIDTH = 10;
export const ROAD_OUTER = ROAD_HALF + BORDER_WIDTH;   // 14: half-width including borders

// Deep-snow ground, flush with level-0 decks (their slabs are buried in it), so a
// car leaving or rejoining the track at level 0 meets no step. Below FALL_Y is out.
export const GROUND_Y = 0;
export const FALL_Y = -40;

// Collision surface ids. Triangles store the index into this array.
export const SURFACE_IDS = ['snow', 'powder', 'ice', 'ground', 'wall'];
export const SURFACE_INDEX = { snow: 0, powder: 1, ice: 2, ground: 3, wall: 4 };
export const ROAD_SURFACES = ['snow', 'powder', 'ice'];

export const MOODS = ['day', 'sunset', 'night', 'aurora'];
export const MODES = ['race', 'platform'];

// Special pad effects carried by trigger boxes of type 'effect'.
export const EFFECTS = ['turbo', 'turbo2', 'noEngine', 'noSteer', 'noBrake', 'slowmo', 'cruise', 'fragile', 'reset'];

export const TRACK_FORMAT = 1;
