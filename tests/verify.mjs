// Independent replay verifier for Sokoban solutions (written for testing this
// entry; it is not part of the entry's runtime). Replays a solution.txt on its
// level.txt exactly as the competition's checker does: every step must be a
// legal walk or push, and the replay must end with every box on a goal.
// Usage: node tests/verify.mjs <input-dir> <output-dir> [manifest.json]
//   Prints one line per instance: id, moves, pushes, solved?, points vs P*.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const inputDir = process.argv[2];
const outputDir = process.argv[3];
const manifestPath = process.argv[4];

const STEP = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };

function parse(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * rows.length).fill(1);
  const goal = new Uint8Array(w * rows.length);
  const box = new Uint8Array(w * rows.length);
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if ('.*+'.includes(ch)) goal[i] = 1;
      if ('$*'.includes(ch)) box[i] = 1;
      if ('@+'.includes(ch)) player = i;
    }
  });
  return { w, wall, goal, box, player };
}

let keys = {};
if (manifestPath && existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const inst of manifest.instances) keys[inst.id] = inst.key.pushes;
}

let totalPoints = 0;
let count = 0;
for (const id of readdirSync(inputDir).sort()) {
  const level = parse(readFileSync(join(inputDir, id, 'level.txt'), 'utf8'));
  const solPath = join(outputDir, id, 'solution.txt');
  if (!existsSync(solPath)) {
    console.log(`${id}: MISSING solution.txt`);
    continue;
  }
  const moves = readFileSync(solPath, 'utf8').replace(/\s+/g, '');
  const odd = /[^udlrUDLR]/.exec(moves);
  if (odd !== null) {
    console.log(`${id}: INVALID character ${JSON.stringify(odd[0])}`);
    continue;
  }
  const { w, wall, goal, box } = level;
  let player = level.player;
  let pushes = 0;
  let illegal = null;
  for (let k = 0; k < moves.length; k++) {
    const [dx, dy] = STEP[moves[k].toLowerCase()];
    const d = dy * w + dx;
    const next = player + d;
    if (wall[next]) { illegal = `move ${k + 1} (${moves[k]}) walks into a wall`; break; }
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) { illegal = `move ${k + 1} (${moves[k]}) pushes a box into ${wall[beyond] ? 'a wall' : 'another box'}`; break; }
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  const solved = !illegal && (() => { for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return false; return true; })();
  const pStar = keys[id];
  let points = 0;
  if (solved && pStar !== undefined) points = pushes <= pStar ? 1000 : Math.floor((500 * pStar) / pushes);
  if (solved) { totalPoints += points; count++; }
  console.log(
    `${id}: ${moves.length} moves, ${pushes} pushes, solved=${solved}` +
    (illegal ? `, ILLEGAL: ${illegal}` : '') +
    (pStar !== undefined ? `, P*=${pStar}, points=${points}` : ''),
  );
}
if (count > 0) console.log(`mean points over solved: ${(totalPoints / count).toFixed(1)} (score if all 5 answered: ${Math.round(1000 * (totalPoints / 5))})`);
