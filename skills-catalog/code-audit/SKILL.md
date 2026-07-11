---
name: code-audit
description: Audit a whole project for code quality, architecture, security, performance, and engineering maturity. Use when the user asks to "audit the project", "code review", "review the codebase", produce a technical-debt report, or fill an audit template. Works for Python / TS / Go / Rust monorepos including agent projects.
---

# Code Audit

按"先证据、后判断、再路线图"的顺序产出一份能落地的审计报告。

---

## 工作铁律

1. **不要凭印象填表**。每次开工先跑 `scripts/recon.sh` 拿硬数据，所有评分必须有命令输出 / 文件:行号兜底。
2. **每个问题三件套**：`file:line` + 代码片段（≤ 6 行）+ 修复 patch（伪代码或具体 diff）。少一件就不算合格。
3. **风险 = 缺陷 × 部署上下文**。同一个 `shell=True`，CLI 个人脚本 = 低；暴露端口的 WebUI = 极高。审计前先问清楚"打算给谁用 / 怎么部署"。
4. **三段式路线图**，不开扁平 todo：P0 止血（安全 / 数据正确性） → P1 提质（测试 / 日志 / 工程化） → P2 升级（架构 / 商业化）。
5. **诚实打分，不调和**。0 测试给 0/10；后面写"作为个人项目可接受"的语境注脚就行。
6. **节省 round-trip**。Bash 调用尽量串多条命令；同一个文件优先 outline（grep `def`/`class`）再按行号 sed。

---

## 五阶段流程

### 阶段 0 · 定调（≤ 30 秒，一次到位）

跟用户或当前上下文确认三件事，三件都不知道就**先问再做**：

- 项目类型：Web 前端 / 后端 / 全栈 / Agent / 库 / CLI 工具
- 部署上下文：纯本地脚本？SaaS？多租户？开源给极客？
- 审计目的：拿来评 PR / 准备发版 / 决定是否商业化 / 接手二开

定调决定后续每个评分的语义。**没有部署上下文就给安全打分是没意义的。**

### 阶段 1 · 侦察（≤ 5 分钟，跑脚本）

调用 [scripts/recon.sh](scripts/recon.sh)。它一次性产出：

- 顶层目录 + 工程化文件存在性（pyproject、Dockerfile、CI、lint 配置 …）
- LoC 排序前 15 文件（god class 嫌疑）
- 总代码量
- 测试文件计数
- print / logger / except 计数
- 依赖文件原文（requirements / package.json / go.mod 等）
- git 基本信息（提交数、贡献者、热点文件、最近 90 天 churn）
- 危险代码 pattern grep（`shell=True`、`eval(`、`exec(`、`pickle.loads`、明文密钥模式）

把脚本输出整段贴到草稿区，**全部审计结论从这里取证**。脚本输出本身不直接进最终报告，是工作底稿。

### 阶段 2 · 定向探查（按发现深入）

根据侦察结果挑 ≤ 5 个最可疑点深读，每点用 `Read`/`grep -n` 拿到精确 file:line。常见入口：

- 最大文件 → outline 是否单一职责
- 安全敏感文件（auth/security/shell/filesystem/upload）→ 围栏检查
- 配置回传路径（config payload / bootstrap API）→ 密钥脱敏检查
- 异常处理热区 → 是否吞 traceback
- 公网入口（HTTP/WS handler）→ 鉴权 + 输入校验

**每点产出一段笔记**：现状代码片段 + 问题机制 + 影响 + 修复 sketch。

### 阶段 3 · 填表（按用户提供模板或 [templates/audit-report.md](templates/audit-report.md)）

把第 1–2 阶段的笔记填进模板。规矩：

- 每个"分析"段落 ≤ 5 行；超 5 行说明在塞水。
- 每个评分给一行依据：`X/10 —— 因为 [证据]`。
- "解决方案"必须给具体 patch（10–30 行内），不写"建议加日志"这种废话。
- 最后"下一步最优先 3 件事"按工时估算（4h / 半天 / 1 天），让用户能立即排期。

### 阶段 4 · 自检（提交前）

读自己的报告一遍，碰到这些信号就退回去补：

- 出现"建议提高 / 加强 / 优化"等动词无宾语 → 改成具体动作
- 出现整段没有 `file:line` 或代码块 → 加证据
- 评分跨度 < 4 分（全 6/10）→ 多半在和稀泥，重新盘
- 路线图扁平没分阶段 → 拆 P0/P1/P2
- 安全章节没"如果在公网会怎样"的反例 → 补

---

## 红旗目录（按出现频率排）

详见 [references/red-flags.md](references/red-flags.md)。最常见 10 项：

1. `subprocess.run(..., shell=True)` 无 `timeout` / 无 `cwd` 限制 → RCE
2. `Path(user_input).resolve()` 无 `relative_to(workspace)` → 路径穿越
3. `/api/config` 等返回 `config.raw` 含 apiKey → 密钥泄露
4. `except Exception` + 仅 `print(exc)` → 吞 traceback
5. `print()` 满天飞 + 已声明 logger 依赖未用 → 工具配置半成品
6. `requirements.txt` 钉死全部传递依赖（`pip freeze` 风格）→ 升级矩阵爆炸
7. 直接依赖列在 deps 里但代码 0 import → 死依赖
8. 单文件 > 500 LoC、单函数 > 80 LoC → god class / god function
9. `tests/` 不存在 → 直接 0/10
10. CI 不存在 + lint 不存在 + pre-commit 不存在 → 工程化 ≤ 2/10

---

## 评分尺（重要）

详见 [references/scoring-rubric.md](references/scoring-rubric.md)。核心准则：

- **0/10**：完全没有（0 测试、0 logger、0 类型注解）
- **3/10**：尝试过但本质不可用（写了 print 当日志、TODO 留了一堆）
- **5/10**：能跑但不可演进（无回归保护、维护靠记忆）
- **7/10**：日常使用稳定，重构无安全网但 review 能挡
- **9/10**：可商业化、多人协作、有完整监控
- **10/10**：业内标杆

**不允许给 8.5/10 这种**。整数即可，少装精确。

---

## 反模式（写报告时必须避免）

- ❌ "代码质量较低，建议改进" → 没量化、没动作
- ❌ "应该使用 [框架 X]" → 不给现状失败的证据
- ❌ "整体良好" + 同时存在 RCE → 自相矛盾
- ❌ 全维度均匀打 6/10 → 没分辨力
- ❌ 列 30 个 P1 → 等于没排序
- ❌ 给"上层抽象"建议但不给落地代码 → 等于没说

---

## 资源索引

- [scripts/recon.sh](scripts/recon.sh) —— 侦察脚本，第 1 阶段必跑
- [references/red-flags.md](references/red-flags.md) —— 完整反模式目录
- [references/scoring-rubric.md](references/scoring-rubric.md) —— 8 维评分尺
- [references/recon-cookbook.md](references/recon-cookbook.md) —— 侦察命令速查
- [templates/audit-report.md](templates/audit-report.md) —— 默认审计模板（用户没给模板时用这个）
