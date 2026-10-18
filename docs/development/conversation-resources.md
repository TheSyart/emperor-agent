# 对话资源展示契约

> 文档状态：Active<br>
> 面向读者：Renderer、工具与 Core 开发者<br>
> 最后核验：2026-10-16<br>
> 事实源：`components/conversation/resources/`、`components/composer/editor/resourceDecorations.ts`、`documentIcons.ts`、`packages/core/src/workspace/references.ts`、`reference-preview.ts`、`api/operations.ts`

## 身份与渲染

`DisplayResource` 只用于展示，保留原始 `href`、名称、真实 `sourceMessageId`、类型、可用状态、角色和出处；不进入模型提示词，不重写旧会话正文。原有 Skill／Plugin `MessageReference` 的偏移、手势与注入协议保持独立。

正文行内链接只保留图标与完整名称，详情入口放在卡片与侧栏，不为每个链接追加省略号按钮。 网站链接常态为无色底的图标加名称，正文图标 16px、图文间距 6px、两侧各 4px 留白，悬停时才显示轻背景。来源栏图标 20px、图文间距 12px、行高至少 56px；长名称继续完整换行。长资源标题、描述和来源名称换行显示，不做 CSS 省略；裸网址保留参数和锚点。

Markdown token 决定哪些链接可显示，跳过代码；独立段落的单个链接只在流式回复结束后升级卡片。输入框使用 ProseMirror decoration，按完整文本识别代码区并映射回文档位置，composition 期间暂停装饰；不插入原子网址节点。

`resourceIndex` 从当前会话的已加载 snapshot 建索引，按角色与规范化 URL／文件／附件身份去重，保留 `uses` 的消息、工具行和来源类型。运行中的助手文本暂不索引；已完成文本使用带文本／来源校验的 WeakMap 缓存，旧快照释放后可回收。历史分页补齐资源；有更早历史时明确说明范围。

角色为 `source`、`output`、`observation`；来源类型区分提供、搜索命中、读取、引用、生成、观察和能力使用。成功创建文件才算产物，修改继续使用回合改动卡片。电脑操作截图使用 `meta.computerUse.screenshot.attachmentId` 的原始审计图片；给模型的缩小副本不重复收录，也不算产物。

## 工具扩展

已识别的搜索、网页抓取、文件读取／创建和结构化 GitHub 结果可直接展示。未知结果保持通用视图；专用视图始终保留原始输出入口。不要从任意日志文本猜测生成物。

生产方可以在既有工具结果的 `meta` 内添加可选的 `displayResources` 数组：

```ts
meta: {
  displayResources: [{
    kind: 'file',
    href: 'docs/report.md',
    name: '报告',
    role: 'output',
  }],
}
```

每项还可提供 `description`、`status`、`mime`、`bytes`、`available` 和已保存附件的 `attachmentId`；可用角色为上文三种。展示层验证类型、协议、字段长度和数量；错误工具结果不产生成功产物。截图工具的观察分类优先于此元数据。模型收到的工具文字不因展示元数据而改变。

## 详情与打开

### 网站图标

网站图标默认关闭（设置 › 常规 ›「显示网站图标」，偏好存于本机 `emperor.ui.prefs.v1`）：关闭时不发出任何图标请求，链接只显示通用图标；打开后，可见网页引用显示真实 favicon；正文、卡片、搜索结果与来源清单共用图标加载器。离屏内容和流式未结束的正文不批量请求。输入框复用已取得的图标缓存，不因输入尚未发送的网址而联网。加载失败保留域名首字母，链接文字与打开行为不变。

`references.siteIcon({ sessionId, referenceId })` 使用 opaque 引用，每次请求及返回前校验可读会话与引用归属。后端只读取 HTTPS origin 的 favicon／apple-touch-icon，必要时解析最多 256 KiB 的首页中的 icon link，不读取文章 URL 或 OpenGraph 预览图。第一方未提供可用栅格图标时，以公共 hostname 请求 `icons.duckduckgo.com/ip3/<hostname>.ico`；不发送链接路径、查询参数、Cookie 或浏览器登录状态。私网／非法地址在 DNS 与重定向校验处停止，不进入第三方 fallback。

图标最多 256 KiB，支持经过帧结构与尺寸验证的 PNG、JPEG、GIF、WebP 和 ICO（PNG／未压缩 DIB）；SVG 不直接交给 renderer。renderer 只接受受限的 raster data URL，不请求第三方图片。前后端各最多 4 项并发、200 项待处理；后端成功图标按公开 origin 缓存最多 200 项、24 小时，失败缓存 1 分钟；renderer 会话资源缓存最多 600 项、10 分钟，公开品牌图标另供输入框复用。旧会话和卸载组件的响应不会更新当前 DOM。

### 按需详情

`references.resolve({ sessionId, sourceMessageId, href, label })` 建立会话绑定的 opaque reference。`references.preview({ sessionId, referenceId })` 再验证可读根／子日志会话与引用归属；未知、跨会话、归档引用不可用。文件操作继续复用 Files 和 main-only `revealReference`，不给 renderer 任意路径执行入口。已保存附件使用 `attachment:<id>` 解析，普通 Chat 也无需 Build 项目即可得到受控 Finder 引用。

