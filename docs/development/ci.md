# CI 门禁

> 文档状态：Active<br>
> 面向读者：贡献者、发布维护者<br>
> 最后核验：2026-10-21<br>
> 事实源：`.github/workflows/ci.yml`、`nightly.yml`、`weekly-model-metadata.yml`、`release-preview.yml`、`release.yml`、`scripts/ci/`、`scripts/session-log-kill9.mjs`、`desktop/scripts/run-packaged-smoke.cjs`

CI 只跑 macOS（项目不支持 Windows 和 Linux）。每个 job 只调用一个脚本，脚本里写着它做的全部事情，所以本机用同一条命令就能重跑；GitHub 只负责按时间或事件把它们排上 runner。

## 各 job 做什么

| Workflow 与 job                                               | 触发                                            | Runner                       | 运行                                                                                                                        | 本机重跑                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ci.yml` › macOS PR gate (arm64)                              | pull request；推送到 `main`、`release/**`；手动 | `macos-15`                   | `scripts/ci/pr-gate.sh`：`make check`、`package:verify`、未封签副本探测                                                     | `scripts/ci/pr-gate.sh`（`--dry-run` 只列步骤）                                                        |
| `ci.yml` › macOS x64 build                                    | 同上                                            | `macos-15-intel`             | `scripts/ci/pr-gate.sh --build-only`：desktop build 代替 `make check`，其余相同                                             | Intel Mac 上 `scripts/ci/pr-gate.sh --build-only`                                                      |
| `nightly.yml` › macOS nightly                                 | 每天 18:00 UTC；手动（可填 `only`）             | `macos-15`                   | `scripts/ci/nightly.mjs`：视觉套件、像素基线钩子、Electron e2e、kill -9、加固探测；失败时 `open-failure-issue.mjs` 开 issue | `node scripts/ci/nightly.mjs`，或 `--only e2e:settings,kill9`；`--list` 看全部步骤                     |
| `weekly-model-metadata.yml` › models.dev snapshot             | 每周一 02:00 UTC；手动                          | `macos-15`                   | `scripts/ci/weekly-model-metadata.mjs`：models.dev 快照过期时刷新并开 PR                                                    | `node scripts/ci/weekly-model-metadata.mjs --dry-run`（只看计划，不改文件），或 `npm run models:check` |
| `release-preview.yml`、`release.yml` 的第一步                 | Preview tag；Stable 手动                        | 各自的 job                   | `scripts/ci/require-green-nightly.mjs`：最近一次 nightly 不绿、超过 72 小时或有未关闭的失败 issue 时，发布直接失败          | 需要 `gh` 登录：`node scripts/ci/require-green-nightly.mjs`                                            |
| `release-internal.yml`、`environment-installers-internal.yml` | 手动                                            | `macos-15`、`macos-15-intel` | 内部未签名包与 macOS 环境适配器回执                                                                                         | `npm --prefix desktop run package:verify`                                                              |

`make check`（`scripts/check.sh`）本身还运行 `scripts/ci/check-action-pins.mjs` 与 `scripts/ci/check-workflows.mjs`：

- 每个 `uses:` 都必须写成 40 位提交哈希，版本号写在旁边的注释里，例如 `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`。升级一个 action 时，先 `git ls-remote https://github.com/actions/checkout refs/tags/v4.4.0` 查到提交，再同时改哈希和注释。
- 工作流 lint 检查上表的对应关系：PR gate 在 arm64 和 Intel 上调用 `pr-gate.sh`；nightly 只按计划运行，从不在 pull request 或 push 上运行，并在失败时开 issue；weekly 是每周一次并有开 PR 所需的权限；两个发布 workflow 都先检查 nightly；除只做汇总、证明和发布的 job（`release-preview.yml` 的 aggregate / publish，以及 `release.yml` 里尚未改为未签名路径的冻结签名链）外，所有 job 都跑在 macOS 上；workflow 里引用的 `scripts/ci/*` 都存在。

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

`node scripts/ci/nightly.mjs --list` 列出全部步骤。顺序是：desktop build；视觉套件（`playwright.config.ts`，本机与其他 checkout 并行时可用 `EMPEROR_NIGHTLY_PLAYWRIGHT_CONFIG` 指向自己的端口配置）；像素基线钩子（desktop 的 npm script `visual:baselines`，存在时运行，不存在时记为跳过）；`e2e-cu.mjs` 的 smoke、contract、extra、userbrowser、browser-security、fullstack、references、plugins、userbrowser-app、settings、renderer-security、diagnostics；kill -9 恢复各 20 次（`scripts/session-log-kill9.mjs`，另一组在每次 kill 后截掉日志尾部模拟断电）；`package:dir` 与 `package:probe`。

需要真实模型或真实外部执行器的步骤只列出、不运行：`e2e-cu.mjs --mode=real`、`--mode=references-real`、`desktop/tests/external-agents.e2e.mjs`（它只接受 `--real`，同时驱动真实的 Codex 与 Claude Code）。委派的假执行器测试在 `make check` 里。

每一步都会运行，前一步失败也不停；任何一步失败，退出码为 1。报告写在 `--report` 目录（默认 `desktop/dist/nightly-report`）：`summary.json`、`report.md` 和每一步的完整日志 `logs/<步骤>.log`。

失败时 `open-failure-issue.mjs` 开一个带 `nightly-failure`、`release-blocker` 标签的 issue，已有未关闭的就追加评论；完整运行（没有填 `only`）通过后自动关闭它。`--dry-run` 只打印计划，不调用 `gh`。

这个 issue 打开期间，或最近一次 nightly 失败、超过 72 小时没有运行时，两个发布 workflow 的第一步失败；pull request 不受影响。修好后在 Actions › nightly 手动运行一次完整的 nightly。

## 每周模型元数据

`weekly-model-metadata.mjs` 先运行 `sync-model-metadata.ts --check`。快照仍是最新时什么都不做；过期时运行同步，在 `bot/model-metadata-<日期>` 分支上提交快照与清单，再开 PR，正文列出各供应商增删改的模型，并提醒核对 `packages/core/src/model/metadata/overrides.ts`（见[模型元数据规范](../design/model-metadata.md)）。读不到 models.dev 或数据不合法时退出码为 2，job 失败。

GitHub 不会为 `GITHUB_TOKEN` 创建的 PR 自动触发 `ci.yml`：合并前推一个提交，或关闭后重新打开这个 PR，让 PR gate 跑一遍。仓库设置里需要允许 GitHub Actions 创建 pull request。

## 不做的事

- 不签名、不公证，workflow 里没有 Apple 或 Windows 签名凭据（`release.yml` 里冻结的 Stable 签名链将改为与 Preview 相同的未签名路径）。
- 不使用 macOS 钥匙串；打包冒烟用临时 HOME 运行，凭据走 Emperor 自己的本地密钥。
- 不调用真实模型或付费接口。
