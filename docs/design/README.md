# 设计规范

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-21（对照 `ce55ee4a`）<br>
> 事实源：`desktop/src/renderer/src/theme/`、`desktop/src/renderer/src/components/ui/`、`desktop/src/renderer/src/style-audit.test.ts`、`desktop/src/renderer/src/feature-style-owners.json`、`desktop/tests/visual/__baselines__/`、`scripts/lib/design-docs.mjs`、`assets/generated/`

本目录集中维护 Emperor Agent 的设计规范，包括品牌与图形资源、界面主题与样式、插件 Logo、模型元数据目录等。系统怎样运转见[架构文档](../architecture/overview.md)，怎样开发和扩展见[开发指南](../development/README.md)；根目录 README 只链接到这里，不复制规范正文。

## 规范列表

| 规范                                         | 内容                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| [品牌资源规范](brand.md)                     | 标的几何与用法、应用图标、DMG 安装窗口、首启插图、退役的旧资源       |
| [插件 Logo 设计规范](plugin-logos.md)        | 受管插件 Logo 的方框材质、渐变与光照、透明边界、尺寸和检查           |
| [模型元数据规范](model-metadata.md)          | 随包模型目录的数据来源与许可、匹配规则、覆盖层与家族规则、刷新流程   |
| [厂商模型列表接口规范](vendor-model-apis.md) | 各厂商模型列表接口的地址、字段、分页与坑，连接测试与错误码           |
| [设计令牌](tokens.md)                        | L1 原子、L2 语义、L3 组件三层令牌，全部 L2/L3 令牌与用途，迁移进度   |
| [颜色使用规范](color.md)                     | 表面与文字层级、实测对比度、金色只用于少数关键位置、状态色与用户气泡 |
| [排版](typography.md)                        | 字体、字号与行高的两套刻度、各类文字的规格、字重、中文排版           |
| [浮层规范](overlays.md)                      | 模态弹窗的焦点与 Esc、确认框、轻提示队列、锚定面板                   |
| [组件规范](components.md)                    | `components/ui/` 每个组件的用途、变体、键盘行为与反例                |
| [外壳布局](layout.md)                        | 平铺的几栏、侧栏的结构与节奏、内容宽度、顶栏对齐、窄轨、列宽与断点   |
| [动效](motion.md)                            | 时长与缓动、进场、展开收起、运行中的持续动效、弹簧、减少动态效果     |
| [会话流](conversation.md)                    | 过程组折叠、工具行与准备中的调用、气泡与正文、轮末操作、展开动效     |
| [输入框](composer.md)                        | 卡片的样式、控件行与 dock、截图、空会话的访谈提示                    |
| [界面文案规范](writing.md)                   | 术语表与禁用词、保留原文的内容、格式、错误文案、文案扫描             |

## 现有的设计事实源

以下内容已经由代码或资源文件约束，暂时没有单独的规范文档；修改时以这些文件为准：

| 方面           | 事实源                                                                                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 颜色与主题变量 | `desktop/src/renderer/src/theme/`（见[设计令牌](tokens.md)）                                                                                                                                                                                                                              |
| 样式约束       | `desktop/src/renderer/src/style-audit.test.ts`：颜色与尺寸必须收敛到主题变量，`theme/*.css` 本身除外；裸控件、字重、1px 边框、图标尺寸、层级与退役令牌的 ratchet 计数在 `style-audit-ratchet.json`（只降不升，见[设计令牌](tokens.md)）；旧令牌名用 `scripts/codemods/tokens-v2.mjs` 改写 |
| 样式归属       | `desktop/src/renderer/src/feature-style-owners.json`：每个界面功能的视图、控制器和样式层位置                                                                                                                                                                                              |
| 组件           | `components/ui/`（见[组件规范](components.md)），开发模式下打开 `?ui-gallery` 查看；设置页的布局原语在 `components/settings/ui/`，打开 `?settings-gallery` 查看，搭建方法见[扩展指南](../development/extending-emperor.md)                                                                |
| 像素基线       | `desktop/tests/visual/__baselines__/`：约 60 张关键界面截图（每个界面深浅各一），视觉测试逐像素比对；比对与重新生成的命令见[开发指南](../development/README.md#质量门禁)                                                                                                                  |
| 品牌与产品图   | 见[品牌资源规范](brand.md)；`assets/generated/` 下的标、首启插图、产品图和插件 Logo，图片生成的提示词记录在 `assets/generated/PROMPTS.md`                                                                                                                                                 |

## 新增规范

- 一类设计规范写一个文件，放在本目录，并加入上面的「规范列表」。
- 使用[文档维护规范](../DOCUMENTATION.md)要求的四行状态头，写明事实源。`scripts/check_public_docs.mjs`（在 `./scripts/check.sh` 里运行）检查本目录每个文件的状态头，以及它是否同时列在本页和[文档中心](../README.md)。
- 只写已经确定的规则。尚未实现的界面不能写成已经存在；资源已生成但界面未接入时，要明确写出。
- README、用户手册和开发指南需要引用规范时，只放链接，不复制正文。
