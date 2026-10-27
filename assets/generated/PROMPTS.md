# Generated Asset Prompts

## 2026-10-27 - 0.3 mark: the crown seal (BRD-02)

- Source: Codex built-in `image_gen`, one image, no reference image (`L-S-c1`, an app-logo exploration the user added to the 0.3 round): a three-point crown with a heavy band and a square notch at the centre of its foot, antique gold on a graphite rounded block, on a flat `#00ff00` background. Picked by the user over the round's four directions (geometric crown, the crown as an E, the crown in a block, the crown with glasses), which stay outside the repo with the raw output (`assets/incoming/v0.3/`).
- No bitmap from this round ships. Everything is vector, drawn by hand from the 1254 px original:
  - the crown: made symmetric about the original's axis, the three points rounded (quadratic corners), the side walls bending into verticals, the notch kept (104 of the crown's 850 units wide, 82 deep);
  - `emperor-mark.svg` (= `desktop/src/renderer/public/favicon.svg`, `BrandMark.vue`): one `evenodd` path, a 950-unit rounded block (radius 210) in `#D4AA5E` with the crown cut out at 62% scale; the user chose the cut-out block over the crown alone and a framed crown;
  - `emperor-app-icon.svg`: the 824 block of the macOS icon grid (radius 185) in a faint graphite gradient (`#2B2926` → `#1A1918`) wearing the same crown in `#D4AA5E` (64% of the block's width);
  - `desktop/build/icon.png` and `desktop/extension/icons/icon-{16,32,48,128}.png` are rendered from `emperor-app-icon.svg` by `desktop/scripts/render-brand-icons.mjs`, each size from the vector.
- Still from the 0.2 set and carrying the 0.2 seal: the DMG background's faint emboss and the first-run illustrations' carved stone (below); they are regenerated with the new mark as reference.

## 2026-10-20 - 0.2 brand set (UI-S12)

- Tool mode: Codex built-in `image_gen`, one image per call, three candidates per asset, `transparent_background=false`; the user ran the generation from the 0.2 asset brief (a private planning note, not in the repository). Raw candidates and the full call log stay outside the repo (`assets/incoming/`, untracked).
- References: every call after the mark used the selected mark (candidate 1) as a reference image; the light illustration also used the selected dark illustration, to keep the composition.
- The tool has no size parameter: every output came back at 1254×1254 (square) or about 1586×992 / 1610×977 (landscape), so all sizes below are set in post-processing.

| Output                                                                                                     | Selected                                           | Post-processing                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emperor-mark.svg` (also `desktop/src/renderer/public/favicon.svg`, `BrandMark.vue`) — replaced 2026-10-27 | mark candidate 1                                   | Redrawn by hand as five vector shapes on the 1254 px grid (frame, hexagon node, crown line, two mirrored emblem halves); 98.1% pixel overlap with the keyed original. Single fill `#D4AA5E`.                                                                                                                                                                                                          |
| `desktop/build/icon.png`, `desktop/extension/icons/icon-{16,32,48,128}.png` — replaced 2026-10-27          | app icon candidate 3                               | Green screen keyed out by greenness with the green unmixed from edge pixels (soft tile edge, no green fringe), tile fitted to 824×824 at 100 px margins on a transparent 1024×1024 canvas (the macOS icon grid), then scaled down for the extension.                                                                                                                                                  |
| `model-setup-hero-dark.webp`, `model-setup-hero-light.webp`                                                | dark candidate 2, light candidate 2                | Scaled to cover 1600×1000 (Lanczos, ×1.009) and centre-cropped, WebP quality 84 method 6 (53 KB / 38 KB, from about 1.7 MB PNG each).                                                                                                                                                                                                                                                                 |
| `desktop/build/background.tiff`                                                                            | DMG candidate 2 (not the tool's pick, candidate 1) | 1610×977 scaled straight to 1320×800 and 660×400 (Lanczos; 1.648 vs 1.65, a 0.1% stretch), merged with `tiffutil -cathidpicheck` into one HiDPI TIFF. Candidate 2's thin open arrowhead matches the app's 1.5-stroke icons, and its seal watermark sits lower and smaller, clear of the Applications icon; candidate 1's filled arrowhead was heavier and its watermark reached into the icon's area. |

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

## 联系人头像库（BRD-07，2026-10-27）

- 工具：Codex 内置 `image_gen`，一次一张，15 张九宫格（1536 × 1024，`#00ff00` 底）。参考图是吉祥物小单的 Q 版画风参考（只取画风，不画小单本人）；从 AV-02 起再附 AV-01 作第二参考图。AV-01 重出 3 次（背景不纯，后来放宽为目测绿底）、AV-09 重出 1 次（第 7 格性别与描述不符）、AV-14 重出 1 次（相机上疑似字母）。原图和被退回的图留在未跟踪的 `assets/incoming/v0.3/avatars/`，不进仓库。
- 后期：`contact-avatars/slice_sheets.py`。按「比红、蓝都绿多少」抠绿（浮点计算；整数会溢出）；九宫格不是严格三等分，所以先按整行空白分三行、再在每行里按整列空白分三列；每个头像只保留本格内容，裁成正方形；重新排成 576 × 576 的规整 3 × 3（每格 192，四边留 6），预乘透明度缩放，WebP 有损 82 / 透明 90。输出到 `desktop/src/renderer/src/assets/contact-avatars/`（15 张共约 1.3 MB）和 `manifest.json`（编号、所在图、格子、主题、中文名、底色）：

```sh
python3 -I assets/generated/contact-avatars/slice_sheets.py assets/incoming/v0.3/avatars desktop/src/renderer/src/assets/contact-avatars
```

- 编号按提示词里的顺序（从左到右、从上到下）：`AV-01-1 … AV-15-9`。界面只凭编号算出格子和底色（`components/ui/contactAvatars.ts`），清单只在头像库打开时加载。`contactAvatars.test.ts` 检查 15 张图、透明通道、135 条清单、编号与格子一致。

### 共用设定（每张都放在最前面）

```text
Use case: avatar-sheet
Asset type: a sheet of nine profile avatars for AI agent contacts in "Emperor", a macOS AI agent workbench. Each avatar will be shown as small as 28 px in a group chat, so every face and silhouette must read clearly when tiny.
Reference image 1: match this drawing style exactly — Q-version (chibi) characters with big heads, simple clean line art with slightly varied weight, warm cel shading with one shadow tone, friendly natural expressions. Do NOT draw the person in the reference image; draw the nine different characters listed below.
Reference image 2 (from AV-02 on): an earlier sheet from the same set — keep the same style, the same head size and the same spacing.
Layout: a 3x3 grid of nine separate head-and-shoulders portraits, evenly spaced, each centered in its own cell, all at the same scale (the head about 55% of the cell height), facing the viewer or turned slightly. Leave generous empty space between portraits; nothing crosses into a neighbouring cell. No grid lines, no frames, no circles or shapes behind the heads.
Variety: every character must be different at a glance — a distinctive hairstyle or headwear silhouette, and one signature accent color in the clothing.
Scene/backdrop: the whole canvas is perfectly flat solid #00ff00 chroma-key green, no shadows, no gradient.
Constraints: no readable text, letters or numbers anywhere (not on badges, books, screens or clothes); no company logos; no real people or celebrities; nothing in the characters uses #00ff00.
Avoid: 3D render, plush-toy look, realistic proportions, anime pretty-boy style, mixing different art styles, weapons pointed at the viewer, blood.
The nine characters, in reading order (left to right, top row first):
```

### 十五张九宫格

#### AV-01 · 工程（一）

```text
1. (架构师) A software architect, a woman in her thirties with a sharp short bob, holding a rolled blueprint over her shoulder, teal shirt.
2. (代码审稿人) A code reviewer, a man with round glasses and a neat side part, a red pencil tucked behind his ear, navy sweater.
3. (测试工程师) A test engineer, a young woman with a high ponytail, holding a small clipboard with check marks, green jacket.
4. (安全审计) A security auditor, a man with a buzz cut and a calm stare, dark hoodie with a small gold padlock pin, amber scarf.
5. (前端工程师) A frontend engineer, a young person in a knitted beanie with headphones around the neck, purple top.
6. (后端工程师) A backend engineer, a bearded man in a flannel shirt holding a coffee mug, brown tones.
7. (运维与发布) A release engineer, a woman with her hair in a bun, holding a tiny paper rocket, orange vest.
8. (数据工程师) A data engineer, a man with curly hair and a tie patterned with small dots, light blue shirt.
9. (移动端工程师) A mobile developer, a woman with two long braids holding a phone, coral cardigan.
```

#### AV-02 · 工程（二）

```text
1. (机器学习研究员) A machine-learning researcher, a woman with long straight hair holding a lab notebook, white lab coat over a teal top.
2. (算法专家) An algorithm expert, an older man with grey hair and a piece of chalk, tweed vest.
3. (数据库专家) A database specialist, a man in a cardigan with glasses pushed up on his head, olive green.
4. (性能调优) A performance tuner, a sporty woman with a headband holding a stopwatch, red track jacket.
5. (开源维护者) An open-source maintainer, a man with long hair in a low ponytail, laptop covered in blank round stickers, grey hoodie.
6. (技术文档) A technical writer, a woman with a pixie cut holding a fountain pen, mustard cardigan.
7. (自动化测试) A test-automation engineer, a young man with a backwards cap holding a small toy robot arm, lime t-shirt.
8. (值班工程师) An on-call engineer, a sleepy woman in a hoodie holding a phone, dark circles under her eyes, indigo.
9. (嵌入式工程师) A hardware engineer, a man with safety goggles on his forehead holding a soldering iron, khaki work shirt.
```

#### AV-03 · 设计与创意

```text
1. (素材设计师) An asset designer, a woman in a beret holding a small color palette, ochre sweater.
2. (界面设计评审) A UI design reviewer, a man in a black turtleneck holding a magnifying loupe, silver earring.
3. (插画师) An illustrator, a young woman with a paint smudge on her cheek holding a stylus, rose apron.
4. (动效设计师) A motion designer, a man with wavy hair and big headphones, a striped scarf, cyan.
5. (品牌设计师) A brand designer, a woman with a sleek high ponytail and small gold earrings, cream blazer.
6. (三维美术) A 3D artist, a man with a VR headset pushed up on his head, violet shirt.
7. (摄影师) A photographer, a woman with a camera strap across her shoulder and short wavy hair, denim jacket.
8. (用户体验研究) A UX researcher, a man with sticky notes stuck on his sleeve, warm orange polo.
9. (字体设计师) A type designer, an older woman with a glasses chain and a small round brooch, plum dress.
```

#### AV-04 · 内容

```text
1. (研究员) A researcher, a man in a tweed jacket holding a magnifying glass, thoughtful look.
2. (写作者) A writer, a woman with a loose scarf holding a small notebook, wine red.
3. (编辑) An editor, an older man with half-moon glasses and a red pencil, dark green vest.
4. (译者) A translator, a woman with a two-tone scarf and a small globe pin, sky blue.
5. (市场文案) A marketing copywriter, a young man in a bright yellow hoodie with a small megaphone pin, big grin.
6. (记者) A journalist, a woman with a blank press badge and a notepad, trench coat.
7. (播客主持) A podcaster, a man with big headphones and a microphone, maroon shirt.
8. (社媒运营) A social-media manager, a young woman holding a phone, star-shaped hair clips, pink.
9. (诗人) A poet, a man with long hair holding an ink brush, indigo robe-like jacket.
```

#### AV-05 · 产品与决策

```text
1. (产品经理) A product manager, a woman in a navy blazer holding a tablet, confident smile.
2. (用户研究员) A user researcher, a man with a small voice recorder and a friendly face, sage green.
3. (数据分析师) A data analyst, a woman with a tidy bun and a small bar-chart pin, teal blouse.
4. (反方 · 红队) A devil's advocate, a man with a skeptical smirk and one raised eyebrow, red jacket.
5. (主持人) A meeting moderator, a calm woman with a small handheld microphone, gold-accented cream suit.
6. (战略顾问) A strategy consultant, a man with slicked-back hair in a charcoal suit, silver tie.
7. (项目经理) A project manager, a woman with a pencil stuck in her bun holding a small calendar, orange.
8. (财务分析) A finance analyst, an older man with a calculator and a neat moustache, brown waistcoat.
9. (合规顾问) A compliance advisor, a woman with glasses holding a folder, slate grey suit.
```

#### AV-06 · 朝堂（一）· 文臣

```text
1. (丞相) A chief minister, an old man with a long white beard, a black official's hat with side wings, holding a court tablet, crimson robe.
2. (内阁学士) A grand secretary, a middle-aged man with a scholar's cap holding a rolled scroll, dark blue robe.
3. (御史) An imperial censor, a stern young man in a black official's hat holding a writing brush, deep green robe.
4. (翰林学士) A Hanlin scholar, a young man with a stack of thread-bound books, light blue robe.
5. (女官) A court lady official, a woman with an elegant hairpin holding a ledger, lilac robe.
6. (史官) A court historian, an older woman with a bundle of bamboo slips, ochre robe.
7. (钦天监) A court astronomer, a man with a small armillary sphere, midnight-blue robe with tiny stars.
8. (太医) An imperial physician, an old man with a small wooden medicine box, beige robe.
9. (户部尚书) A finance minister, a round-faced man with an abacus, brown robe with a gold belt.
```

#### AV-07 · 朝堂（二）· 武将与侍卫

```text
1. (大将军) A grand general, a man in lamellar armor with a red cape and a plumed helmet, proud look.
2. (女将军) A woman general in silver armor with a spear held upright, red ribbon in her hair.
3. (锦衣卫) An imperial guard in a flying-fish robe and a black cap, sharp eyes, crimson and gold.
4. (御前侍卫) A palace bodyguard, a stoic man with a sheathed sword at his side, dark teal uniform.
5. (军师) A military strategist with a feather fan and a scholar's head scarf, calm smile, white robe.
6. (斥候) A scout, a woman in a hooded cloak holding a small spyglass, forest green.
7. (弓箭手) An archer, a young woman with a bow over her shoulder, leather bracers, tan.
8. (老将) A veteran officer, an older man with a grey beard and an eye patch, bronze armor.
9. (少年将军) A young officer, a boy-faced young man in bright red armor, determined look.
```

#### AV-08 · 宫廷生活

```text
1. (御厨) An imperial chef in a tall white cap holding a steamed bun, round cheeks.
2. (宫廷画师) A court painter, a woman holding a long brush, light green robe with paint spots.
3. (乐师) A court musician, a man holding a small guqin, dark red robe.
4. (舞者) A court dancer, a woman with long flowing sleeves and a flower in her hair, pink.
5. (园丁) A palace gardener, an old man holding a small bonsai tree, straw hat, earthy green.
6. (茶艺师) A tea master, a woman holding a small clay teapot, celadon robe.
7. (书法家) A calligrapher, a man holding a big brush, a scroll with only abstract ink strokes, black robe.
8. (棋手) A Go player, a young woman holding a black Go stone between two fingers, white and black outfit.
9. (说书人) A storyteller with a folding fan and a small wooden clapper, blue robe, lively expression.
```

#### AV-09 · 古今混搭

```text
1. (丞相 · 笔记本) A chief minister in a crimson robe and official's hat, typing on a small laptop.
2. (将军 · VR) A general in armor wearing a VR headset, amused smile.
3. (女官 · 平板) A court lady official in a lilac robe holding a tablet with a blank screen.
4. (太医 · 听诊器) An imperial physician in a beige robe with a modern stethoscope around his neck.
5. (锦衣卫 · 耳麦) An imperial guard in a flying-fish robe wearing sunglasses and an earpiece.
6. (史官 · 录音笔) A court historian holding a small voice recorder and bamboo slips.
7. (钦天监 · 无人机) A court astronomer with a tiny drone hovering by his shoulder.
8. (御厨 · 奶茶) An imperial chef holding a cup of bubble tea with a straw.
9. (翰林 · 耳机) A Hanlin scholar in a light blue robe wearing big modern headphones.
```

#### AV-10 · 动物伙伴（一）

```text
1. (狸花猫) A brown Dragon Li tabby cat with a thin gold collar and a tiny square seal tag, aloof eyes.
2. (柴犬) A Shiba Inu wearing small round glasses, cheerful.
3. (熊猫) A panda holding a short bamboo stalk like a pen.
4. (狐狸) A red fox with a monocle and a neat bow tie.
5. (仓鼠) A hamster with full cheeks holding a sunflower seed.
6. (猫头鹰) An owl wearing a tiny graduation cap.
7. (鹦鹉) A green parrot wearing a tiny headset microphone.
8. (兔子) A white rabbit holding a carrot-shaped pen.
9. (水獭) An otter holding a small wrench, curious look.
```

#### AV-11 · 动物伙伴（二）

```text
1. (黑猫) A sleek black cat with a red bow tie.
2. (金毛) A golden retriever with a small backpack strap on its shoulder.
3. (浣熊) A raccoon with welding goggles on its forehead.
4. (刺猬) A hedgehog wearing reading glasses.
5. (小鹿) A young deer with a small flower behind its ear.
6. (海豹) A grey seal wearing big headphones.
7. (树懒) A sleepy sloth holding a coffee cup.
8. (仙鹤) A red-crowned crane wearing a tiny scholar's hat.
9. (小龙) A small friendly Chinese dragon holding a pearl, gold and jade colors.
```

#### AV-12 · 机器人与 AI

```text
1. A retro gold robot with a round head and one antenna.
2. A sleek white robot with a blue glowing visor.
3. A tiny round drone-robot with small propellers and big eyes.
4. A robot whose antenna is shaped like a small three-pointed crown, ink black and gold.
5. A mecha pilot girl with a helmet tucked under her arm, orange suit.
6. A friendly holographic assistant, slightly translucent cyan figure.
7. A steampunk automaton with brass gears on its cheeks.
8. A robot cat with a metallic body and a tail like a cable.
9. A robot whose head is a small blank screen showing a simple smile made of two dots and a curve.
```

#### AV-13 · 多元人物（一）

```text
1. An elderly East Asian woman with a silver bun and a warm smile, jade earrings.
2. A young Black man with an afro and headphones around his neck, yellow shirt.
3. A South Asian woman with a long braid and a cardigan, warm smile.
4. A middle-aged Latino man with a moustache in a denim shirt.
5. A young woman wearing a hijab, holding a laptop, teal.
6. An older white man, bald, with a bow tie and a kind face.
7. A young East Asian man with a skateboard over his shoulder, beanie.
8. A Southeast Asian woman with short hair and a film camera, mustard.
9. A Pacific Islander man with curly hair and a floral shirt, big smile.
```

#### AV-14 · 多元人物（二）

```text
1. A Nordic woman with freckles and a knitted hat, light blue.
2. An East Asian man with long hair tied up, wearing a modern jacket with a mandarin collar.
3. An African woman with a patterned headwrap and bold earrings, orange and green.
4. A Sikh man with a turban and a neat beard in a navy suit.
5. A young woman with vitiligo and curly hair, lavender top.
6. A man with a hearing aid and short grey hair, friendly, olive sweater.
7. An older Japanese man with glasses and a cardigan, gentle smile.
8. A young Korean woman with a beret and a film camera, cream coat.
9. A young adult with braces, braids and a bright smile, red hoodie.
```

#### AV-15 · 奇想角色

```text
1. A lion-dance performer holding the lion head mask beside him, red and gold.
2. A Peking-opera performer with a bold painted face, colorful headdress.
3. An astronaut with the helmet visor open, white suit with an orange patch (no text).
4. A detective with a deerstalker hat and a pipe-shaped magnifying glass.
5. A wizard with a starry pointed hat and a small glowing orb.
6. A pirate captain with a feathered hat and a friendly parrot on the shoulder (no weapons).
7. A farmer with a straw hat holding a sheaf of wheat.
8. A deep-sea diver in a brass helmet with a round window.
9. A shadow-puppet master holding a small paper puppet, dark blue robe.
```

## 子智能体头像图集（SUB-30，2026-10-21）

`subagent-avatars/*-sheet-1254.webp` 是生图原图（1254×1254 无损 WebP，四张共约 5 MB），`frames-1254.json` 是在原图上量出的 36 个头像框。应用里用的是缩小后的版本 `desktop/src/renderer/src/assets/subagent-avatars/`：

头像是透明底（UI-S13）：原图的米色底和每个头像下的投影用 `subagent-avatars/matte.py` 抠掉。和底色相近且不比底色亮、或比底色暗的平滑灰色（投影），只要和图边连通就算背景；先把候选区收窄 3 px 再从图边扩张，白色机器人、幽灵这类表面光滑的头像不会从窄缝漏进去；边缘按颜色差给半透明，并把底色从半透明像素里减掉。缩小时用预乘透明度，边缘不带杂色：

```sh
python3 -I -c "import importlib.util as u; s=u.spec_from_file_location('m','matte.py'); m=u.module_from_spec(s); s.loader.exec_module(m); m.matte('X-sheet-1254.webp','X.png')"
python3 -I -c "from PIL import Image; Image.open('X.png').convert('RGBa').resize((448,448), Image.LANCZOS).convert('RGBA').save('X-sheet.webp','WEBP',quality=90,alpha_quality=95,method=6)"
```

头像框按 448 / 1254 等比缩放并取整（`frames.json`）。四张合计约 225 KB；每个头像约 110–160 px，够 40 px 头像在 2 倍屏上显示。以后重新裁框，在原图上量，再按同样比例换算；换了原图要重新抠底，并在深色与浅色背景上逐个看一遍（`tests/visual/subagent-avatars.spec.ts` 检查每张图角落透明、每个头像中心不透明）。
