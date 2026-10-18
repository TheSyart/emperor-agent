# 开发与验证外部执行器

> 文档状态：Active<br>
> 面向读者：贡献者、发布维护者<br>
> 最后核验：2026-10-17<br>
> 事实源：`packages/core/src/harness/delegation/adapters/`、`scripts/smoke-external-agents.mjs`、`desktop/tests/external-agents.e2e.mjs`、`desktop/electron-builder.yml`

当前固定 Claude Code 2.1.281、Claude Agent SDK 0.3.281、Codex 0.153.4。版本超出固定协议基线会禁用 profile；修改 expectedVersion 不能绕过。升级时一起更新规范化事件、Codex 双摘要 schema、contract 测试和真实两轮/问题/干预/取消/恢复证据。

Claude 使用 SDK startup 与自定义 managed spawn，业务问题经过权限回调转换，内部 Agent/Task/MCP/后台调度被关闭。Codex 使用应用独占 stdio app-server：initialize、initialized、thread/start 或 resume、turn/start；没有共享桌面 daemon 或 exec fallback。收到中断 ACK 后仍要等待原生终态及进程静止；未知协议请求默认拒绝。

源码运行 macOS helper 先执行 `node scripts/build-delegation-scanner.mjs`；Core pretest 与 desktop native build 会执行同一脚本。安装包携带已编译 helper，无需用户编译器。默认原生构建和 Preview 打包不执行 codesign 重签，Preview 的 afterSign 已禁用；可选的正式发布签名流程独立保留。SDK 作为 main external 依赖，打包包含 SDK 和目标平台可选 CLI binary；可执行 binary 在 asar 外。profile 仍需要明确可发现且匹配版本的 CLI，Codex 不由应用安装。

## 真实验收

下面两个入口会实际调用配置的父模型及启用的外部 CLI，消耗真实额度。必须显式 `--real`，state/workspace 必须为空；不得指向开发工作区或用户的真实 Emperor Home。认证从既有配置引用读取，原配置不修改；只把活动父模型复制到0600私有状态。失败保留目录，下一次使用新的目录。

```bash
node scripts/smoke-external-agents.mjs --backend both \
  --state-root /tmp/emperor-native-new/state \
  --workspace /tmp/emperor-native-new/workspace \
  --receipt-dir /tmp/emperor-native-new/receipts --real

node desktop/tests/external-agents.e2e.mjs --backend both \
  --state-root '/tmp/emperor electron new/state' \
  --workspace '/tmp/emperor electron new/workspace' \
  --receipt-dir '/tmp/emperor electron new/receipts' --real
```

可用 `--model-config <path>` 选择父模型配置；`--backend claude-code|codex|both` 选择目标。当前 smoke 的默认可执行路径针对 macOS Homebrew；其他安装位置需要调整测试配置。Electron 可加 `--electron-executable '<Preview.app>/Contents/MacOS/Emperor Agent'` 验证实际包与含空格路径。

scenario receipt 分别记录真实父调用、两个后端的身份映射、固定 blob/tree 审查、故意失败的宿主断言、原会话修复、当前树验证、预览和精确应用。Electron 额外保存界面截图、真实提问回答、重启无重放及 console 结果。receipt 含私有会话与本地路径，不能发布。

`node scripts/smoke-external-controls.mjs --real` 在全新临时仓库额外验证真实 Claude 队列、Codex 当前轮 steer、两家中断后延迟写不存在，以及越界与 Git 指针写入拒绝。

`make check`、`npm --prefix desktop run package:verify` 与真实外部协作分别是独立门禁。构建、mock、版本 probe 或截图存在都不能代替真实成功执行。macOS 证据只覆盖该机系统和架构；Linux、Windows 及其他架构必须保留未验证状态，直到目标机实际运行对应检查。

## 扩展接口

适配器实现 ExecutorAdapter/open/inspect，输出带 delegationId/runId/generation 的规范化事件。新后端必须明确声明 persistent session、queue、steer、问题、usage 和 OS 边界能力；不得假定与已有后端相同。只准经 ManagedAgentProcess 启动，以 shell=false、私有环境、受管 ownership 与严格输出上限运行。原生会话恢复、终态、错误和当前 turn fencing 都必须有 contract 与真实证据。

公共入口集中在 `api/operations.ts` 的严格 schema；renderer 只调用已有通用 IPC。不要添加任意 argv/env/owner 的启动接口，也不要让子代理控制宿主验收或 Git 应用。验证命令是单独的人工授权 criteria，不是原生启动参数。

当前桌面主进程使用 `LocalSecretStorage`，密钥在状态目录 `secret-storage/key`，不导入 Electron safeStorage。packaged smoke 必须真实验证本地密钥、凭据库重载、主密码 KDF 和 macOS 浏览器配对重载，并在 `operations.secretStorage` 保存结果。不能只删除原钥匙串检查而省略存储验收。

模型列表由 `ExecutorModelCatalogService` 经实际隔离运行时发现，Codex 的配置导入和 Claude 的模型/别名策略在 `local-model-config.ts`、`runtime.ts` 维护。新增提供方兼容须同时验证发现与执行一致，覆盖刷新失败保留缓存、认证/提供方变化隔离、下拉草稿及默认模型的修订冲突。候选 API 只执行初始化与控制查询，不发送推理提示；不得由返回目录推断原生工具可用。
