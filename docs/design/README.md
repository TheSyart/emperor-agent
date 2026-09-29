# 设计规范

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-09-29<br>
> 事实源：`desktop/src/renderer/src/theme/`、`desktop/src/renderer/src/style-audit.test.ts`、`desktop/src/renderer/src/feature-style-owners.json`、`assets/generated/`

本目录集中维护 Emperor Agent 的设计规范，包括品牌与图形资源、界面主题与样式、插件 Logo 等。系统怎样运转见[架构文档](../architecture/overview.md)，怎样开发和扩展见[开发指南](../development/README.md)；根目录 README 只链接到这里，不复制规范正文。

## 规范列表

| 规范                                  | 内容                                                       |
| ------------------------------------- | ---------------------------------------------------------- |
| [插件 Logo 设计规范](plugin-logos.md) | 受管插件 Logo 的方框材质、渐变与光照、透明边界、尺寸和验收 |

## 现有的设计事实源

以下内容已经由代码或资源文件约束，暂时没有单独的规范文档；修改时以这些文件为准：

| 方面           | 事实源                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 颜色与主题变量 | `desktop/src/renderer/src/theme/`（`base.css`、`dark.css`、`light.css`、`tokens.ts`）                                                |
| 样式约束       | `desktop/src/renderer/src/style-audit.test.ts`：颜色与尺寸必须收敛到主题变量，`theme/*.css` 本身除外                                 |
| 样式归属       | `desktop/src/renderer/src/feature-style-owners.json`：每个界面功能的视图、控制器和样式层位置                                         |
| 设置页组件     | `components/settings/ui/` 的原语；开发模式下打开 `?settings-gallery` 查看，搭建方法见[扩展指南](../development/extending-emperor.md) |
| 品牌与产品图   | `assets/generated/` 下的产品字标、标志、产品图和插件 Logo；图片生成的提示词记录在 `assets/generated/PROMPTS.md`                      |

## 新增规范

- 一类设计规范写一个文件，放在本目录，并加入上面的「规范列表」。
- 使用[文档维护规范](../DOCUMENTATION.md)要求的四行状态头，写明事实源。
- 只写已经确定的规则。尚未实现的界面不能写成已经存在；资源已生成但界面未接入时，要明确写出。
- README、用户手册和开发指南需要引用规范时，只放链接，不复制正文。
