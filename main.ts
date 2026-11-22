// Sokoban solver: push-optimal A* over rooms.
//
// Strategy (written from scratch for this competition):
//   The levels this competition draws are a hallway with 1-4 rooms off it, each
//   room holding 3-4 boxes and as many goals, and a box can never leave its room
//   (a box pushed out through a door into the hallway is lost: it can never be
//   pushed back, because that push would need the player on the hallway's far
//   side, which is wall). So the rooms are independent problems joined only by
//   the player's walk, and the level's push-optimum is the sum of the rooms'.
//   This solver therefore:
//     1. splits the level into rooms (cut the hallway row's dead squares out of
//        the floor, flood-fill what is left),
//     2. solves each room push-optimally with A* over pushes, the other rooms'
//        boxes standing as walls, the player walking on from where the last
//        room left it,
//     3. concatenates the rooms' moves.
//   If a level does not split into rooms, it falls back to A* over the whole
//   level. Everything is budgeted by work (expansion counts), never by the
//   clock, so two runs write the same bytes.
//
// The search, per room (or whole level):
//   * States are pushes, not steps: a state is the boxes' squares plus the
//     player's reachable region (named by its lowest square). A push is a box
//     moving one square with the player standing behind it.
//   * A* with an admissible, consistent heuristic: the cheapest assignment of
//     boxes to goals, where a box-to-goal cost is the fewest pushes a lone box
//     needs to reach that goal (reverse BFS from the goal, ignoring the other
//     boxes). One push moves one box one square, so the assignment cost can
//     change by at most one per push: the heuristic never overestimates and
//     never falls by more than the step cost, so the first solved state the
//     search meets is push-optimal. (For more than 6 boxes the assignment is
//     replaced by the sum of the boxes' cheapest single-goal costs, which is
//     likewise admissible and consistent and cheaper to compute.)
//   * Dead squares are pruned: a square from which no lone box can be pushed
//     onto any goal (reverse-push BFS from the goals). That covers corner and
//     wall-line deadlocks.
//   * Frozen 2x2 blocks are pruned: four squares of walls and boxes holding a
//     box off its goal can never move again.
//   * A box is never pushed onto its room's door square: after such a push the
//     player stands inside the room with the box blocking the only way out,
//     so the state is a dead end. (And a box in the hallway is already pruned
//     as a dead square.)
//
// Node 22 runs this file as it is (erasable TypeScript only, standard library
// only). Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input
// MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** [dx, dy, walk letter, push letter] — fixed order, so every tie breaks the same way. */
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** Work budgets, counted in state expansions — never the clock, so runs are deterministic. */
const ROOM_EXPANSIONS = 300_000;
const WHOLE_EXPANSIONS = 500_000;
const TOTAL_EXPANSIONS = 3_000_000;

/** Debug logging, only when SOKOBAN_DEBUG is set (never in the graded run). */
const DEBUG = !!process.env.SOKOBAN_DEBUG;
const dbg = (...args: unknown[]): void => {
  if (DEBUG) console.error('[sokoban]', ...args);
};

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (short rows and the outer frame count as walls)
  goals: number[];
  boxes: number[]; // sorted
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  doors: number[]; // room squares touching the hallway: boxes may never be pushed onto these
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * For each goal, the fewest pushes a lone box needs to reach it from every
 * square (reverse BFS over pushes, the other boxes ignored, so the player is
 * only ever blocked by walls). dist[g][s] is -1 where a box at s can never
 * reach goal g. A square is live when some goal's distance from it is >= 0.
 */
function pushDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const size = wall.length;
  return goals.map((goal) => {
    const dist = new Int32Array(size).fill(-1);
    dist[goal] = 0;
    const queue = [goal];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const y = x - d;
        // A box at y can be pushed to x when the player can stand at y - d.
        if (wall[y] || wall[y - d] || dist[y] >= 0) continue;
        dist[y] = dist[x]! + 1;
        queue.push(y);
      }
    }
    return dist;
  });
}

