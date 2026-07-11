#!/usr/bin/env bash
# Code Audit · Recon Script
# 用法: bash scripts/recon.sh [project_root]
# 输出可直接喂回 LLM 做 Phase 1 数据底稿。

set -uo pipefail

ROOT="${1:-.}"
cd "$ROOT" || { echo "✗ cd failed: $ROOT"; exit 1; }

# ───────────────────────────── helpers ─────────────────────────────
hr()  { printf '\n=== %s ===\n' "$1"; }
have(){ command -v "$1" >/dev/null 2>&1; }

# 排除目录：按 -name 在任意层级 prune
PRUNE_NAMES=(.git .venv venv node_modules dist build __pycache__ \
             .next .cache target coverage .tox .mypy_cache .pytest_cache \
             .ruff_cache .turbo .nuxt .svelte-kit .parcel-cache .gradle \
             vendor bin obj out)

# 构造 -type d \( -name a -o -name b ... \) -prune
build_prune() {
  local out=("-type" "d" "(")
  local first=1
  for n in "${PRUNE_NAMES[@]}"; do
    if [ "$first" = "1" ]; then first=0; else out+=("-o"); fi
    out+=("-name" "$n")
  done
  out+=(")" "-prune")
  printf '%s\0' "${out[@]}"
}

# prune_find <额外条件...> —— 嵌套 prune
prune_find() {
  local prune_args=()
  while IFS= read -r -d '' a; do prune_args+=("$a"); done < <(build_prune)
  find . "${prune_args[@]}" -o "$@" -print 2>/dev/null
}

count() { wc -l 2>/dev/null | awk '{print $1}'; }

# ─────────────────────────── 0. 基本信息 ───────────────────────────
hr "0. 项目根 + 顶层目录"
pwd
ls -la --color=never 2>/dev/null || ls -la

hr "0.1 README 头 30 行"
[ -f README.md ] && head -30 README.md || echo "(no README.md)"

# ───────────────────────────── 1. 工程化 ────────────────────────────
hr "1. 工程化文件存在性 (✓/✗)"
ENG_FILES=(
  pyproject.toml setup.py setup.cfg requirements.txt Pipfile Pipfile.lock
  package.json package-lock.json yarn.lock pnpm-lock.yaml bun.lockb
  go.mod Cargo.toml composer.json Gemfile pom.xml build.gradle
  Dockerfile docker-compose.yml .dockerignore
  .github/workflows .gitlab-ci.yml .circleci/config.yml
  .pre-commit-config.yaml lefthook.yml .husky
  .editorconfig .gitattributes .gitignore .env .env.example .env.template
  .ruff.toml .flake8 .isort.cfg mypy.ini pytest.ini tox.ini pylintrc
  .eslintrc.cjs .eslintrc.json eslint.config.js .prettierrc .prettierrc.json
  biome.json deno.json
  Makefile justfile Taskfile.yml
  CHANGELOG.md CONTRIBUTING.md LICENSE SECURITY.md CODE_OF_CONDUCT.md
)
for f in "${ENG_FILES[@]}"; do
  [ -e "$f" ] && printf '  ✓ %s\n' "$f" || printf '  ✗ %s\n' "$f"
done

# ───────────────────────────── 2. 代码体量 ─────────────────────────
hr "2. 代码体量 (top 20 by LoC)"
prune_find -type f \( -name '*.py' -o -name '*.ts' -o -name '*.tsx' \
            -o -name '*.js' -o -name '*.jsx' -o -name '*.vue' \
            -o -name '*.go' -o -name '*.rs' -o -name '*.java' \
            -o -name '*.kt' -o -name '*.rb' -o -name '*.cs' \) \
  | xargs wc -l 2>/dev/null | sort -rn | head -22

