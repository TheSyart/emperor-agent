# 吉祥物小单

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者<br>
> 最后核验：2026-10-27（对照 `2c482bb2`）<br>
> 事实源：`desktop/src/renderer/src/assets/mascot/`、`assets/generated/mascot/process_mascot.py`、`assets/desktop-pet/`、`desktop/src/renderer/src/components/ui/mascotPortraits.ts`、`desktop/src/renderer/src/components/conversation/EmptyHero.vue`、`desktop/src/renderer/src/components/settings/AboutGroup.vue`、`desktop/src/renderer/src/copy/courtly.ts`、`assets/generated/PROMPTS.md`

Emperor 的吉祥物是小单：作者本人的 Q 版形象，黑色方框眼镜、刺猬头，平时穿黑 T 恤，场合需要时换龙袍、朝服。他也是桌宠。界面里的他一直克制：不说话、不卖萌，只在少数几个位置出现，一屏最多一次。

## 出现在哪里

| 位置                      | 用哪张图                            | 条件                                                          |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| Build 第一次的首页        | 龙椅批奏折（`throne.webp`）         | 一个项目都没有时，替代标；窗口矮于 640 时不显示               |
| 内置联系人 Emperor 的头像 | 龙袍戴冠的头（`emperor-head.webp`） | 联系人列表、档案、群聊里的主持人                              |
| 「设置 › 常规」的关于     | 龙袍混搭全身（`robe.webp`）         | 落款是「单」字印（`seal-dan.webp`）                           |
| 授权卡右上角              | 「嗯？」贴图（`sticker-en.webp`）   | 只在宫廷用语打开时，见[界面文案规范](writing.md#宫廷用语可选) |
| 桌宠                      | `assets/desktop-pet/` 三套衣服      | 「设置 › 常规 › 外观 › 桌宠」打开时；衣服在「桌宠的衣服」里选 |
| 皮肤的装饰位              | 见皮肤规范                          | 选了带装饰的皮肤时                                            |

「设置 › 常规 › 外观 › 显示吉祥物」（默认开）关掉后，上表除了 Emperor 的头像、关于页的落款章和桌宠（它们各有自己的设置），都不放图，回到没有插画的样子。

## 不出现在哪里

- 对话正文、代码块、改动对比、终端输出、费用显示、登录和凭据界面。
- 错误页和出错提示：出错时不需要一个笑着的人。
- Chat 首页和 Group 首页：首页只放标和问候，保持干净。
- 授权卡只有一个例外：宫廷用语打开时，卡片顶条右侧那张小贴图。贴图是装饰，读屏不读；按钮、风险说明和操作内容里从不放图。

## 素材

| 文件（`desktop/src/renderer/src/assets/mascot/`）                                          | 来源（Codex 原图）                                                                           | 尺寸      |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------- |
| `robe.webp`                                                                                | X-G2 c2，龙袍混搭                                                                            | 高 480    |
| `throne.webp`                                                                              | X-H2 c2，龙椅批奏折                                                                          | 高 480    |
| `daily.webp`、`hoodie.webp`                                                                | X-A c1、X-C c1                                                                               | 高 480    |
| `sticker-zhunzou.webp`、`sticker-zhidaole.webp`、`sticker-en.webp`、`sticker-jiaogei.webp` | X-F c1（准奏）、X-E c1（朕知道了）、X-D c2（嗯？）、X-B c1（交给朕）；加班中用 `hoodie.webp` | 高 256    |
| `seal-dan.webp`、`seal-portrait.webp`                                                      | L-L c1、L-J c1                                                                               | 192、256  |
| `emperor-head.webp`                                                                        | X-G2 c2 头部裁切                                                                             | 192 × 192 |

- 处理脚本 `assets/generated/mascot/process_mascot.py`：按偏绿程度抠图、裁到人物自身、缩到所需高度，存 WebP（质量 88，带透明）。原图不进仓库。
- 贴图上的字（准奏、朕知道了、嗯？、加班中、交给朕）不画进图里，由界面用宋体朱红排出来，换字不用重画。
- 桌宠的帧条格式见 `assets/desktop-pet/*/README.md`；三套衣服共用小单的帧数、基线和 3.6px 白描边。

## 不要

- 改他的脸、发型、眼镜或比例；给他加台词气泡（桌宠的状态气泡除外）。
- 一屏放两次；放进上面「不出现在哪里」的位置。
- 拉伸、加描边或阴影（桌宠自带的白描边除外）、换颜色。

## 授权

小单是作者本人的形象，不开放二创：素材只用于 Emperor 本身，不允许单独取出、改编或用于别的产品。