/** The squares the player reaches from `from` around walls and boxes, and the lowest of them. */
function regionLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes holding a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The cheapest assignment of boxes to goals over `cost` (rows: boxes, columns: goals), by brute force. */
function assignmentCost(cost: number[][], n: number): number {
  // n <= 6 here, so trying every permutation is cheap and exact.
  const used = new Uint8Array(n);
  let best = Infinity;
  const go = (i: number, sum: number): void => {
    if (sum >= best) return;
    if (i === n) {
      best = sum;
      return;
    }
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const c = cost[i]![j]!;
      if (c === Infinity) continue;
      used[j] = 1;
      go(i + 1, sum + c);
      used[j] = 0;
    }
  };
  go(0, 0);
  return best;
}

/** A push-optimal solution of `level`: {pushes, moves} (moves in LURD, a lower letter a step, an upper one a push), or null. */
function solvePushOptimal(
  level: Level,
  maxExpansions: number,
  budget: { used: number; cap: number },
  forbidBox: Uint8Array | null,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = goals.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dists = pushDistances(level);
  const live = new Uint8Array(size);
  for (let s = 0; s < size; s++) {
    for (const dist of dists) if (dist[s] >= 0) { live[s] = 1; break; }
  }
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) {
    dbg('solvePushOptimal: a starting box is on a dead square');
    return null;
  }

  // The heuristic: the cheapest way to get every box onto a distinct goal.
  const heuristic = (boxes: number[]): number => {
    if (n <= 6) {
      const cost: number[][] = boxes.map((b) => dists.map((dist) => (dist[b] < 0 ? Infinity : dist[b])));
      return assignmentCost(cost, n);
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (const dist of dists) if (dist[b] >= 0 && dist[b] < m) m = dist[b];
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  // State key: the region's lowest square and the boxes' squares. Small
  // levels pack into one exact number; larger ones fall back to a string.
  const keyOf = (boxes: number[], low: number): number | string => {
    if (boxes.length <= 5 && size <= 256) {
      let k = low;
      for (const b of boxes) k = k * 256 + b;
      return k;
    }
    return String.fromCharCode(low, ...boxes);
  };

  // States in order found: boxes, the player's square, parent, the push that
  // made them, and the state's key. bestG/bestIdx remember the cheapest
  // generation of each key, so a state reached again with fewer pushes
  // re-opens (and the older, stale copy is skipped when it is popped).
  const sBoxes: number[][] = [level.boxes];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const sKey: (number | string)[] = [];
  const bestG = new Map<number | string, number>();
  const bestIdx = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = regionLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  sKey.push(keyOf(level.boxes, startLow));
  bestG.set(sKey[0]!, 0);
  bestIdx.set(sKey[0]!, 0);
  const h0 = heuristic(level.boxes);
  if (h0 === Infinity) {
    dbg('solvePushOptimal: heuristic is infinite at the start');
    return null;
  }

  // The open list: a binary heap on [f, h, insertion order, state].
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  heapPush([h0, h0, seq++, 0]);
  let expanded = 0;
  let found = solved(level.boxes) ? 0 : -1;
  while (heap.length > 0 && found < 0) {
    if (expanded >= maxExpansions || budget.used >= budget.cap) {
      dbg('solvePushOptimal: budget exhausted', { expanded, maxExpansions, used: budget.used, cap: budget.cap });
      return null;
    }
    const [, , , s] = heapPop();
    if (bestIdx.get(sKey[s]!) !== s) continue; // stale: a cheaper copy of this state exists
    const boxes = sBoxes[s]!;
    const g = sG[s]!;
    expanded++;
    budget.used++;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(level, occupied, sPlayer[s]!, seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        if (forbidBox !== null && forbidBox[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, bb) => a - bb);
          // The key's region is flood-filled into `mark`, a separate array:
          // it must not clobber `seen`, which still names this state's region
          // for the push-square checks of the remaining successors.
          key = keyOf(next, regionLow(level, occupied, b, mark, ++stamp, stack));
          h = heuristic(next);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        const prevG = bestG.get(key);
        if (prevG !== undefined && prevG <= g + 1) continue;
        const tIdx = sBoxes.length;
        sBoxes.push(next!);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(k);
        sG.push(g + 1);
        sKey.push(key);
        bestG.set(key, g + 1);
        bestIdx.set(key, tIdx);
        heapPush([g + 1 + h, h, seq++, tIdx]);
        if (solved(next!)) {
          found = tIdx;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) {
    dbg('solvePushOptimal: heap emptied without a solution', { expanded, states: sBoxes.length });
    return null;
  }

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    const from = sFrom[s]!;
    const k = sDir[s]!;
    const [dx, dy] = DIRS[k]!;
    const d = dy * w + dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[k]![3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room, its squares, boxes and goals, and the door squares
 * where it touches the hallway. Null when some part holds more or fewer boxes
 * than goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const dists = pushDistances(level);
  const live = new Uint8Array(wall.length);
  for (let s = 0; s < wall.length; s++) {
    for (const dist of dists) if (dist[s] >= 0) { live[s] = 1; break; }
  }
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], doors: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  // A room of the levels this competition draws sits wholly on one side of
  // the hallway (its door in the row beside it). A part straddling the
  // player's row is no such room: fall back to the whole level instead.
  for (const r of rooms) {
    let above = false;
    let below = false;
    for (const s of r.squares) {
      if (Math.floor(s / w) < row) above = true;
      if (Math.floor(s / w) > row) below = true;
    }
    if (above && below) return null;
  }
  // A room's doors: its squares touching the cut-out hallway row.
  for (const r of rooms) {
    for (const s of r.squares) {
      for (const [dx, dy] of DIRS) {
        if (cut[s + dy * w + dx]) {
          r.doors.push(s);
          break;
        }
      }
    }
  }
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's.
 * Null when a room's search gives up, or the level is no set of rooms and the
 * search over the whole level gives up.
 */
function solve(level: Level, budget: { used: number; cap: number }): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  dbg('solve: rooms =', rooms === null ? 'null (whole-level fallback)' : rooms.map((r) => ({ boxes: r.boxes.length, goals: r.goals.length, doors: r.doors, squares: r.squares.length })));
  if (rooms === null) {
    return solvePushOptimal(level, WHOLE_EXPANSIONS, budget, null);
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const wall = level.wall.slice();
    for (let oi = 0; oi < rooms.length; oi++) {
      if (oi === ri) continue;
      const other = rooms[oi]!;
      for (const b of oi < ri ? other.goals : other.boxes) wall[b] = 1;
    }
    const forbidBox = new Uint8Array(level.wall.length);
    for (const d of room.doors) forbidBox[d] = 1;
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, ROOM_EXPANSIONS, budget, forbidBox);
    if (solved === null) {
      dbg('solve: room', ri, 'failed (boxes', room.boxes.length, ')');
      return null;
    }
    dbg('solve: room', ri, 'solved in', solved.pushes, 'pushes');
    pushes += solved.pushes;
    moves += solved.moves;
    // Where the room's moves leave the player (walk the moves, case aside).
    for (const ch of solved.moves.toLowerCase()) {
      player += ch === 'u' ? -level.w : ch === 'd' ? level.w : ch === 'l' ? -1 : 1;
    }
  }
  return { pushes, moves };
}

const budget = { used: 0, cap: TOTAL_EXPANSIONS };
for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    const solved = solve(level, budget);
    if (solved !== null) moves = solved.moves;
    dbg(id, '=>', solved === null ? 'FAILED' : `${solved.pushes} pushes, ${moves.length} moves`);
  } catch (e) {
    dbg(id, '=> EXCEPTION', e instanceof Error ? e.message : String(e));
    // Any failure on one instance must not take the others down: an empty
    // answer is valid, worth no points but still answered in format.
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