hr "2.1 总代码量 (按语言)"
for ext in py ts tsx vue js jsx go rs java kt rb cs; do
  c=$(prune_find -name "*.$ext" -type f | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
  [ -n "${c:-}" ] && [ "$c" != "0" ] && printf '  %-6s %s\n' ".$ext" "$c"
done

# ───────────────────────────── 3. 测试 ─────────────────────────────
hr "3. 测试文件"
TESTS=$(prune_find -type f \( -name 'test_*.py' -o -name '*_test.py' \
        -o -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' \
        -o -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.spec.js' \
        -o -name '*_test.go' -o -name '*_test.rs' \) | wc -l | xargs)
echo "测试文件总数: $TESTS"
[ "$TESTS" != "0" ] && prune_find -type f \( -name 'test_*.py' -o -name '*_test.py' \
  -o -name '*.test.ts' -o -name '*.spec.ts' -o -name '*_test.go' \) | head -10

# ───────────────────────────── 4. 日志 / 异常 ──────────────────────
hr "4.1 print/console 计数"
for ext in py ts vue js; do
  c=$(prune_find -name "*.$ext" -type f -exec grep -cE '\bprint\(|console\.log\(' {} + 2>/dev/null \
      | awk -F: '{s+=$2} END{print s+0}')
  [ -n "${c:-}" ] && [ "$c" != "0" ] && printf '  .%s 中 print/console.log: %s 处\n' "$ext" "$c"
done

hr "4.2 logger 框架使用"
prune_find -type f \( -name '*.py' -o -name '*.ts' -o -name '*.js' \) \
  -exec grep -lE '(from loguru|import logging|from .*logger|winston|pino|structlog|zap|tracing::)' {} + 2>/dev/null \
  | head -5
echo "---"
echo "已导入 logger 的文件数:"
prune_find -type f \( -name '*.py' -o -name '*.ts' \) \
  -exec grep -lE '(from loguru|^import logging|winston|pino|structlog)' {} + 2>/dev/null | wc -l | xargs

hr "4.3 except / catch 模式"
EXC_PY=$(prune_find -name '*.py' -type f -exec grep -cE 'except (Exception|BaseException)' {} + 2>/dev/null \
        | awk -F: '{s+=$2} END{print s+0}')
EXC_TS=$(prune_find -type f \( -name '*.ts' -o -name '*.js' \) -exec grep -cE 'catch \(' {} + 2>/dev/null \
        | awk -F: '{s+=$2} END{print s+0}')
echo "  Python except Exception/BaseException: $EXC_PY"
echo "  TS/JS catch: $EXC_TS"

# ───────────────────────────── 5. 危险代码 pattern ─────────────────
hr "5.1 RCE 风险"
prune_find -type f \( -name '*.py' \) -exec grep -nE '(subprocess\.|os\.system|os\.popen|os\.exec)' {} + 2>/dev/null \
  | grep -E 'shell=True|os\.system|os\.popen' | head -10
echo "---"
prune_find -type f \( -name '*.py' \) -exec grep -nHE 'eval\(|exec\(|pickle\.loads|yaml\.load[^_]' {} + 2>/dev/null | head -10

hr "5.2 路径敏感"
prune_find -type f -name '*.py' -exec grep -nHE 'Path\(.+\)\.resolve\(\)' {} + 2>/dev/null \
  | grep -v test | head -8

hr "5.3 明文密钥模式 (历史 + 当前)"
# 当前 working tree
prune_find -type f \( -name '*.py' -o -name '*.ts' -o -name '*.json' -o -name '*.env*' \) \
  -exec grep -nHE '(sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[ps]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})' {} + 2>/dev/null \
  | head -10
echo "--- (git history 扫描) ---"
have git && git rev-parse --is-inside-work-tree >/dev/null 2>&1 && \
  git log --all -p 2>/dev/null \
    | grep -E '^\+.*(sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})' \
    | head -5

hr "5.4 SQL / XSS / template 注入嫌疑"
prune_find -type f \( -name '*.py' -o -name '*.ts' \) \
  -exec grep -nHE '\.execute\(.*%|\+\s*request\.|f"SELECT.*\{|innerHTML\s*=|v-html=' {} + 2>/dev/null \
  | head -10

# ───────────────────────────── 6. 依赖体检 ─────────────────────────
hr "6.1 Python 依赖直接引用计数"
if [ -f requirements.txt ] || [ -f pyproject.toml ]; then
  DEP_LIST=$( (cat requirements.txt 2>/dev/null; \
               grep -E '^\s*"' pyproject.toml 2>/dev/null) \
              | sed -E 's/[#].*$//' \
              | grep -oE '^[a-zA-Z][a-zA-Z0-9_.-]+' \
              | sort -u )
  for pkg in $DEP_LIST; do
    n=$(prune_find -name '*.py' -type f -exec grep -lE "(^|\s)(from|import) ${pkg//-/_}([. \t]|$)" {} + 2>/dev/null | wc -l | xargs)
    printf '  %-25s 引用文件数: %s\n' "$pkg" "$n"
  done | sort -k4 -n
fi

hr "6.2 JS 依赖直接引用计数"
if [ -f package.json ]; then
  DEP_LIST=$(have jq && jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys[]' package.json 2>/dev/null)
  [ -z "$DEP_LIST" ] && DEP_LIST=$(grep -oE '"[^"]+":\s*"[^"]+"' package.json | grep -oE '"[^"]+"' | head -1 | tr -d '"')
  for pkg in $DEP_LIST; do
    n=$(prune_find -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.vue' -o -name '*.js' \) \
        -exec grep -lE "from ['\"]${pkg}['\"]|require\(['\"]${pkg}" {} + 2>/dev/null | wc -l | xargs)
    printf '  %-30s 引用文件数: %s\n' "$pkg" "$n"
  done | sort -k4 -n | head -30
fi

# ───────────────────────────── 7. Git 健康度 ───────────────────────
hr "7. Git 概况"
if have git && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "提交数: $(git rev-list --count HEAD 2>/dev/null)"
  echo "贡献者:"
  git shortlog -sn --all 2>/dev/null | head -10
  echo "---"
  echo "最近 90 天热点文件 (commit 数 top 10):"
  git log --since='90 days ago' --name-only --pretty=format: 2>/dev/null \
    | grep -v '^$' | sort | uniq -c | sort -rn | head -10
  echo "---"
  echo "工作树状态:"
  git status --short 2>/dev/null | head -10
else
  echo "(non-git or git missing)"
fi

# ───────────────────────────── 8. 函数级 outline (可选) ────────────
hr "8. 顶 5 大文件函数 outline"
prune_find -type f \( -name '*.py' -o -name '*.ts' -o -name '*.vue' \) \
  | xargs wc -l 2>/dev/null | sort -rn | head -6 | tail -5 \
  | awk '{print $2}' | while read -r f; do
  echo "--- $f ---"
  grep -nE '^\s*(async\s+)?(def|function|export\s+(default\s+)?(function|class|const)|class)\s' "$f" 2>/dev/null | head -20
done

hr "DONE"
