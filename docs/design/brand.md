# 品牌资源规范

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、发布维护者<br>
> 最后核验：2026-10-27（对照 `ed72ffcd`）<br>
> 事实源：`assets/generated/emperor-mark.svg`、`assets/generated/emperor-app-icon.svg`、`desktop/scripts/render-brand-icons.mjs`、`desktop/src/renderer/src/components/brand/BrandMark.vue`、`desktop/src/renderer/public/favicon.svg`、`desktop/build/icon.png`、`desktop/build/background.tiff`、`desktop/electron-builder.yml`（`dmg`）、`assets/generated/model-setup-hero-{dark,light}.webp`、`assets/generated/readme-product-hero.png`（`desktop/tests/visual/dsh-v1.spec.ts`）、`assets/generated/PROMPTS.md`

Emperor 的标是一枚冠印（0.3，BRD-02）：一顶三尖王冠，冠带厚、底部正中一个方缺口，像印章的印纽。界面里它刻在一块金色圆角方块上（王冠镂空），应用图标里它是石墨方块上的一顶金冠。没有可读的字母或汉字；所有品牌位置都用同一份矢量几何，不用位图。

## 标

| 项目     | 规则                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 几何     | `assets/generated/emperor-mark.svg`：`viewBox="12 12 976 976"`，一条 `evenodd` 路径——950 的圆角方块（圆角 210），王冠按 62% 镂空在正中。王冠左右对称，三个尖是圆角，方缺口宽 104、深 82（王冠自身 850 单位宽）。 |
| 颜色     | 界面里用 `--brand`（浅色主题深金、深色主题亮金）；脱离界面的文件（README、favicon）用 `#D4AA5E`。只用一种颜色，不加渐变、描边或阴影；镂空处露出底下的背景。                                                      |
| 界面组件 | `BrandMark.vue` 内联同一条路径，`size` 默认 24。侧栏品牌行 22、窄轨 24、空会话首屏 34、首启引导 22。                                                                                                             |
| 最小尺寸 | 16px 仍可辨认（favicon、扩展 16px 图标）：王冠约 8px 宽，方缺口约 1px。更小时不用标，只写名字。                                                                                                                  |
| 名字     | 标旁的名字写「Emperor Agent」（首启引导）或「Emperor」（侧栏），用系统字体 600，不做成图片。                                                                                                                     |
| 不要     | 改比例、把王冠从方块里拿出来单独用（应用图标除外）、填上镂空、换成其他颜色、与旧的六边形 lucide 图标混用（`icons.ts` 不导出 `brandIcon`，`brandMarkUsage.test.ts` 检查）。                                       |

一致性由 `components/brand/brandMarkUsage.test.ts` 保证：`BrandMark.vue`、`favicon.svg` 与 `emperor-mark.svg` 的路径和 `viewBox` 必须相同，应用图标的王冠必须是标里镂空的那一顶（同一条子路径），品牌位置必须用 `BrandMark` 且不引用退役的位图。

## 应用图标

- 矢量源 `assets/generated/emperor-app-icon.svg`：macOS 图标网格——1024 画布上 824 的圆角方块居中（四边各留 100，圆角 185），石墨底带极淡的上浅下深（`#2B2926` → `#1A1918`），王冠 `#D4AA5E` 居中，约占方块宽度的 64%。
- `desktop/build/icon.png`（1024）与浏览器扩展的 `desktop/extension/icons/icon-{16,32,48,128}.png` 都由 `desktop/scripts/render-brand-icons.mjs` 从矢量源逐个尺寸渲染（仓库里的 Playwright，无头 Chromium），不是从 1024 缩小。electron-builder 由 `icon.png` 生成 `.icns`；两个 Helper 的图标也由它生成（`native/macos/scripts/helper-icon.sh`）。`main/brand-icons.test.ts` 检查尺寸和透明通道。
- 改图标：改矢量源，再跑一次脚本；同时检查 16 / 32 / 128 三个尺寸在深浅 Dock 背景上的样子。

## 安装窗口（DMG）

- `desktop/build/background.tiff` 内含 660 × 400 与 1320 × 800 两张，Retina 下不糊。
- 象牙纸底、居中一支细金色箭头，右下角极淡的冠印浮雕（金块镂空王冠的形状，约 4% 对比度），避开「应用程序」图标。
- `electron-builder.yml` 的 `dmg`：窗口 660 × 400，图标 96；应用放在 (165, 185)，`/Applications` 链接放在 (495, 185)，与箭头同高。`release-config.test.ts` 检查这些值与 TIFF 的两种尺寸。

## 首启引导插图

- `assets/generated/model-setup-hero-dark.webp`、`model-setup-hero-light.webp`：1600 × 1000，构图一致——右侧一块石印，顶面嵌着冠印（金块镂空王冠，露出石面），一枚钥匙令牌和三张浮动卡片，左侧约 40% 留空。
- 首启引导（UI-S17，`onboarding/FirstRunOnboarding.vue`）铺满窗口，插图放在右侧：
  - 宽度不超过 1040px。原图 1600 宽，这样在 Retina 上仍然清楚。
  - 左、上、下三边用两层渐变遮罩（`mask-composite: intersect`）淡入画布，右边贴着窗口。
  - 按当前生效的主题（`useTheme().theme`）切换深浅版本。
  - 连接、选择模型两步时降到 45% 不透明。
- 窗口窄于 760px 时，插图变成顶部 250px 的横幅（连接、选择模型两步时 150px），文字从横幅的淡出处开始。
- 插图底色分别贴近 `--surface-canvas` 的深浅值，渐变才能无缝衔接；重新生成时保持这个底色。

## 文件与生成记录

- 每张生成图的提示词、选图理由与后期处理写在 `assets/generated/PROMPTS.md`。
- 生成原图（含绿底与候选）不进仓库；仓库只放处理后的成品。
- 退役于 2026-10-20：`emperoragent-wordmark.png`、`emperor-agent-logo-mark.png`、`model-setup-modal-hero-v2.png`。`readme-product-hero.png` 自 2026-10-21 起是 0.2 界面的真实截图（视觉测试 `dsh-v1.spec.ts` 的深色对话页），不再是生成的示意图。
