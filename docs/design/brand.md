# 品牌资源规范

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、发布维护者<br>
> 最后核验：2026-10-20<br>
> 事实源：`assets/generated/emperor-mark.svg`、`desktop/src/renderer/src/components/brand/BrandMark.vue`、`desktop/src/renderer/public/favicon.svg`、`desktop/build/icon.png`、`desktop/build/background.tiff`、`desktop/electron-builder.yml`（`dmg`）、`assets/generated/model-setup-hero-{dark,light}.webp`、`assets/generated/PROMPTS.md`

Emperor 的标是一枚现代印章：圆角方框里，一条冠线压在左右对称的结构上，中间一个小六边形节点暗示 Agent。它没有可读的字母或汉字，只用一种颜色。0.2 起所有品牌位置都用同一份矢量几何，不再使用位图字标。

## 标

| 项目     | 规则                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 几何     | `assets/generated/emperor-mark.svg`：`viewBox="141 141.5 970 970"`，五个形状（外框、六边形、冠线、左右对称的两半）。右半是左半以 x = 626.5 为轴的镜像。                |
| 颜色     | 界面里用 `--brand`（随主题变化）；脱离界面的文件（README、favicon、安装包）用 `#D4AA5E`。只用一种颜色，不加渐变、描边或阴影。                                          |
| 界面组件 | `BrandMark.vue` 内联同一份路径，`size` 默认 24。侧栏品牌行 22、窄轨 24、空会话首屏 34、首启弹窗 26。                                                                   |
| 最小尺寸 | 16px 仍可辨认（favicon 与扩展 16px 图标已核对）；更小时不用标，只写名字。                                                                                              |
| 名字     | 标旁的名字写「Emperor Agent」（首启弹窗）或「Emperor」（侧栏），用系统字体 600，不做成图片。                                                                           |
| 不要     | 改比例、拆开单独使用六边形、给标加底色块（应用图标除外）、换成其他颜色、与旧的六边形 lucide 图标混用（`icons.ts` 不导出 `brandIcon`，`brandMarkUsage.test.ts` 检查）。 |

一致性由 `components/brand/brandMarkUsage.test.ts` 保证：`BrandMark.vue`、`favicon.svg` 与 `emperor-mark.svg` 的路径必须相同，品牌位置必须用 `BrandMark` 且不引用退役的位图。

## 应用图标

- `desktop/build/icon.png`：1024 × 1024，macOS 图标网格——824 × 824 的圆角方块居中（四边各留 100），深暖石墨底，金色缎面的标居中，约占方块宽度的 64%。electron-builder 由它生成 `.icns`；两个 Helper 的图标也由它生成（`native/macos/scripts/helper-icon.sh`）。
- 浏览器扩展的 `desktop/extension/icons/icon-{16,32,48,128}.png` 由同一张图缩小。
- 改图标时同时检查 16 / 32 / 128 三个尺寸在深浅 Dock 背景上的样子。

## 安装窗口（DMG）

- `desktop/build/background.tiff` 内含 660 × 400 与 1320 × 800 两张，Retina 下不糊。
- 象牙纸底、居中一支细金色箭头，右下角极淡的印章浮雕。
- `electron-builder.yml` 的 `dmg`：窗口 660 × 400，图标 96；应用放在 (165, 185)，`/Applications` 链接放在 (495, 185)，与箭头同高。`release-config.test.ts` 检查这些值与 TIFF 的两种尺寸。

## 首启「配置模型」插图

- `assets/generated/model-setup-hero-dark.webp`、`model-setup-hero-light.webp`：1600 × 1000，构图一致——右侧一块刻着标的石质印章、一枚钥匙和三张浮动卡片，左侧约 40% 留空。
- 插图铺满弹窗（`object-fit: cover`，靠右对齐），文字放在左侧留空处，上面叠一层从 `--surface-canvas` 到透明的渐变保证可读；按当前生效的主题（`useTheme().theme`）切换深浅版本。窄于 760px 时插图变成顶部 200px 的横幅。
- 插图底色分别贴近 `--surface-canvas` 的深浅值，渐变才能无缝衔接；重新生成时保持这个底色。

## 文件与生成记录

- 每张生成图的提示词、选图理由与后期处理写在 `assets/generated/PROMPTS.md`。
- 生成原图（含绿底与候选）不进仓库；仓库只放处理后的成品。
- 退役于 2026-10-20：`emperoragent-wordmark.png`、`emperor-agent-logo-mark.png`、`model-setup-modal-hero-v2.png`。`readme-product-hero.png` 仍是旧界面的示意图，0.2 发布前由 REL-06 换成新界面的真实截图。
