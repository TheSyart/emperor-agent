# 小单 desktop-pet sprites

The desktop pet character. The art is a user-supplied sprite sheet
(1536×2288, 8 columns × 11 rows, transparent background), sliced on
2026-09-23 into one horizontal strip per action. The original sheet is not
kept: every strip is an exact crop of its cells, so the sheet can be rebuilt.

## Format

- Every frame is one **192×208** cell; a strip is `frames × 192` wide and
  208 tall. The character stands on the same baseline in every cell, so
  frames can be swapped without jitter.
- WebP, quality 90 with lossless alpha.
- The pet window and Settings › 桌宠 play a strip with CSS `steps()`; frame
  counts, fps and loop mode live in `desktop/src/pet/event-mapper.js`
  (`SPRITES`), which maps each runtime state to a strip (`ASSETS`).

## Strips

| File                      | Sheet cells (row, col) | Frames | Action                       |
| ------------------------- | ---------------------- | ------ | ---------------------------- |
| `xiaodan-idle.webp`       | row 0, cols 0–6        | 7      | standing                     |
| `xiaodan-run.webp`        | row 1, cols 0–7        | 8      | running                      |
| `xiaodan-walk.webp`       | row 2, cols 0–7        | 8      | walking                      |
| `xiaodan-wave.webp`       | row 3, cols 0–3        | 4      | waving                       |
| `xiaodan-cheer.webp`      | row 4, cols 0–4        | 5      | jumping for joy              |
| `xiaodan-facepalm.webp`   | row 5, cols 0–7        | 8      | surprised, then facepalm     |
| `xiaodan-present.webp`    | row 6, cols 0–5        | 6      | explaining with an open hand |
| `xiaodan-laptop.webp`     | row 7, cols 0–5        | 6      | working on a tablet          |
| `xiaodan-think.webp`      | row 8, cols 0–5        | 6      | hand on chin                 |
| `xiaodan-lookup.webp`     | row 9, cols 0–7        | 8      | turning to look up           |
| `xiaodan-lookaround.webp` | row 10, cols 0–7       | 8      | looking around               |
| `xiaodan-doze.webp`       | row 5, cols 1 and 7    | 2      | dozing                       |

To swap in a new sheet with the same grid, re-crop the same cells; a new
action only needs a new strip plus an entry in `SPRITES`.