网页预览由显式详情操作触发。普通页面复用 WebFetchClient 的公共地址、DNS、重定向和大小校验，不带浏览器 Cookie，使用 parse5 提取惰性 HTML 元数据，不执行脚本。图片只接受校验后的 PNG、JPEG、GIF、WebP 栅格数据；SVG／ICO favicon 跳过。第三方图片 URL 不传给 renderer 请求。

- 总超时 8 秒；同时最多 4 项，满额返回忙碌，不建立无界队列。
- HTML 上限 1 MiB；图标 256 KiB；预览图 512 KiB；另校验图片帧和尺寸。
- 公开元数据按会话缓存，单会话最多 200 项、有效期 10 分钟；每次读取缓存仍校验归属。
- PR／Issue／Actions 通过已有 GitHub 只读服务，使用当前插件状态与授权，不缓存认证结果。仓库／Commit／Release 用网址身份和公开页面元数据，无新增授权流程。
- 组件卸载／换会话取消消费并忽略旧响应；Core 超时向底层 HTTP／gh 传递 AbortSignal。桥接已发出的请求可能继续至 Core 超时，但不会更新新会话。

`ReferencePreview` 提供 `ready`、`unavailable`、`error`、可选标题／描述／状态／栅格 data URL 和更新时间。失败保留基础身份与原链接；重试由用户主动发起。网页与能力详情按需分块加载，沿用 Modal；文件内容统一进入右侧 Files，图片缩略图直接打开共用灯箱。

## SVG 图标

`desktop/src/renderer/src/assets/document-icons/*.svg` 是逐类绘制的可信几何源。`documentIcons.ts` 按扩展名映射并导出原始 SVG、彩色 CSS image 与主题 mask；`DocumentIcon.vue`、Markdown、附件和 Files 共用，名称和路径只参与选型，不插入 SVG 内容。彩色底板图标用完整 SVG image 保留字母和双色细节；线性图标继续使用主题 token 与 currentColor 的 mask。文件／目录状态变化时清理旧彩色标记。同语言扩展名共用图标，未知类型使用通用文件图标。新增类型需同步映射、几何校验、组件测试与深浅主题检查。

## 子智能体头像

`SubagentAvatar.vue` 提供 36 个本地生成的角色头像（动物、机器人与幻想角色），侧栏和委派记录共用。头像从子智能体 ID 的稳定 hash 派生，重排、状态更新和历史重放不会换脸；不同子智能体可能抽到同一角色。`assets/subagent-avatars/frames.json` 为每个角色记录独立取景矩形，等比例居中、四周留白 8%；SVG clipPath 显式裁定原图边界，避免相邻角色进入宽高比留白区域。四张原图按像素无损编码为本地 WebP，仅显示相应角色时加载对应图册，不请求第三方服务、不写入模型或会话数据。状态点与状态文字保留运行／完成／失败语义。

## 验证

定向单测覆盖身份、协议、归属、取消、缓存、图片校验、工具分类、历史分页、组合输入和原始 URL。Chromium 视觉套件的 `resources.spec.ts` 验证真实组件的主题、窄屏、键盘、详情与延迟请求；其 Core bridge 是夹具。真实 Electron 使用隔离 Emperor Home，运行 `node scripts/e2e-cu.mjs --mode=references` 与 `--mode=userbrowser-app`，分别检验真实桥接／文件／附件／GitHub 路由和浏览器打开偏好。脚本模型测试与真实付费模型测试分开记录。最终执行 `make check`。

## 文件侧栏与图片灯箱

文件名、文件详情、已编辑文件和附件统一进入右侧 Files；「查看变更」单独进入差异视图。普通 Chat 和草稿没有项目目录树，只显示已打开文件。相同 canonical 文件身份复用标签，刷新读取当前内容；请求以会话或草稿 owner 隔离，切换及卸载后的响应不更新面板。

消息和输入框中的图片附件只显示缩略图，不附带名称、大小或类型文字；输入框保留独立的移除按钮。缩略图打开灯箱，灯箱保留名称及「在文件中查看」入口；非图片附件仍以文件名打开 Files。

`files.preview` 是只读 main_renderer 操作：`source: project` 携带 sessionId/path；`turn` 增加 turn 并验证确切记录；`reference` 使用 sessionId/referenceId；`attachment` 使用受管 attachmentId，沿用全局附件权限且不会创建会话。引用的 `actions` 含 `preview` 才读内容：项目（会话根）内的文件与已保存附件有 `preview`，会话根之外的文件（含指向外部的符号链接）只有 `reveal`，`files.preview` 对其报 `reference_action_denied`，renderer 改为在 Finder 中显示；不提供任意绝对路径读取入口。返回 FilePreviewResult，包含 canonical 身份、路径、名称、MIME、大小、内容类型及受限内容。文本上限 1 MiB，图片 8 MiB；PDF 已有提取文本时明确标记，其他不支持格式只显示元数据。外部目录不递归读取，Finder 继续只接收 opaque 引用。

ImageViewerHost 按需加载 ImageLightbox，共用于附件、生成图片、资源图、文件图片、工具／轨迹截图和 Computer Use 放大。默认适应窗口，支持原始大小、缩放、拖动、旋转、同组切换和键盘退出；复用现有 modal stack 隐藏原生浏览器视图，约束焦点并恢复入口。图片只接受受管附件、已取得的栅格数据或本地 Blob，不直接读取第三方图片 URL。Computer Use 放大复制已经收到的帧，既有订阅与工具执行不变；关闭释放副本 URL。
