# Recon Cookbook · 一行命令速查

把每个审计维度都缩到"一两条 bash 命令"，不会被项目大小吓到。

---

## 通用前缀（屏蔽噪声目录）

```bash
PRUNE='-type d \( -name node_modules -o -name .venv -o -name venv \
  -o -name .git -o -name dist -o -name build -o -name __pycache__ \
  -o -name .next -o -name target -o -name coverage \) -prune'
```

之后所有 `find . $PRUNE -o ... -print` 都干净。

---

## 1. 项目体量

```bash
# top 20 大文件
eval "find . $PRUNE -o -type f \\( \
  -name '*.py' -o -name '*.ts' -o -name '*.tsx' -o -name '*.vue' \
  -o -name '*.go' -o -name '*.rs' -o -name '*.java' \\) -print" \
  | xargs wc -l | sort -rn | head -20

# 按语言分类
for ext in py ts vue go rs java; do
  c=$(eval "find . $PRUNE -o -name '*.$ext' -print" | xargs wc -l 2>/dev/null \
      | tail -1 | awk '{print $1}')
  echo ".$ext  $c"
done
```

---

## 2. 测试文件计数

```bash
eval "find . $PRUNE -o -type f \\( \
  -name 'test_*.py' -o -name '*_test.py' -o -name '*.spec.ts' \
  -o -name '*.test.ts' -o -name '*_test.go' \\) -print" | wc -l
```

> 0 → 测试维度直接 0/10。

---

## 3. 日志体检

```bash
# print / console.log 总数
eval "find . $PRUNE -o -type f \\( -name '*.py' -o -name '*.ts' \\) -print" \
  | xargs grep -cE '\bprint\(|console\.log\(' 2>/dev/null \
  | awk -F: '{s+=$2} END{print s}'

# 真用了 logger 框架的文件数
eval "find . $PRUNE -o -type f \\( -name '*.py' -o -name '*.ts' \\) -print" \
  | xargs grep -lE '(from loguru|^import logging|winston|pino|structlog|tracing::)' 2>/dev/null \
  | wc -l
```

> print > 30 且 logger 文件 = 0 → 日志 ≤ 3/10。

---

## 4. 异常吞噬体检

```bash
# Python except Exception 数
eval "find . $PRUNE -o -name '*.py' -print" \
  | xargs grep -cE 'except (Exception|BaseException)' 2>/dev/null \
  | awk -F: '{s+=$2} END{print s}'

# 看每个 except 后续是不是只 print/pass
eval "find . $PRUNE -o -name '*.py' -print" \
  | xargs grep -A2 'except Exception' 2>/dev/null \
  | grep -E 'print\(|pass$|return ""'
```

---

## 5. RCE / 注入风险

```bash
# shell=True
eval "find . $PRUNE -o -name '*.py' -print" \
  | xargs grep -nHE 'subprocess\.(run|call|Popen).*shell=True' 2>/dev/null

# eval/exec/pickle/yaml.load
eval "find . $PRUNE -o -name '*.py' -print" \
  | xargs grep -nHE '\beval\(|\bexec\(|pickle\.loads|yaml\.load[^_]' 2>/dev/null

# SQL 拼接
eval "find . $PRUNE -o -name '*.py' -print" \
  | xargs grep -nHE '\.execute\([^,)]*%|f"\s*SELECT.*\{|"\s*\+\s*request\.' 2>/dev/null
```

---

## 6. 路径穿越敏感点

```bash
eval "find . $PRUNE -o -name '*.py' -print" \
  | xargs grep -nHE 'Path\([^)]+\)\.resolve\(\)' 2>/dev/null \
  | grep -v test
# 然后逐条人工看后续是否 relative_to(workspace)
```

---

## 7. 明文密钥扫描（当前 + git 历史）

