# Red Flags Catalog

按"严重 → 一般 → 风格"分级。每条给：识别命令 + 为什么是问题 + 修复方向。

---

## A · 严重（直接降一档评级）

### A1. RCE：`subprocess.run(..., shell=True)` 无 timeout / 无 cwd 限制

**识别**：

```bash
grep -rnE 'subprocess\.(run|call|Popen).*shell=True' --include='*.py' .
```

**为什么严重**：在 agent 项目里，模型输出能直接经此函数触发任意系统命令；prompt-injection 即整机沦陷。即使非 agent 项目，把用户输入拼到 shell 字符串也是教科书级 RCE。

**修复 sketch**：

```python
result = subprocess.run(
    command, shell=True, capture_output=True, text=True,
    timeout=120, cwd=workspace,
)
# 加危险前缀 deny list；或者改用 shlex + shell=False
```

---

### A2. 路径穿越：`Path(user_input).resolve()` 无 `relative_to(workspace)`

**识别**：

```bash
grep -rnE 'Path\([^)]+\)\.resolve\(\)' --include='*.py' . | grep -v test
```

然后看每个 hit 后续是否调用 `relative_to` 或字符串前缀比对。

**为什么严重**：`/etc/passwd`、`~/.ssh/id_rsa` 是绝对路径，`Path(p).expanduser().resolve()` 直接命中真实文件。`..` 也能逃出 workspace。

**修复 sketch**：

```python
p = Path(user_path).expanduser()
if not p.is_absolute(): p = workspace / p
p = p.resolve()
ws = workspace.resolve()
if not (p == ws or str(p).startswith(str(ws) + os.sep)):
    raise ValueError(f"path outside workspace: {p}")
```

---

### A3. 密钥回传前端：`/api/config` 等返回 `config.raw` 含 apiKey

**识别**：

```bash
grep -rnE '"config":\s*config\.raw|json\.dumps\(config|return config' \
  --include='*.py' .
# 然后追到 config.raw 是否包含 apiKey 字段
```

**为什么严重**：DevTools Network 一秒可见；浏览器历史、扩展、代理都缓存；一旦 `--host 0.0.0.0` 即 LAN 大泄漏。

**修复 sketch**：服务端 `_redact_apikeys` 把 `apiKey` 改成 `"***" + last4`；POST 时检测占位符，保留服务端原值。

---

### A4. 密钥进入 git 历史

**识别**：

```bash
git log --all -p | grep -E '^\+.*(sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[ps]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})'
```

**为什么严重**：即使 force-push 删除，GitHub 缓存与 fork 都已存档。

**修复**：撤销密钥 → 用 `git filter-repo` 清历史 → force-push → 通知所有 collaborator 重新 clone。

---

### A5. 反序列化 / 模板注入：`pickle.loads(data)` / `yaml.load(stream)` / `eval(input)`

**识别**：

```bash
grep -rnE 'pickle\.loads|yaml\.load[^_]|\beval\(|\bexec\(' --include='*.py' .
```

**修复**：`yaml.safe_load`、`pickle` → `json` / `msgpack`、`eval` → `ast.literal_eval` 或重新设计。

---

### A6. SQL 字符串拼接

**识别**：

```bash
grep -rnE '\.execute\([^,)]*%|f"\s*SELECT.*\{|"\s*\+\s*request\.' \
  --include='*.py' --include='*.ts' .
```

**修复**：参数化查询；ORM。

---

## B · 严重（架构 / 数据正确性）

### B1. 异常吞噬：`except Exception` 仅 `print(exc)` / `pass`

**识别**：

```bash
grep -rnB0 -A2 'except Exception' --include='*.py' . | grep -E 'print\(|pass|return ""'
```

**为什么严重**：bug 静默漏过，traceback 丢失；监控里看不到错。

**修复**：`logger.exception("context: ...")` 至少留 trace；用户 facing 错误用单独的窄 except。

---

### B2. 非原子写文件（`open(path,'w')` 写关键状态）

**识别**：写 MEMORY.md / config.json / 状态文件的位置，搜 `open(.*'w'` 或 `path.write_text`。崩溃中断会留半文件。

