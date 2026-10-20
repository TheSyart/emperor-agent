import * as path from 'node:path'
import type { WebPreferences } from 'electron'
import {
  RECOVERY_ACTION_CHANNEL,
  type RecoveryAction,
} from '../shared/recovery-contract'
import type {
  DiagnosticsBundleExportResult,
  DiagnosticsBundleView,
} from '../shared/ipc-contract'
import { bundleIdOf } from './diagnostics-bundle-ipc'

export { RECOVERY_ACTION_CHANNEL }

export interface RecoveryPayload {
  schemaVersion: 1
  errorCode: string
  title: string
  message: string
  emperorHome: string
  legacyHome: string | null
  canRetry: boolean
  /** The holder is a packaged Emperor that can be brought forward. */
  canSwitch: boolean
  /** main.log, where the full cause is (REL-01). */
  logFile?: string
}

interface OwnerHint {
  pid: number
  version: string
  packaged: boolean
  appPath: string | null
}

function ownerOf(error: unknown): OwnerHint | null {
  const owner =
    error && typeof error === 'object' && 'owner' in error
      ? (error as { owner?: unknown }).owner
      : undefined
  if (!owner || typeof owner !== 'object') return null
  const record = owner as Record<string, unknown>
  const pid = Number(record.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  return {
    pid,
    version: String(record.version ?? '').slice(0, 40),
    packaged: record.packaged === true,
    appPath:
      typeof record.appPath === 'string' && record.appPath.endsWith('.app')
        ? record.appPath
        : null,
  }
}

export function recoveryPayload(
  error: unknown,
  roots: { emperorHome: string; legacyHome: string | null; logFile?: string },
): RecoveryPayload {
  const code = stableRecoveryCode(error)
  const copy = recoveryCopy(code)
  const owner = code === 'state_root_in_use' ? ownerOf(error) : null
  return {
    schemaVersion: 1,
    errorCode: code,
    title: copy.title,
    message: owner
      ? `另一个 Emperor（版本 ${owner.version || '未知'}，pid ${owner.pid}）正在使用这个数据目录。${owner.packaged && owner.appPath ? '可以切换到它，' : '请'}退出另一个 App 后重试，或退出当前窗口。`
      : copy.message,
    emperorHome: path.resolve(roots.emperorHome),
    legacyHome: roots.legacyHome ? path.resolve(roots.legacyHome) : null,
    canRetry: true,
    canSwitch: Boolean(owner?.packaged && owner.appPath),
    ...(roots.logFile ? { logFile: roots.logFile } : {}),
  }
}

export function recoveryWindowWebPreferences(mainDir: string): WebPreferences {
  return {
    preload: path.join(mainDir, '..', 'preload', 'recovery.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  }
}

export function createRecoveryActionHandler(opts: {
  senderId: number
  emperorHome: string
  legacyHome: string | null
  retry: () => void | Promise<void>
  openPath: (target: string) => string | Promise<string>
  exit: () => void
  /** Bring the Emperor holding the directory forward; '' on success. */
  switchToOwner?: () => string | Promise<string>
  /** Open main.log (REL-01); '' on success. */
  openLogs?: () => string | Promise<string>
  /** 导出诊断包 without Core (REL-01). */
  diagnostics?: {
    prepare(): Promise<DiagnosticsBundleView>
    export(id: string): Promise<DiagnosticsBundleExportResult>
    discard(id: string): void
  }
}): (
  senderId: number,
  action: unknown,
  payload?: unknown,
) => Promise<RecoveryActionResult> {
  let retrying = false
  return async (senderId, rawAction, payload) => {
    if (senderId !== opts.senderId)
      throw new Error('unauthorized recovery renderer')
    const action = recoveryAction(rawAction)
    if (action === 'open_logs') {
      if (!opts.openLogs) return { ok: false, error: '日志不可用' }
      const error = await opts.openLogs()
      return error ? { ok: false, error: bounded(error) } : { ok: true }
    }
    if (
      action === 'prepare_diagnostics' ||
      action === 'export_diagnostics' ||
      action === 'discard_diagnostics'
    )
      return await diagnosticsAction(opts.diagnostics, action, payload)
    if (action === 'retry') {
      if (retrying)
        return { ok: false, error: 'initialization retry in progress' }
      retrying = true
      await opts.retry()
      return { ok: true }
    }
    if (action === 'exit') {
      opts.exit()
      return { ok: true }
    }
    if (action === 'switch_to_owner') {
      if (!opts.switchToOwner)
        return {
          ok: false,
          error: 'the other Emperor cannot be brought forward',
        }
      const error = await opts.switchToOwner()
      if (error) return { ok: false, error: bounded(error) }
      opts.exit()
      return { ok: true }
    }
    const target =
      action === 'open_emperor_home' ? opts.emperorHome : opts.legacyHome
    if (!target) return { ok: false, error: 'directory is unavailable' }
    const error = await opts.openPath(target)
    return error ? { ok: false, error: bounded(error) } : { ok: true }
  }
}

export type RecoveryActionResult =
  | { ok: boolean; error?: string }
  | { ok: true; bundle: DiagnosticsBundleView }
  | DiagnosticsBundleExportResult

async function diagnosticsAction(
  diagnostics:
    | {
        prepare(): Promise<DiagnosticsBundleView>
        export(id: string): Promise<DiagnosticsBundleExportResult>
        discard(id: string): void
      }
    | undefined,
  action: 'prepare_diagnostics' | 'export_diagnostics' | 'discard_diagnostics',
  payload: unknown,
): Promise<RecoveryActionResult> {
  if (!diagnostics) return { ok: false, error: '诊断包不可用' }
  if (action === 'prepare_diagnostics') {
    try {
      return { ok: true, bundle: await diagnostics.prepare() }
    } catch (error) {
      return {
        ok: false,
        error: bounded(
          `没能整理诊断包：${error instanceof Error ? error.message : String(error)}`,
        ),
      }
    }
  }
  const id = bundleIdOf(payload)
  if (!id) return { ok: false, error: '无效的诊断包' }
  if (action === 'discard_diagnostics') {
    diagnostics.discard(id)
    return { ok: true }
  }
  return await diagnostics.export(id)
}

export function createRecoveryHtml(payload: RecoveryPayload): string {
  const data = JSON.stringify({
    code: payload.errorCode,
    title: payload.title,
    message: payload.message,
    emperorHome: payload.emperorHome,
    legacyHome: payload.legacyHome,
    canRetry: payload.canRetry,
    canSwitch: payload.canSwitch,
    logFile: payload.logFile ?? null,
  }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
  <title>Emperor Agent · 恢复</title>
  <style>
    :root {
      color-scheme: dark;
      font: 100%/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #0c0c0e;
      --surface: rgba(31, 31, 35, .82);
      --surface-solid: #202024;
      --line: rgba(255,255,255,.1);
      --text: #f5f5f7;
      --muted: #a1a1aa;
      --accent: #5e8cff;
      --accent-pressed: #4d78df;
      --danger: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 32px;
      background: var(--bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }
    main {
      width: min(100%, 640px);
      padding: 30px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--surface);
      backdrop-filter: blur(28px) saturate(140%);
      box-shadow: 0 24px 72px rgba(0,0,0,.42);
      animation: arrive 180ms cubic-bezier(.2,.8,.2,1) both;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: clamp(26px, 5vw, 36px);
      line-height: 1.12;
      letter-spacing: -.025em;
      text-wrap: balance;
    }
    .message {
      margin: 14px 0 22px;
      color: #d4d4d8;
      font-size: 15px;
      text-wrap: pretty;
    }
    .code {
      display: inline-flex;
      margin-bottom: 22px;
      padding: 6px 9px;
      border-radius: 6px;
      background: rgba(255,107,107,.1);
      color: #ff9a9a;
      font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .01em;
      user-select: all;
    }
    dl {
      display: grid;
      gap: 12px;
      margin: 0;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(0,0,0,.14);
    }
    .row { min-width: 0; }
    dt {
      margin-bottom: 3px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .02em;
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
      color: #e4e4e7;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      user-select: all;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 22px;
    }
    button {
      min-height: 40px;
      padding: 0 15px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,.055);
      color: var(--text);
      font: inherit;
      font-size: 14px;
      font-weight: 620;
      cursor: default;
      transition: transform 100ms ease-out, background 160ms ease, border-color 160ms ease;
    }
    button:hover { background: rgba(255,255,255,.09); }
    button:active { transform: scale(.975); }
    button:focus-visible { outline: 2px solid #91adff; outline-offset: 2px; }
    .primary { border-color: transparent; background: var(--accent); color: white; }
    .primary:hover { background: #6e98ff; }
    .primary:active { background: var(--accent-pressed); }
    .exit { margin-left: auto; color: var(--muted); }
    .status { min-height: 20px; margin: 12px 0 0; color: var(--danger); font-size: 12px; }
    .status.done { color: var(--muted); }
    .bundle {
      margin-top: 18px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(0,0,0,.14);
    }
    .bundle h2 { margin: 0 0 4px; font-size: 14px; font-weight: 620; }
    .bundle .lead { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
    .bundle ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; max-height: 180px; overflow-y: auto; }
    .bundle li { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 12px; }
    .bundle .path { color: #e4e4e7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .bundle .what { color: var(--muted); }
    .bundle .excluded { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
    .bundle .actions { margin-top: 14px; }
    @keyframes arrive { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: scale(1); } }
    @media (prefers-reduced-motion: reduce) {
      main { animation: none; }
      button { transition: none; }
      button:active { transform: none; }
    }
    @media (prefers-reduced-transparency: reduce) {
      main { background: var(--surface-solid); backdrop-filter: none; }
    }
    @media (prefers-contrast: more) {
      main, dl, button { border-color: rgba(255,255,255,.34); }
      .message, dd { color: white; }
    }
  </style>
</head>
<body>
  <main aria-labelledby="title">
    <p class="eyebrow">Emperor Agent · Recovery</p>
    <h1 id="title"></h1>
    <p class="message" id="message"></p>
    <code class="code" id="code"></code>
    <dl>
      <div class="row"><dt>Emperor Home</dt><dd id="home"></dd></div>
      <div class="row" id="legacy-row"><dt>旧数据目录</dt><dd id="legacy"></dd></div>
      <div class="row" id="log-row"><dt>日志（含完整原因）</dt><dd id="log"></dd></div>
    </dl>
    <div class="actions">
      <button class="primary" id="switch" type="button">切换到它</button>
      <button class="primary" id="retry" type="button">重试初始化</button>
      <button id="open-home" type="button">打开 Emperor Home</button>
      <button id="open-legacy" type="button">打开旧目录</button>
      <button id="open-logs" type="button">打开日志</button>
      <button id="export-bundle" type="button">导出诊断包</button>
      <button class="exit" id="exit" type="button">退出</button>
    </div>
    <section class="bundle" id="bundle" aria-labelledby="bundle-title" hidden>
      <h2 id="bundle-title">诊断包包含这些文件</h2>
      <p class="lead">确认后选择保存位置；文件只留在你的电脑上。</p>
      <ul id="bundle-entries"></ul>
      <p class="excluded" id="bundle-excluded"></p>
      <div class="actions">
        <button class="primary" id="bundle-export" type="button">导出…</button>
        <button id="bundle-cancel" type="button">取消</button>
      </div>
    </section>
    <p class="status" id="status" role="status" aria-live="polite"></p>
  </main>
  <script>
    const payload = ${data};
    const byId = (id) => document.getElementById(id);
    byId('title').textContent = payload.title;
    byId('message').textContent = payload.message;
    byId('code').textContent = payload.code;
    byId('home').textContent = payload.emperorHome;
    byId('retry').hidden = !payload.canRetry;
    byId('switch').hidden = !payload.canSwitch;
    if (payload.canSwitch) byId('retry').classList.remove('primary');
    if (payload.legacyHome) byId('legacy').textContent = payload.legacyHome;
    else { byId('legacy-row').hidden = true; byId('open-legacy').hidden = true; }
    if (payload.logFile) byId('log').textContent = payload.logFile;
    else { byId('log-row').hidden = true; byId('open-logs').hidden = true; }
    function say(text, done) {
      byId('status').textContent = text;
      byId('status').classList.toggle('done', Boolean(done));
    }
    async function act(action) {
      say('');
      const result = await window.emperorRecovery.action(action);
      if (!result.ok) say(result.error || '操作失败');
    }
    const sizeOf = (bytes) => bytes < 1024 ? bytes + ' B'
      : bytes < 1048576 ? Math.round(bytes / 1024) + ' KB'
      : (bytes / 1048576).toFixed(1) + ' MB';
    let bundleId = null;
    byId('export-bundle').addEventListener('click', async () => {
      say('');
      const result = await window.emperorRecovery.action('prepare_diagnostics');
      if (!result.ok) { say(result.error || '没能整理诊断包'); return; }
      bundleId = result.bundle.id;
      const list = byId('bundle-entries');
      list.replaceChildren();
      for (const entry of result.bundle.entries) {
        const row = document.createElement('li');
        row.dataset.entry = entry.path;
        const name = document.createElement('span');
        name.className = 'path';
        name.textContent = entry.path;
        const what = document.createElement('span');
        what.className = 'what';
        what.textContent = entry.title + ' · ' + sizeOf(entry.bytes);
        row.append(name, what);
        list.append(row);
      }
      byId('bundle-excluded').textContent = '不包含：' + result.bundle.excluded.join('、');
      byId('bundle').hidden = false;
      byId('bundle-export').focus();
    });
    byId('bundle-export').addEventListener('click', async () => {
      if (!bundleId) return;
      const result = await window.emperorRecovery.action('export_diagnostics', { id: bundleId });
      if (result.ok) {
        bundleId = null;
        byId('bundle').hidden = true;
        say('已导出 ' + result.name + '（' + result.location + '）', true);
      } else if (!result.canceled) say(result.error || '导出失败');
    });
    byId('bundle-cancel').addEventListener('click', () => {
      if (bundleId) void window.emperorRecovery.action('discard_diagnostics', { id: bundleId });
      bundleId = null;
      byId('bundle').hidden = true;
    });
    byId('open-logs').addEventListener('click', () => act('open_logs'));
    byId('switch').addEventListener('click', () => act('switch_to_owner'));
    byId('retry').addEventListener('click', () => act('retry'));
    byId('open-home').addEventListener('click', () => act('open_emperor_home'));
    byId('open-legacy').addEventListener('click', () => act('open_legacy_home'));
    byId('exit').addEventListener('click', () => act('exit'));
  </script>
</body>
</html>`
}

function stableRecoveryCode(error: unknown): string {
  const raw =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''
  if (/^(?:installation_|state_root_)[a-z_]+$/.test(raw))
    return raw.slice(0, 96)
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/runtime (?:resource|manifest)|runtime-manifest/i.test(message))
    return 'runtime_manifest_invalid'
  return 'core_startup_failed'
}

function recoveryCopy(code: string): { title: string; message: string } {
  if (code === 'state_root_in_use')
    return {
      title: '数据目录正在使用',
      message:
        '另一个 Emperor Agent 正在使用这个数据目录。请退出另一个 App 后重试，或退出当前窗口。',
    }
  if (code === 'state_root_lock_failed')
    return {
      title: '无法锁定数据目录',
      message:
        '未能确认数据目录的独占访问，应用未启动。请检查目录权限和存储状态后重试。',
    }
  if (code === 'installation_layout_newer')
    return {
      title: 'Emperor Home 版本过新',
      message: '当前版本无法安全写入这个 Emperor Home。请升级应用或退出。',
    }
  if (code === 'installation_lock_busy')
    return {
      title: 'Emperor Home 正在被使用',
      message: '另一个初始化进程持有数据目录锁。关闭其他实例后重试。',
    }
  if (code === 'runtime_manifest_invalid')
    return {
      title: '应用运行资源校验失败',
      message: 'Release 内的只读运行资源无效或不完整。请重新下载安装包。',
    }
  if (code === 'installation_invalid_state')
    return {
      title: 'Emperor Home 状态无效',
      message: '安装状态文件无法安全读取。打开目录检查，或退出后恢复备份。',
    }
  if (code === 'installation_io')
    return {
      title: '无法初始化 Emperor Home',
      message: '数据目录不可写或迁移未完成。修复目录权限后重试。',
    }
  return {
    title: 'Emperor Agent 无法启动',
    message: 'Core 初始化未完成。可以重试，或打开 Emperor Home 查看诊断数据。',
  }
}

function recoveryAction(value: unknown): RecoveryAction {
  const action = String(value ?? '').trim()
  if (
    action === 'retry' ||
    action === 'open_emperor_home' ||
    action === 'open_legacy_home' ||
    action === 'switch_to_owner' ||
    action === 'exit' ||
    action === 'open_logs' ||
    action === 'prepare_diagnostics' ||
    action === 'export_diagnostics' ||
    action === 'discard_diagnostics'
  )
    return action
  throw new Error('invalid recovery action')
}

function bounded(value: string): string {
  return String(value ?? '').slice(0, 500)
}