```bash
SECRET='(sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[ps]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-zA-Z0-9-]{20,})'

# 当前工作树
eval "find . $PRUNE -o -type f -print" \
  | xargs grep -nHE "$SECRET" 2>/dev/null | head -20

# git 历史
git log --all -p 2>/dev/null \
  | grep -E "^\+.*$SECRET" | head -20
```

---

## 8. 工程化对勾

```bash
for f in pyproject.toml package.json Dockerfile docker-compose.yml \
         .github/workflows .pre-commit-config.yaml .editorconfig \
         LICENSE CHANGELOG.md CONTRIBUTING.md SECURITY.md \
         pytest.ini .ruff.toml .eslintrc.cjs eslint.config.js \
         Makefile .env.example; do
  [ -e "$f" ] && echo "✓ $f" || echo "✗ $f"
done
```

---

## 9. Python 死依赖

```bash
# 直接依赖 vs 实际 import
DEPS=$(grep -oE '^[a-zA-Z][a-zA-Z0-9_.-]+' requirements.txt 2>/dev/null \
       | sed -E 's/[<>=].*//' | sort -u)
for pkg in $DEPS; do
  # 包名 - → 模块名 _
  mod="${pkg//-/_}"
  n=$(eval "find . $PRUNE -o -name '*.py' -print" \
      | xargs grep -lE "(^|\\s)(from|import) $mod([. \t]|\$)" 2>/dev/null | wc -l)
  printf '%-25s 引用文件: %d\n' "$pkg" "$n"
done | sort -k4 -n
```

> 引用 0 行的多半是死依赖；间接依赖（certifi/idna/h11 等）可以无视。

---

## 10. JS 死依赖（用 jq）

```bash
jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys[]' package.json \
  | while read pkg; do
    n=$(eval "find . $PRUNE -o -type f \\( -name '*.ts' -o -name '*.tsx' \
        -o -name '*.vue' -o -name '*.js' \\) -print" \
        | xargs grep -lE "from ['\"]$pkg['\"]|require\\(['\"]$pkg" 2>/dev/null \
        | wc -l)
    printf '%-30s %d\n' "$pkg" "$n"
  done | sort -k2 -n
```

---

## 11. 函数级 outline（任何文件）

```bash
grep -nE '^\s*(async\s+)?(def|function|export\s+(default\s+)?(function|class|const)|class)\s' \
  PATH_TO_FILE.py
```

> 一秒看出文件结构，比 sed 翻 200 行高效。

---

## 12. Git 健康度

```bash
git rev-list --count HEAD                    # 提交总数
git shortlog -sn --all | head -10            # 贡献者
git log --since='90 days ago' --name-only --pretty=format: \
  | grep -v '^$' | sort | uniq -c | sort -rn | head -10  # 90 天热点
git log --oneline | head -20                 # 最近 20 提交
```

> 90 天某文件被改 30+ 次 = churn 热点，多半是 god class 或 settings；优先审计。

---

## 13. 复杂度（如装了 radon / lizard）

```bash
# Python
pipx run radon cc src/ -nc -s | head -30
pipx run radon mi src/ -s | sort -k2 | head -20      # 维护性指数低分

# 跨语言
pipx run lizard src/ -C 10 -L 60       # CCN > 10 / 函数 > 60 行
```

---

## 14. WebSocket / HTTP 路由清单（aiohttp / FastAPI）

```bash
# FastAPI
grep -rnE '@(app|router)\.(get|post|put|delete|websocket)' --include='*.py'

# aiohttp
grep -rnE 'router\.add_(get|post|put|delete|route)|web\.WebSocketResponse' --include='*.py'
```

---

## 15. 超快全文体检（gloria / scc / tokei，如已装）

```bash
have() { command -v "$1" >/dev/null; }
have scc   && scc --no-cocomo .
have tokei && tokei .
have cloc  && cloc . --exclude-dir=node_modules,.venv,dist,build
```

---

## 一键脚本

以上全部内嵌在 [../scripts/recon.sh](../scripts/recon.sh)。优先用脚本，速查表是写新检查项时翻。