**修复**：写到 `path.tmp` 后 `os.replace(tmp, path)`。

---

### B3. 共享可变状态无锁（`self.history`、`event_log` 在 async 多客户端共用）

**识别**：找 `class .*State|class .*Manager`，看其 list/dict 字段在多个 handler 修改，是否有 `asyncio.Lock`。

**修复**：要么单写者（明示文档化），要么加锁。

---

### B4. 循环依赖 / import 黑魔法

**识别**：

```bash
python -c "import importlib, pkgutil; [importlib.import_module(m.name) for m in pkgutil.walk_packages(['<pkg>'])]"
```

看是否报 ImportError；或 `pydeps <pkg>` 出图找环。

**修复**：把共享类型抽到独立 `types.py`；延迟 import 是 hack 不是解。

---

### B5. 没有围栏的 `Tool` 集合（agent 项目特有）

agent 主 loop 直接调任意 `Tool.execute`，如果工具集合包含 `run_command` / `write_file` 且**没有运行时审批 + 工作区围栏**，模型一次错答就翻车。

---

## C · 一般（影响可维护性）

### C1. 单文件 > 500 LoC / 单函数 > 80 LoC / 类 > 300 LoC

**识别**：recon.sh 的 section 2 + section 8 outline 直接看出。

**修复**：按职责切；先抽纯函数。

---

### C2. 32 处 `print` + 0 个 logger import

**识别**：见 [recon-cookbook.md](recon-cookbook.md) 的"日志一行体检"。

**修复**：装 loguru 一次性替换；rotation；按级别。

---

### C3. 0 测试文件 + 0 CI

直接 0/10。优先补**纯函数**的单测（不需要 fixture）。

---

### C4. `requirements.txt` 钉死全部传递依赖

**识别**：行数 > 直接 import 包数 × 2，且包含 `certifi` / `idna` / `h11` / `sniffio` 等明显间接依赖。

**修复**：拆 `requirements.in`（直接） + `requirements.lock`（pip-compile / uv 生成）。

---

### C5. 死依赖（声明在 deps 但代码 0 import）

**识别**：recon.sh 6.1 / 6.2 输出"引用文件数 0"的行。

**修复**：删掉，或者真的用起来（loguru 是典型）。

---

### C6. 工程化抓手缺失（pyproject / lint / CI / Docker / pre-commit）

清单见 recon.sh 的 section 1。每缺一个 ≈ 工程化分扣 1。

---

### C7. 上帝类 / 上帝构造函数（吃 10+ 参数）

**识别**：

```bash
grep -nE 'def __init__\(' --include='*.py' -A 20 . | grep -c '^\s\+self\.'
```

或人工看 `AgentLoop.__init__` 之类。

**修复**：拆 facade，引入 DI 容器或 dataclass config。

---

## D · 风格 / 可读性（不直接影响评级，但累积扣分）

### D1. 中英文混用 docstring 但函数名英文 — 可接受

### D2. 命名冲突（包名与脚本名同名 `agent.py` vs `agent/`） — 改名脚本

### D3. 魔法数字 / 重复字符串 — 抽常量

### D4. 不必要的 `from typing import Optional`（>= 3.10 用 `X | None`）

### D5. `# type: ignore` / `eslint-disable-next-line` 散落 — 收敛到一处或修根因

### D6. 未使用 import / 未使用变量 — ruff `--select F401,F841` 全自动

---

## 风险加权（部署上下文 → 等级浮动）

| 缺陷             | 个人 CLI | 内网工具 | 对外 SaaS |
| ---------------- | -------- | -------- | --------- |
| RCE 工具无围栏   | 中       | 高       | 致命      |
| API key 回传前端 | 中       | 高       | 致命      |
| 0 测试           | 中       | 高       | 致命      |
| print 无 logger  | 低       | 中       | 高        |
| 单文件 500+ LoC  | 低       | 中       | 中        |

**判断口径**：先问用户"这个项目部署形态"，再按列查，再写"风险等级"列。
