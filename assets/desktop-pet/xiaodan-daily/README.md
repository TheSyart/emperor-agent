# 小单 desktop-pet sprites — everyday outfit

The desktop pet in its everyday clothes: black T-shirt with a plain gold
square, black joggers, white trainers. The same twelve actions as
`../xiaodan`, so any strip here can stand in for `xiaodan-<action>.webp`
one for one. Not wired into `desktop/src/pet/event-mapper.js` yet.

The art was generated on 2026-10-27 (v0.3 brand round, `PA-<action>.png`),
one row of poses per action on a flat green background, with the 小单 strips
as pose references. The generated rows are not kept in the repo;
`desktop/scripts/slice-pet-keyframes.mjs` keys, slices and scales them into
these strips, together with the dragon-robe outfit in `../xiaodan-robe`.

## Format

- Every frame is one **192×208** cell; a strip is `frames × 192` wide and
  208 tall, with the frame counts of `SPRITES`.
- WebP, quality 90 with lossless alpha (Chromium's encoder, which adds an
  sRGB ICC chunk).
- 小单's white sticker outline: 3.6 px of (253, 253, 253) around the
  silhouette, a round dilation drawn under the character with an
  anti-aliased rim. Gaps narrower than about 7 px (between an arm and the
  body, a lens that sticks out past the face) fill white, as on 小单.
- One body size for every strip of both outfits, so switching outfit or
  action never resizes the character. Standing, the everyday character is
  175 px tall, 182 px with its outline (小单's idle: 198 px with its
  outline). It is no larger because the robe's cheer jump (crown and raised
  arm) must still fit the cell, outline included.
- The bottom of the outline is on row 202, 小单's ground row, so the feet
  stand one outline width above it, as 小单's do. A strip's ground is its
  lowest foot, so jumps keep their height above it. Standing strips are
  centred on the feet, the others on the body's mass.

## Strips

| File                    | Source              | Frames | Action                       |
| ----------------------- | ------------------- | ------ | ---------------------------- |
| `daily-idle.webp`       | `PA-idle.png`       | 7      | standing                     |
| `daily-run.webp`        | `PA-run.png`        | 8      | running                      |
| `daily-walk.webp`       | `PA-walk.png`       | 8      | walking                      |
| `daily-wave.webp`       | `PA-wave.png`       | 4      | waving                       |
| `daily-cheer.webp`      | `PA-cheer.png`      | 5      | jumping for joy              |
| `daily-facepalm.webp`   | `PA-facepalm.png`   | 8      | surprised, then facepalm     |
| `daily-present.webp`    | `PA-present.png`    | 6      | explaining with an open hand |
| `daily-laptop.webp`     | `PA-laptop.png`     | 6      | working on a tablet          |
| `daily-think.webp`      | `PA-think.png`      | 6      | hand on chin                 |
| `daily-lookup.webp`     | `PA-lookup.png`     | 8      | turning to look up           |
| `daily-lookaround.webp` | `PA-lookaround.png` | 8      | looking around               |
| `daily-doze.webp`       | `PA-doze.png`       | 2      | dozing                       |

The badge on the chest is not quite plain in `PA-run`/`PA-walk` (fine lines)
and `PA-wave`/`PA-cheer` (a seal-like pattern).

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
