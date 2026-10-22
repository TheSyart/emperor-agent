# CI 门禁

> 文档状态：Active<br>
> 面向读者：贡献者、发布维护者<br>
> 最后核验：2026-10-23<br>
> 事实源：`.github/workflows/ci.yml`、`nightly.yml`、`weekly-model-metadata.yml`、`release-preview.yml`、`release.yml`、`scripts/ci/`（含 `check-unsigned-release.mjs`）、`scripts/session-log-kill9.mjs`、`desktop/scripts/run-packaged-smoke.cjs`

CI 只跑 macOS（项目不支持 Windows 和 Linux）。各项检查都由仓库内脚本执行，本机可以用相同命令重跑；GitHub 只负责按时间或事件把它们排上 runner。

## 各 job 做什么

| Workflow 与 job                                               | 触发                                            | Runner                       | 运行                                                                                                                        | 本机重跑                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ci.yml` › macOS PR gate (arm64)                              | pull request；推送到 `main`、`release/**`；手动 | `macos-15`                   | `scripts/ci/pr-gate.sh`：`make check`、`package:verify`、未封签副本探测                                                     | `scripts/ci/pr-gate.sh`（`--dry-run` 只列步骤）                                                        |
| `ci.yml` › macOS x64 build                                    | 同上                                            | `macos-15-intel`             | `scripts/ci/pr-gate.sh --build-only`：desktop build 代替 `make check`，其余相同                                             | Intel Mac 上 `scripts/ci/pr-gate.sh --build-only`                                                      |
| `nightly.yml` › macOS nightly                                 | 每天 18:00 UTC；手动（可填 `only`）             | `macos-26`                   | `scripts/ci/nightly.mjs`：视觉套件、像素基线钩子、Electron e2e、kill -9、加固探测；失败时 `open-failure-issue.mjs` 开 issue | `node scripts/ci/nightly.mjs`，或 `--only e2e:settings,kill9`；`--list` 看全部步骤                     |
| `weekly-model-metadata.yml` › models.dev snapshot             | 每周一 02:00 UTC；手动                          | `macos-15`                   | `scripts/ci/weekly-model-metadata.mjs`：models.dev 快照过期时刷新并开 PR                                                    | `node scripts/ci/weekly-model-metadata.mjs --dry-run`（只看计划，不改文件），或 `npm run models:check` |
| `release-preview.yml`、`release.yml` 的第一步                 | Preview tag；Stable 手动                        | 各自的 job                   | `scripts/ci/require-green-nightly.mjs`：最近一次 nightly 不绿、超过 72 小时或有未关闭的失败 issue 时，发布直接失败          | 需要 `gh` 登录：`node scripts/ci/require-green-nightly.mjs`                                            |
| `release-internal.yml`、`environment-installers-internal.yml` | 手动                                            | `macos-15`、`macos-15-intel` | 内部未签名包与 macOS 环境适配器回执                                                                                         | `npm --prefix desktop run package:verify`                                                              |

`make check`（`scripts/check.sh`）本身还运行 `scripts/ci/check-action-pins.mjs`、`scripts/ci/check-workflows.mjs` 与 `scripts/ci/check-unsigned-release.mjs`：

- 每个 `uses:` 都必须写成 40 位提交哈希，版本号写在旁边的注释里，例如 `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`。升级一个 action 时，先 `git ls-remote https://github.com/actions/checkout refs/tags/v4.4.0` 查到提交，再同时改哈希和注释。
- 工作流 lint 检查上表的对应关系：PR gate 在 arm64 和 Intel 上调用 `pr-gate.sh`；nightly 只按计划运行，从不在 pull request 或 push 上运行，并在失败时开 issue；weekly 是每周一次并有开 PR 所需的权限；两个发布 workflow 都先检查 nightly；`release.yml` 在 arm64 和 Intel 上用 `scripts/build_desktop_release.sh` 构建、用 `scripts/verify-macos-release.sh` 核验 Stable 候选；除只检查 tag、汇总、证明和发布的 job（`release-preview.yml` 的 aggregate / publish，`release.yml` 的 release-policy / release-aggregate / publish-release）外，所有 job 都跑在 macOS 上；workflow 里引用的 `scripts/ci/*` 都存在。
- 未签名检查：发布 workflow（`release*.yml`）除 GitHub token 外不引用任何 secret；所有 workflow、两份 electron-builder 发布配置和发布脚本里都没有签名变量（`CSC_LINK`、`APPLE_TEAM_ID` 等）、公证（`notarytool`、`stapler`）、钥匙串导入（`security import`）或 ad-hoc `-` 以外的 `codesign --sign`；`release.yml` 与 `release-preview.yml` 在整个 workflow 上关闭 `CSC_IDENTITY_AUTO_DISCOVERY`。`scripts/ci/fixtures/signed-release/` 是一份签名发布的反例，测试确认检查会拒绝它。

## PR gate

`package:verify` 打出未签名、ad-hoc 封签的包（`desktop/dist/mac-*`），再运行 `desktop/scripts/run-packaged-smoke.cjs`。打包冒烟除[开发指南](README.md#质量门禁)列出的封签、fuses、密钥与 Helper 检查外，还检查：

- **Native Messaging host**：按 Chrome 的帧格式给 `emperor-nm-host` 发一条消息，Emperor 扩展的 origin 得到固定的 `EMPEROR_NOT_RUNNING` 回复，其他 origin 被拒绝且没有输出。本机已有 Emperor 在运行（`~/.emperor/run/nm-<uid>.sock` 存在）时跳过，绝不连到正在运行的 Emperor；CI 上不允许跳过。
- **app:// 路径穿越**：主窗口请求 `app://attachments/../../etc/passwd` 和另外九个编码变体（attachments、media、bundle、pet、pet-assets），都不能返回 `/etc/passwd` 或 Emperor Home 里埋的探针文件；提供文件的 host 必须返回错误状态，bundle 只能回落到 `index.html`。
- **窗口关闭后重开**：打开真实主窗口，关闭，再按程序坞的方式（`activate`）打开，新窗口必须加载界面并经 preload 连上 Core。
- **正常退出**：冒烟结束时走 `app.quit()`（与 Cmd+Q 相同：before-quit 刷写并关闭 Core，will-quit 写日志），`main.log` 必须在最后一次启动之后有 `quit` 记录，没有 Core 关闭失败或超时；退出后不能留下来自安装包或冒烟临时目录的进程，也不能在 LaunchServices 里留下 Helper 副本的登记。
- **从 0.1.0-preview.4 升级**：同一个包第二次启动，数据目录是 `packages/core/fixtures/emperor-home-0.1.0-preview.4` 的副本（由 0.1.0-preview.4 自己的 Core 写出，见其中的 `fixture.json` 与 `generate.ts`）。每个会话都要能列出、能读取，最后一条回复要显示在窗口里，模型和长期记忆要还在。回执只记录哈希，不记录对话内容。

之后 `scripts/ci/gate-negative-probe.mjs` 把包复制三份，分别去掉签名、去掉外层 app 的 hardened runtime、把 RunAsNode fuse 打开后重新封签，对每份运行同一个打包冒烟；三份都必须在启动之前被封签检查拒绝。这证明门禁本身会失败，而不只是没遇到失败。

已经有一个包时，只跑打包冒烟：

```bash
scripts/ci/pr-gate.sh --app "desktop/dist/mac-arm64/Emperor Agent.app"
```

## Nightly

`node scripts/ci/nightly.mjs --list` 列出全部步骤。顺序是：desktop build；视觉套件（`playwright.config.ts`，不含 `@perf` 用例；本机与其他 checkout 并行时可用 `EMPEROR_NIGHTLY_PLAYWRIGHT_CONFIG` 指向自己的端口配置）；视觉计时预算 `visual:perf`（带 `@perf` 标签的流式帧率与每帧脚本时间用例，单 worker 单独运行）；像素基线钩子（desktop 的 npm script `visual:baselines`，存在时运行，不存在时记为跳过；它只跑带 `@baseline` 的测试并与 `desktop/tests/visual/__baselines__/` 逐像素比对，用 `playwright.config.ts`，换端口用 `EMPEROR_VISUAL_PORT`，见[开发指南](README.md#质量门禁)）；`e2e-cu.mjs` 的 smoke、contract、extra、userbrowser、browser-security、fullstack、references、plugins、userbrowser-app、settings、renderer-security、diagnostics、updates（检查更新，对本机的假发布源）；kill -9 恢复各 20 次（`scripts/session-log-kill9.mjs`，另一组在每次 kill 后截掉日志尾部模拟断电）；`package:dir` 与 `package:probe`。

像素基线固定使用 macOS 26，临时 runner 的首选语言为 `zh-Hans`。只有带 `@baseline` 的测试使用固定的 Noto Sans SC 5.3.1 字体夹具（`desktop/tests/visual/fonts/noto-sans-sc`，OFL-1.1，完整许可与逐文件 SHA-256 一并保存）；Playwright 从本机路由提供这些字体，验收不请求外部字库。产品字体配置、未打标的视觉测试与真实 Electron 验收沿用系统字体。原生字体的可选文档字库与保留 UI 字库可能有相同 PostScript 名称、不同文件与版本，不能用机器各自的字库作跨机器像素基准。像素容差保持不变，字体夹具变更须显式更新并复核基线。

终端模拟输出使用固定的项目路径标签，避免本机与 CI 的 checkout 路径长度改变终端折行；夹具文件和 API 引用仍指向各自的真实工作目录。

带 `@baseline` 的页面在应用挂载前关闭 CSS 动画与过渡，新打开的弹窗也直接处于静止状态；不能只依靠截图时结束动画，否则合成器可能保留中间透明度。未打标测试继续检查真实动效。Electron 的浏览器契约夹具为表单提交页保留响应延迟，点击后等待导航条件，再检查代次变化和旧引用失效，不假定点击返回时页面已经提交。

PR 与发布的 arm64 / Intel 兼容构建仍在 macOS 15 上运行。失败时 workflow 保存 `nightly-visual-debug`（像素差异、实际字体映射与 Electron 验收截图）。完整视觉套件把失败 Trace 写到独立的 `desktop/test-results-visual/`，后续像素检查不会覆盖它。`runtime-context-*` 记录系统版本、SIP、普通／hardened runtime 两个独立控制程序的注入结果；Nightly 同时记录原生字体来源与版本。

`package:probe` 只有在系统明确关闭 SIP、且独立加固控制程序同样被注入时，才把动态库注入检查报告为 **UNVERIFIED**，退出码为 77；Nightly 对该步骤记录 `skipped` 和原因，不能把它当作验证成功。其余探测发现缺口、控制程序无法执行，或系统报告启用保护却仍能注入时，仍退出 1 并阻断。发布者必须把真实发布候选的两个架构下载到 SIP 开启的 Mac 上重跑 `node desktop/scripts/probe-packaged-hardening.cjs --app "<候选应用>.app"`，保留实际通过回执。Intel 包可在 Intel Mac 或已安装 Rosetta 的 Apple 芯片 Mac 上验证；注入库按目标架构编译，无法启动目标不会被算作通过。

`--only` 不自动补齐前置构建。干净 checkout 上的打包专项应使用 `--only build,visual-baselines,package,package:probe`；缺少构建输入的包会被正常拒绝，不能用来判断正式候选。

需要真实模型或真实外部子智能体的步骤只列出、不运行：`e2e-cu.mjs --mode=real`、`--mode=references-real`、`desktop/tests/external-agents.e2e.mjs`（它只接受 `--real`，同时驱动真实的 Codex 与 Claude Code）。委派用假 Claude Code / Codex 的测试在 `make check` 里。

每一步都会运行，前一步失败也不停；任何一步失败，退出码为 1。只有 `visual:perf` 会重试：它量的是墙钟时间，和其他 worker 或机器上的其他负载同时跑时会掉到 50 fps 以下（REL-04 本机运行时负载 13–17），所以单独、单 worker 运行，失败时用 `--last-failed` 把失败的用例再跑一次。重试通过记为通过，`summary.json` 里带 `retried: true` 与第一次的退出码，`report.md` 写「passed on retry」；重试仍失败才算失败。其他步骤（e2e、视觉断言、kill -9、打包）的失败是真实的，不重试。新增量墙钟时间的视觉用例时加 `{ tag: '@perf' }`。报告写在 `--report` 目录（默认 `desktop/dist/nightly-report`）：`summary.json`、`report.md` 和每一步的完整日志 `logs/<步骤>.log`。

失败时 `open-failure-issue.mjs` 开一个带 `nightly-failure`、`release-blocker` 标签的 issue，已有未关闭的就追加评论；完整运行（没有填 `only`）通过后自动关闭它。`--dry-run` 只打印计划，不调用 `gh`。

这个 issue 打开期间，或最近一次 nightly 失败、超过 72 小时没有运行时，两个发布 workflow 的第一步失败；pull request 不受影响。修好后在 Actions › nightly 手动运行一次完整的 nightly。

## 每周模型元数据

`weekly-model-metadata.mjs` 先运行 `sync-model-metadata.ts --check`。快照仍是最新时什么都不做；过期时运行同步，在 `bot/model-metadata-<日期>` 分支上提交快照与清单，再开 PR，正文列出各供应商增删改的模型，并提醒核对 `packages/core/src/model/metadata/overrides.ts`（见[模型元数据规范](../design/model-metadata.md)）。读不到 models.dev 或数据不合法时退出码为 2，job 失败。

GitHub 不会为 `GITHUB_TOKEN` 创建的 PR 自动触发 `ci.yml`：合并前推一个提交，或关闭后重新打开这个 PR，让 PR gate 跑一遍。仓库设置里需要允许 GitHub Actions 创建 pull request。

## 不做的事

- 不签名、不公证，workflow 里没有 Apple 或 Windows 签名凭据：Stable（`release.yml`）与 Preview 走同一条未签名、ad-hoc 封签的路径（[Stable 发布手册](../release/stable-release-runbook.md)）。
- 不使用 macOS 钥匙串；打包冒烟用临时 HOME 运行，凭据走 Emperor 自己的本地密钥。
- 不调用真实模型或付费接口。
