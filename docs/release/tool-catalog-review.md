# ToolCatalog 发布审核清单

> 文档状态：Active<br>
> 面向读者：修改 ToolCatalog 的开发者与发布审核者<br>
> 最后核验：2026-07-19<br>
> 事实源：`packages/core/src/environment/tool-catalog.json`、catalog schema、环境安装 adapters、`packages/core/src/environment/sandbox.ts`

`packages/core/src/environment/tool-catalog.json` 是随应用签名发布的静态执行策略，不是普通展示数据。catalog 决定可探测、下载和执行的程序；任何变更都按供应链与命令执行安全变更审核。

当前命令 sandbox helper 不由 ToolCatalog 下载：macOS `sandbox-exec` 与 Linux `bwrap` 被视为 host-OS capability，Windows 明确 unsupported。它们仍受固定路径、固定 probe argv 与 packaged smoke receipt 审核；不得因为“不在 catalog”就接受 PATH 首项、renderer/model 指定 helper 或静默 unsandboxed fallback。未来若把 bwrap/Landlock/Windows helper 随应用分发，必须先加入 catalog/签名资源清单，固定版本、SHA-256、publisher 与 license，再修改 backend selection。

## 变更信息

- [ ] 记录变更原因、工具 ID、旧/新 pinned version 和受影响平台。
- [ ] 更新 catalog `release` revision，确保安装计划的 stale 检测可以识别变化。
- [ ] 版本是具体 patch release；`requirement` 与 probe 输出格式一致。
- [ ] 不通过远程配置、renderer、模型输出或环境变量动态增加策略。

## 来源与许可

- [ ] source URL 是厂商或项目的公开 HTTPS 官方来源，不含凭据、私有地址、短链或用户可控模板。
- [ ] direct binary/archive/installer 为每个平台和架构记录已独立核验的 SHA-256。
- [ ] publisher 与官方签名身份一致；Windows Authenticode、macOS package signing 等平台校验没有被降级。
- [ ] license ID 已存在于 catalog，SPDX、名称和 URL 准确；新增许可经过人工确认。
- [ ] `estimatedBytes` 与实际下载数量级一致，UI 能在确认前展示。

## 命令与权限

- [ ] probe 与 install 都使用固定 executable/argv，`shell:false`；没有 shell operator、脚本拼接或用户输入插值。
- [ ] 新 command 同步加入 `catalog.ts` 的静态 allowlist，并有拒绝未知参数的测试。
- [ ] strategy 的 target、依赖顺序、提权和二次确认标记符合各平台行为。
- [ ] MSVC Build Tools、系统安装器或其他大型/高权限步骤保持 `requiresSeparateConfirmation:true`。
- [ ] 安装后 probe 能证明目标版本实际可用；失败返回明确 error code，不把下载成功视为安装成功。

## 下载安全

- [ ] HTTPS、DNS/IP SSRF 防护、安全重定向上限、下载/解压大小与超时仍生效。
- [ ] 摘要或 publisher 不匹配时文件不会执行，临时文件和 job 状态可安全清理。
- [ ] Windows、macOS、Ubuntu adapter 的 PATH 更新保持用户级优先，不缓存提权凭据。
- [ ] cancel、interrupted 和应用重启路径重新 probe，不自动续装未知系统状态。

## 测试与签收

- [ ] 更新 catalog schema、allowlist、adapter、download 与 process runner 的 RED/GREEN 测试。
- [ ] 执行 `npm test --workspace @emperor/core`、Core typecheck/lint 和 `make check`。
- [ ] 在对应平台 internal workflow 生成 adapter receipt；receipt 不含 HOME、用户名、token 或完整 PATH。
- [ ] packaged smoke 证明最小 PATH 下应用可启动，且不会自动安装工具。
- [ ] packaged smoke 的 Diagnostics receipt 包含 `sandbox.backend/status/provenance=host-os`；macOS 必须是可用 Seatbelt，Linux 必须明确 bwrap available/unavailable/error，Windows 必须明确 unsupported。receipt 不包含 helper 绝对路径、profile、HOME 或 PATH。
- [ ] PR/commit 记录 catalog revision、来源、摘要核验方式、许可结论和平台 receipt。

任一项不能确认时，不合并 catalog 变更，也不通过修改 Zod schema、allowlist 或 failure mode 绕过审核。
