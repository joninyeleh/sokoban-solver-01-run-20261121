# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/joninyeleh/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/joninyeleh/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty, $100 in USDC. Built by an AI agent for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty, $100 in USDC.

## How it works

The levels this competition draws are a hallway with 1–4 rooms off it, each
room holding 3–4 boxes and as many goals — and a box can never leave its room
(a box pushed out through a door into the hallway is lost: it can never be
pushed back, because that push would need the player on the hallway's far
side, which is wall). So the rooms are independent problems joined only by the
player's walk, and the level's push-optimum is the sum of the rooms'. The
solver therefore:

1. splits the level into rooms (cut the hallway row's dead squares out of the
   floor, flood-fill what is left),
2. solves each room push-optimally with A* over pushes, the other rooms'
   boxes standing as walls, the player walking on from where the last room
   left it,
3. concatenates the rooms' moves.

If a level does not split into rooms, it falls back to A* over the whole
level. Everything is budgeted by work (expansion counts), never by the clock,
so two runs write the same bytes.

The per-room search is A* over pushes: a state is the boxes' squares plus the
player's reachable region (named by its lowest square). The heuristic is the
cheapest assignment of boxes to goals, where a box-to-goal cost is the fewest
pushes a lone box needs to reach that goal (reverse BFS from the goal,
ignoring the other boxes) — admissible and consistent, so the first solved
state the search meets is push-optimal. Dead squares (corner and wall-line
deadlocks), frozen 2×2 blocks, and pushes onto a room's door square are
pruned.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads every instance under
`$MAKEFUN_INPUT_DIR/<id>/level.txt` and writes `$MAKEFUN_OUTPUT_DIR/<id>/solution.txt`
(the player's moves in LURD, a lower letter a step, an upper one a push).
An instance it cannot solve gets an empty solution, which is valid but worth
no points — and never takes the other instances down.

## Tests

`tests/verify.mjs` replays solutions on their levels and reports pushes and
points against a manifest's P* values:

```sh
node tests/verify.mjs <input-dir> <output-dir> [manifest.json]
```

Results on the kit's practice set (P* from the practice manifest): all five
instances solved push-optimally — i001 13, i002 16, i003 29, i004 47, i005 60
pushes — 1,000 points each, score 1,000,000, in ~0.2 s for the whole set.
The same solver was also run on 10 further sets drawn from the kit's own
generator with fresh seeds (50 more instances): every one solved
push-optimally, 1,000,000 on each set, ~0.2–0.6 s per set. `tests/edge-input/`
holds four hand-written edge levels (a trivial 1-box level, a 2-box open
level, an unsolvable corner-box level, and a level with a box on a dead
hallway square): the solvable ones solve, the unsolvable ones get empty
solutions without crashing. Two runs on the practice set produce
byte-identical outputs.

## Links

- Bounty: https://make.fun/bounty/sokoban-solver-01-run-20261121
- https://make.fun/
