# 小单 desktop-pet sprites — dragon-robe outfit

The desktop pet in the emperor's outfit: an open gold dragon robe over the
everyday clothes and a small tilted crown. The same twelve actions as
`../xiaodan`, so any strip here can stand in for `xiaodan-<action>.webp`
one for one. Not wired into `desktop/src/pet/event-mapper.js` yet.

The art was generated on 2026-10-27 (v0.3 brand round, `PG-<action>.png`),
one row of poses per action on a flat green background, with the 小单 strips
as pose references. The generated rows are not kept in the repo;
`desktop/scripts/slice-pet-keyframes.mjs` keys, slices and scales them into
these strips, together with the everyday outfit in `../xiaodan-daily`.

## Format

- Every frame is one **192×208** cell; a strip is `frames × 192` wide and
  208 tall, with the frame counts of `SPRITES`.
- WebP, quality 90 with lossless alpha (Chromium's encoder, which adds an
  sRGB ICC chunk).
- 小单's white sticker outline: 3.6 px of (253, 253, 253) around the
  silhouette, crown included, a round dilation drawn under the character
  with an anti-aliased rim. Gaps narrower than about 7 px fill white, as on
  小单.
- The body is exactly as big as in `../xiaodan-daily` (one size for every
  strip of both outfits, measured to the top of the hair, so the crown sits
  on top): switching outfit never resizes the character. The crown and the
  third cheer frame (jumping, one arm up) are what set that size: with its
  outline that frame reaches row 1 of the cell.
- The bottom of the outline is on row 202, 小单's ground row, so the feet
  stand one outline width above it, as 小单's do. A strip's ground is its
  lowest foot, so jumps keep their height above it. Standing strips are
  centred on the feet, the others on the body's mass.

## Strips

| File                   | Source              | Frames | Action                       |
| ---------------------- | ------------------- | ------ | ---------------------------- |
| `robe-idle.webp`       | `PG-idle.png`       | 7      | standing                     |
| `robe-run.webp`        | `PG-run.png`        | 8      | running                      |
| `robe-walk.webp`       | `PG-walk.png`       | 8      | walking                      |
| `robe-wave.webp`       | `PG-wave.png`       | 4      | waving                       |
| `robe-cheer.webp`      | `PG-cheer.png`      | 5      | jumping for joy              |
| `robe-facepalm.webp`   | `PG-facepalm.png`   | 8      | surprised, then facepalm     |
| `robe-present.webp`    | `PG-present.png`    | 6      | explaining with an open hand |
| `robe-laptop.webp`     | `PG-laptop.png`     | 6      | working on a tablet          |
| `robe-think.webp`      | `PG-think.png`      | 6      | hand on chin                 |
| `robe-lookup.webp`     | `PG-lookup.png`     | 8      | turning to look up           |
| `robe-lookaround.webp` | `PG-lookaround.png` | 8      | looking around               |
| `robe-doze.webp`       | `PG-doze.png`       | 2      | dozing                       |

The robe's dragon pattern is busier than the brief asked for, and the fifth
think frame smiles a little more than the reference.

## Regenerate

```sh
cd desktop
node scripts/slice-pet-keyframes.mjs --in <folder with PA-*.png and PG-*.png> \
  --review <scratch folder>
```

It rewrites both outfit folders and, with `--review`, draws every strip on a
light and a dark background next to 小单's idle strip. It stops with the
action's name if a row does not split into the `SPRITES` frame count. The
output is deterministic for the same inputs; `src/pet/test/pet-strips.test.ts`
checks the strip sizes, alpha and frame counts.
