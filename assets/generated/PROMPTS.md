# Generated Asset Prompts

## 2026-10-20 - 0.2 brand set (UI-S12)

- Tool mode: Codex built-in `image_gen`, one image per call, three candidates per asset, `transparent_background=false`; the user ran the generation from the 0.2 asset brief (a private planning note, not in the repository). Raw candidates and the full call log stay outside the repo (`assets/incoming/`, untracked).
- References: every call after the mark used the selected mark (candidate 1) as a reference image; the light illustration also used the selected dark illustration, to keep the composition.
- The tool has no size parameter: every output came back at 1254×1254 (square) or about 1586×992 / 1610×977 (landscape), so all sizes below are set in post-processing.

| Output                                                                               | Selected                                           | Post-processing                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emperor-mark.svg` (also `desktop/src/renderer/public/favicon.svg`, `BrandMark.vue`) | mark candidate 1                                   | Redrawn by hand as five vector shapes on the 1254 px grid (frame, hexagon node, crown line, two mirrored emblem halves); 98.1% pixel overlap with the keyed original. Single fill `#D4AA5E`.                                                                                                                                                                                                          |
| `desktop/build/icon.png`, `desktop/extension/icons/icon-{16,32,48,128}.png`          | app icon candidate 3                               | Green screen keyed out by greenness with the green unmixed from edge pixels (soft tile edge, no green fringe), tile fitted to 824×824 at 100 px margins on a transparent 1024×1024 canvas (the macOS icon grid), then scaled down for the extension.                                                                                                                                                  |
| `model-setup-hero-dark.webp`, `model-setup-hero-light.webp`                          | dark candidate 2, light candidate 2                | Scaled to cover 1600×1000 (Lanczos, ×1.009) and centre-cropped, WebP quality 84 method 6 (53 KB / 38 KB, from about 1.7 MB PNG each).                                                                                                                                                                                                                                                                 |
| `desktop/build/background.tiff`                                                      | DMG candidate 2 (not the tool's pick, candidate 1) | 1610×977 scaled straight to 1320×800 and 660×400 (Lanczos; 1.648 vs 1.65, a 0.1% stretch), merged with `tiffutil -cathidpicheck` into one HiDPI TIFF. Candidate 2's thin open arrowhead matches the app's 1.5-stroke icons, and its seal watermark sits lower and smaller, clear of the Applications icon; candidate 1's filled arrowhead was heavier and its watermark reached into the icon's area. |

Retired: `emperoragent-wordmark.png`, `emperor-agent-logo-mark.png`, `model-setup-modal-hero-v2.png` (their entries below are history). Usage rules: [docs/design/brand.md](../../docs/design/brand.md).

### Mark — final prompt

```text
Use case: logo-brand
Asset type: brand mark for "Emperor", a local-first AI agent desktop app for macOS
Primary request: Design a minimal, timeless brand mark that reads as a modern imperial seal. A softly rounded square seal outline (like a carved stone chop seen from the front) containing one bold abstract emblem: a few precise geometric strokes suggesting authority and order — for example a strong horizontal crown line above a balanced symmetric structure, with one small hexagonal node at its center as a quiet nod to an AI agent. It must be abstract: it must not form any readable letter, Chinese character or number.
Scene/backdrop: perfectly flat solid #00ff00 chroma-key background for background removal.
Subject: the standalone mark only, centered, no words.
Style/medium: flat vector logo, crisp geometric shapes, at most two stroke weights, no gradients, no bevel, no texture, no shadow. Designed to be redrawn as SVG.
Composition/framing: square, centered, generous padding (mark occupies about 70% of the canvas), perfectly symmetric left-right. Must stay legible at 16px and 24px: no tiny details, no thin hairlines, no more than about 8 distinct shapes.
Color palette: single solid antique gold #D4AA5E for the mark; nothing else. Do not use #00ff00 in the subject.
Constraints: background must be one uniform #00ff00 with no shadows, gradients, texture, reflections or lighting variation; crisp edges fully separated from the background; no watermark; no text.
Avoid: maze patterns, dense ornament, dragons, crowns drawn literally, faces, swords, shields, laurel wreaths, 3D effects, metallic shine, purple or blue, stock-logo clichés.
```

### App icon — final prompt (reference: the selected mark)

```text
Use case: app-icon
Asset type: macOS application icon for "Emperor", a local-first AI agent desktop app
Primary request: Create a premium macOS app icon using exactly the brand mark from the reference image (the attached emperor-mark.png): the same seal shape and emblem, unchanged in geometry. Place it on a dark graphite squircle tile.
Scene/backdrop: perfectly flat solid #00ff00 chroma-key background outside the tile.
Subject: one macOS-style rounded-square (squircle) tile, 824x824 px centered on a 1024x1024 canvas (100 px margin on every side), with the mark centered on it at about 56% of the tile width.
Style/medium: refined, restrained material finish in the spirit of current macOS icons: the tile is deep warm graphite (#1A1A19 at the bottom easing to #26261F at the top) with a very subtle top highlight and a faint 1px inner edge; the mark is satin antique gold (#D4AA5E with gentle tonal variation toward #B8873A), slightly raised with a soft, short shadow on the tile. Calm, expensive, quiet.
Composition/framing: front view, perfectly centered, symmetric, no perspective tilt.
Constraints: everything outside the squircle is uniform #00ff00 with no shadow spilling onto it; crisp tile edge; no text, no letters, no numbers, no watermark.
Avoid: bright yellow gold, glitter, glowing neon, heavy bevels, busy textures, extra decorations around the mark, blue or purple tones, a frame or ring around the tile.
```

### Onboarding illustration — final prompt (dark; the light version swaps only the palette line)

```text
Use case: productivity-visual
Asset type: onboarding illustration for the "connect a model" dialog of Emperor, a local-first AI agent desktop app
Primary request: A calm, elegant still life that captures the moment an AI workbench comes alive after a model is connected: a small precise object — a softly lit stone-like seal block bearing the Emperor mark (reference: emperor-mark.png) — resting on a clean surface, with two or three thin floating cards beside it showing abstract UI lines (no readable text) and a single thread of light connecting a small key-shaped token to the seal.
Scene/backdrop: seamless studio surface, no room, no device frame, no browser chrome.
Style/medium: refined 3D product illustration, soft global light, matte materials, very few objects, lots of negative space. Premium and quiet, like an Apple product page still.
Composition/framing: wide 16:10 landscape; main object center-right; the left 40% stays nearly empty so the dialog text can sit beside it when cropped.
Color palette (dark version): background #141413 to #1A1A19, warm graphite surfaces, satin antique gold #D4AA5E accents, one tiny muted green status light; no other colors.
Constraints: no readable letters, numbers or logos other than the Emperor mark; no people, no animals, no mascot; no watermark.
Avoid: clutter, many floating panels, neon glow, sci-fi, purple or blue gradients, bokeh orbs, heavy ornament, dashboard screenshots.
```

Light palette line:

```text
Color palette (light version): background #F6F5F2 to #EFEEEA, warm ivory and light stone surfaces, antique gold #B8873A accents, one tiny muted green status light; no other colors.
```

### DMG background — final prompt (reference: the selected mark)

```text
Use case: installer-background
Asset type: macOS DMG installer window background for Emperor
Primary request: A very quiet background for a drag-to-install window. Warm ivory paper (#F6F5F2) with an extremely faint, large debossed Emperor seal mark (reference: emperor-mark.png) bleeding off the bottom-right corner at about 4% contrast, and one thin, elegant antique-gold (#B8873A) arrow in the exact center pointing from left to right, about 160 px long at this resolution.
Composition/framing: 1320x800 px; keep the two circular areas centered at (330, 400) and (990, 400), each 260 px wide, completely empty and flat (the system draws the app icon and the Applications folder there).
Style/medium: minimal print-like design, subtle paper grain at most, no shadows.
Constraints: no text, no icons, no folder drawings, no watermark.
Avoid: gradients with strong contrast, dark backgrounds, decorative borders, glows.
```

## 2026-07-07 - `model-setup-modal-hero-v2.png`

- Tool mode: built-in `image_gen`
- Output: `assets/generated/model-setup-modal-hero-v2.png`
- Source handling: generated by the built-in image tool under `$CODEX_HOME/generated_images/...`, then copied into the project asset directory.

Final prompt:

```text
Use case: productivity-visual
Asset type: playful model setup onboarding modal hero for Emperor Agent desktop app
Primary request: Create a more memorable and slightly playful promotional hero image for a model-configuration onboarding modal. The image should feel like the moment a local AI agent workbench is powered on after connecting a model.
Scene/backdrop: dark graphite miniature command desk, no browser chrome, no device frame, no physical room, no readable text.
Subject: a stylized local AI command console built around an imperial command-seal logo motif: a compact glowing local runtime cube on the desk, a model key being inserted into a small console slot, floating task cards and tool tiles snapping into place, subtle project memory rings, scheduler dots, and a chat panel lighting up. Use abstract UI glyphs only, no readable letters or numbers.
Style/medium: high-end 3D-ish product illustration with crisp UI surfaces, slightly playful interaction metaphor, premium desktop software onboarding art. Not a plain screenshot; make it feel like a small elegant machine waking up.
Composition/framing: wide landscape 16:10, strong central object, usable when cropped on the right side of an 860px onboarding modal. Keep the main glowing console and key in the center-right, with subtle floating panels around it. Generous dark negative space at left edge for modal blending.
Lighting/mood: quietly exciting, capable, local-first, polished, a bit magical but restrained.
Color palette: near-black graphite, charcoal, antique gold #c69b45, muted emerald status lights, warm ivory highlights, tiny cinnabar accent. Avoid purple/blue gradients and bright neon.
Materials/textures: matte glass, brushed dark metal, carved gold seal details, soft glow, thin UI borders, premium app icon finish.
Text (verbatim): no text at all.
Constraints: no readable letters, no numbers, no watermark, no humans, no mascot, no animals, no fantasy palace, no ornate decoration, no decorative orbs, no bokeh blobs. Keep it product-grade and elegant, but more imaginative than a normal dashboard screenshot.
Avoid: generic SaaS dashboard, flat screenshot mockup, purple gradients, beige parchment, clutter, fake words, cute cartoon mascot, sci-fi helmet, heavy royal ornament.
```

## 2026-06-22 - `emperor-agent-logo-mark.png`

- Tool mode: built-in `image_gen` with chroma-key removal and transparent PNG post-process.
- Output: `assets/generated/emperor-agent-logo-mark.png`
- Source handling: generated on a flat `#00ff00` chroma-key background, removed with `remove_chroma_key.py`, then cropped to transparent content bounds.

Final prompt:

```text
Use case: logo-brand
Asset type: UI brand logo mark for a local AI agent desktop app
Primary request: Create a refined square brand mark for "Emperor Agent". The mark should feel like a modern command seal combined with a minimal AI/workbench symbol: a geometric imperial seal outline, subtle hexagonal structure, precise linework, premium but restrained.
Scene/backdrop: perfectly flat solid #00ff00 chroma-key background for background removal.
Subject: standalone logo mark only, no words, no letters, no characters.
Style/medium: polished vector-friendly raster logo, crisp edges, minimal geometric line art with slight dimensional polish.
Composition/framing: centered square icon, generous padding, readable at 32px and 128px.
Color palette: antique gold #c69b45, warm off-white highlights, deep graphite accents; do not use #00ff00 in the subject.
Constraints: background must be one uniform #00ff00 color with no shadows, gradients, texture, reflections, floor plane, or lighting variation. Keep subject fully separated from background with crisp edges. No cast shadow, no contact shadow, no watermark, no text.
Avoid: dragons, crowns, literal emperor face, cartoon style, ornate decoration, complex tiny details, purple gradients, stock-logo look.
```

## 2026-10-21 - `readme-product-hero.png` (REL-06)

- Replaced the generated illustration below with a real screenshot of the 0.2 interface: `desktop/screenshots/dsh-v1/app-chat-bottom-dark.png` (1440×900, dark theme), written by `desktop/tests/visual/dsh-v1.spec.ts` › "app chat renders the raw session log (dark)" from the visual fixtures. Copied unchanged; to refresh it, run the visual suite and copy that file again.

## 2026-06-23 - `readme-product-hero.png` (retired)

- Tool mode: built-in `image_gen`
- Output: `assets/generated/readme-product-hero.png`
- Source handling: generated by the built-in image tool under `$CODEX_HOME/generated_images/...`, then copied into the project asset directory.

Final prompt:

```text
Use case: productivity-visual
Asset type: README hero image for Emperor Agent, a local AI agent desktop app
Primary request: Create a polished product hero scene for a README. Show a refined dark desktop application interface inspired by Codex: compact left sidebar, central chat workspace, bottom composer, subtle project/build context panel, and small status cards. It should feel like a real local AI engineering workbench, quiet and technical, with a restrained imperial command-seal mood.
Scene/backdrop: wide cinematic desktop UI scene on a dark neutral background, no browser chrome, no device frame, no real brand logos.
Subject: the Emperor Agent product experience: local agent workspace, chat/build sessions, project memory, scheduler and tools represented visually without readable text.
Style/medium: high-end raster product illustration, clean UI mockup, crisp edges, realistic but not photoreal, suitable for GitHub README cover.
Composition/framing: wide landscape composition, 16:9, central product UI with generous top/bottom breathing room, subtle depth, no split layout.
Lighting/mood: calm, focused, premium, low contrast, soft graphite shadows.
Color palette: near-black #0f1115, graphite #1c2027, muted slate, antique gold accents #c69b45, small emerald status lights; avoid purple/blue gradients.
Materials/textures: matte glass panels, thin borders, subtle metal seal accents, no paper texture.
Text (verbatim): no text at all.
Constraints: no readable text, no letters, no numbers, no logos, no watermark, no mascot, no human figures, no duplicate seal icons. Keep it minimal and professional.
Avoid: ornate imperial decoration, cartoon style, stock mockup look, oversized cards, gradient orbs, bokeh blobs, purple gradients, beige parchment, heavy shadows.
```

## 2026-06-22 - `emperoragent-wordmark.png`

- Tool mode: built-in `image_gen` with chroma-key removal and transparent PNG post-process.
- Output: `assets/generated/emperoragent-wordmark.png`
- Source handling: generated on a flat `#00ff00` chroma-key background, removed with `remove_chroma_key.py`, then cropped to transparent content bounds.

Final prompt:

```text
Use case: logo-brand
Asset type: horizontal UI wordmark image for the Emperor Agent desktop app
Primary request: Create a polished artistic wordmark with the exact text "emperoragent" as one lowercase word. It should pair with a restrained dark Codex-style UI: premium, quiet, technical, slightly imperial.
Scene/backdrop: perfectly flat solid #00ff00 chroma-key background for background removal.
Subject: exact wordmark text "emperoragent" only, no spaces, no subtitle, no extra words. A tiny abstract seal accent before the text is allowed only if it does not change the word.
Style/medium: custom lettering, sharp modern serif-sans hybrid, high legibility at small UI sizes, subtle engraved antique-gold treatment without excessive shine.
Composition/framing: horizontal transparent-ready lockup, centered, generous padding, suitable for app empty states and sidebar header.
Color palette: antique gold #c69b45 for primary strokes, warm off-white inner highlights, small graphite shadow accents; do not use #00ff00 in the lettering.
Text (verbatim): "emperoragent"
Constraints: Render the text exactly as "emperoragent" with correct spelling, all lowercase, no spaces. The background must be one uniform #00ff00 color with no shadows, gradients, texture, reflections, floor plane, or lighting variation. Keep the lettering fully separated from background with crisp edges. No cast shadow, no contact shadow, no watermark.
Avoid: misspelled text, extra slogans, spaces between emperor and agent, uppercase letters, Chinese characters, crowns, faces, cartoon look, purple gradients, overly ornate calligraphy, thin unreadable hairlines.
```

## 子智能体头像图集（SUB-30，2026-10-21）

`subagent-avatars/*-sheet-1254.webp` 是生图原图（1254×1254 无损 WebP，四张共约 5 MB），`frames-1254.json` 是在原图上量出的 36 个头像框。应用里用的是缩小后的版本 `desktop/src/renderer/src/assets/subagent-avatars/`：

头像是透明底（UI-S13）：原图的米色底和每个头像下的投影用 `subagent-avatars/matte.py` 抠掉。和底色相近且不比底色亮、或比底色暗的平滑灰色（投影），只要和图边连通就算背景；先把候选区收窄 3 px 再从图边扩张，白色机器人、幽灵这类表面光滑的头像不会从窄缝漏进去；边缘按颜色差给半透明，并把底色从半透明像素里减掉。缩小时用预乘透明度，边缘不带杂色：

```sh
python3 -I -c "import importlib.util as u; s=u.spec_from_file_location('m','matte.py'); m=u.module_from_spec(s); s.loader.exec_module(m); m.matte('X-sheet-1254.webp','X.png')"
python3 -I -c "from PIL import Image; Image.open('X.png').convert('RGBa').resize((448,448), Image.LANCZOS).convert('RGBA').save('X-sheet.webp','WEBP',quality=90,alpha_quality=95,method=6)"
```

头像框按 448 / 1254 等比缩放并取整（`frames.json`）。四张合计约 225 KB；每个头像约 110–160 px，够 40 px 头像在 2 倍屏上显示。以后重新裁框，在原图上量，再按同样比例换算；换了原图要重新抠底，并在深色与浅色背景上逐个看一遍（`tests/visual/subagent-avatars.spec.ts` 检查每张图角落透明、每个头像中心不透明）。
