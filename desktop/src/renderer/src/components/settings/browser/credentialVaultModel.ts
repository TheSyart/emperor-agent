/**
 * Settings › 浏览器 › 密码管理器 view model: how stored secrets are protected
 * (Emperor's local key, plus the optional master password), the edit form's
 * round trip, and vault error text. No secret passes through here except the
 * form values the user typed.
 */
import type { CredentialBinding } from '@emperor/core/runtime-contract'
import type { VaultEntry, VaultStatus } from '../../../api/backend'

export interface VaultBadge {
  readonly tone: 'ok' | 'warn' | 'error' | 'neutral'
  readonly badge: string
  readonly description: string
}

/** The key that seals every entry; the macOS Keychain is not used. */
export const LOCAL_KEY_LABEL =
  'Emperor 本地密钥（保存在这台 Mac 的 Emperor 目录）'

/** The notice 密码管理器 shows while the local key cannot be used (清空). */
export interface VaultProblem {
  readonly title: string
  readonly description: string
}

export function vaultProblem(status: VaultStatus | null): VaultProblem | null {
  if (status?.problem === 'key-missing')
    return {
      title: '已保存的密码无法解密',
      description:
        '本地密钥文件不见了，没有它就打不开这些密码。清空后可以重新添加或导入；清空无法撤销。',
    }
  if (status?.problem === 'key-invalid')
    return {
      title: '已保存的密码无法解密',
      description:
        '本地密钥文件的权限或属主不对，Emperor 不会读取它。清空后会换一把新的本地密钥，再重新添加或导入密码；清空无法撤销。',
    }
  return null
}

export function vaultAvailability(status: VaultStatus | null): VaultBadge {
  if (!status)
    return {
      tone: 'neutral',
      badge: '读取中',
      description: '正在读取密码管理器状态…',
    }
  if (status.problem)
    return {
      tone: 'error',
      badge: '无法解密',
      description: '本地密钥不可用，先清空才能继续使用',
    }
  if (!status.available)
    return {
      tone: 'error',
      badge: '不可用',
      description: '本地加密不可用，密码管理器已停用',
    }
  if (status.locked)
    return {
      tone: 'warn',
      badge: '已锁定',
      description: '输入主密码解锁后，才能代填或修改凭据',
    }
  return { tone: 'ok', badge: '可用', description: '本地加密可用' }
}

/**
 * Spec 00 §6.4 / 03 §7.7: show honestly how stored secrets are protected.
 * The local key is basic protection — programs running as you can read it
 * as they can read the vault — so without a master password it says so.
 */
export function vaultEncryption(status: VaultStatus | null): VaultBadge | null {
  if (!status?.available) return null
  if (status.hasMasterPassword)
    return {
      tone: 'ok',
      badge: '本地密钥 + 主密码',
      description: `${LOCAL_KEY_LABEL}加密，外面再用主密码（scrypt 派生密钥）加一层。`,
    }
  return {
    tone: 'warn',
    badge: '基础',
    description: `${LOCAL_KEY_LABEL}：以你身份运行的程序也能读到这把密钥，建议设置主密码。`,
  }
}

/** Time and target of the last fill (spec 00 §10.4); never a value. */
export function lastUsedText(entry: VaultEntry): string {
  if (entry.lastUsedAt === undefined) return '尚未代填'
  const time = new Date(entry.lastUsedAt).toLocaleString('zh-CN', {
    hour12: false,
  })
  return entry.lastUsedTarget
    ? `上次代填 ${time} · ${entry.lastUsedTarget}`
    : `上次代填 ${time}`
}

export function entryDescription(entry: VaultEntry): string {
  const targets = entry.bindings
    .map((item) => (item.kind === 'origin' ? item.origin : item.bundleId))
    .join('、')
  return `${targets} · ${lastUsedText(entry)}`
}

const UNSIGNED_APP = '该应用未签名，身份校验较弱'

/**
 * 01 §7.9: an app bound without a Team ID is checked only by bundle ID and
 * path. Names each such binding on its entry; null when every app is signed.
 */
export function unsignedAppWarning(entry: VaultEntry): string | null {
  const unsigned = entry.bindings.flatMap((item) =>
    item.kind === 'app' && !item.teamId ? [item.bundleId] : [],
  )
  return unsigned.length ? `${unsigned.join('、')}：${UNSIGNED_APP}` : null
}

/** The same warning while the form is edited, for lines without a Team ID. */
export function unsignedFormWarning(appBindings: string): string | null {
  const unsigned = appBindings.split(/\r?\n/).flatMap((line) => {
    const [bundleId = '', teamId = ''] = line
      .split('|')
      .map((part) => part.trim())
    return bundleId && !teamId ? [bundleId] : []
  })
  return unsigned.length
    ? `${unsigned.join('、')}：${UNSIGNED_APP}。代填时只核对 Bundle ID 和应用路径。`
    : null
}

/** Spec 00 §6.4: shown as soon as the user types a TOTP secret. */
export const TOTP_WARNING =
  '把 TOTP 密钥和密码放在一起，两步验证就退化成了一步：能解开凭据库的人，会同时拿到密码和验证码。请自行权衡。'

export interface VaultForm {
  label: string
  origin: string
  appBindings: string
  /** What the form showed when editing began; unchanged means keep. */
  loadedUsername: string
  username: string
  /** Stored, but hidden from handles because the Agent may not see it. */
  usernameHidden: boolean
  revealUsername: boolean
  /** The entry being edited already has a TOTP secret. */
  totpSaved: boolean
  /** Delete that saved TOTP secret on save. */
  removeTotp: boolean
}

export function emptyForm(): VaultForm {
  return {
    label: '',
    origin: '',
    appBindings: '',
    loadedUsername: '',
    username: '',
    usernameHidden: false,
    revealUsername: true,
    totpSaved: false,
    removeTotp: false,
  }
}

export function formFromEntry(entry: VaultEntry): VaultForm {
  const username = entry.username ?? ''
  return {
    label: entry.label,
    origin: entry.bindings
      .filter((item) => item.kind === 'origin')
      .map((item) => item.origin)
      .join('\n'),
    appBindings: entry.bindings
      .filter((item) => item.kind === 'app')
      .map(
        (item) =>
          `${item.bundleId} | ${item.teamId ?? ''} | ${item.path ?? ''}`,
      )
      .join('\n'),
    loadedUsername: username,
    username,
    usernameHidden:
      entry.fields.includes('username') && entry.username === undefined,
    // The entry's own setting; a missing username says nothing about it.
    revealUsername: entry.revealUsername,
    totpSaved: entry.fields.includes('totp'),
    removeTotp: false,
  }
}

/**
 * New entries always send the username. An edit sends it only when changed,
 * so a hidden username survives a blank field and a shown one can be cleared.
 */
export function usernamePatch(
  form: VaultForm,
  editing: boolean,
): { username?: string } {
  return !editing || form.username !== form.loadedUsername
    ? { username: form.username }
    : {}
}

/**
 * An empty secret deletes the saved one; a typed seed replaces it; a blank
 * field keeps it.
 */
export function totpPatch(
  form: VaultForm,
  seed: string,
): { totpSecret?: string } {
  if (form.totpSaved && form.removeTotp) return { totpSecret: '' }
  return seed ? { totpSecret: seed } : {}
}

export function parseBindings(
  origin: string,
  appBindings: string,
): CredentialBinding[] {
  const bindings: CredentialBinding[] = [
    ...origin
      .split(/\r?\n/)
      .map((item) => ({ kind: 'origin' as const, origin: item.trim() }))
      .filter((item) => item.origin),
    ...appBindings
      .split(/\r?\n/)
      .filter((item) => item.trim())
      .map((item) => {
        const parts = item.split('|').map((part) => part.trim())
        if (parts.length !== 3 || !parts[0] || (!parts[1] && !parts[2]))
          throw new Error(
            'App 绑定须按 Bundle ID | Team ID | 路径填写，Team ID 与路径至少填一项',
          )
        return {
          kind: 'app' as const,
          bundleId: parts[0],
          ...(parts[1] ? { teamId: parts[1] } : {}),
          ...(parts[2] ? { path: parts[2] } : {}),
        }
      }),
  ]
  if (bindings.length === 0)
    throw new Error('至少填写一个网站 origin 或 App 绑定')
  return bindings
}

/** Main tags vault IPC failures `[credential-vault:<reason>]`. */
const REASON_TEXT: Readonly<Record<string, string>> = {
  'vault-unavailable': '本地加密不可用，密码管理器已停用。',
  'vault-key-missing':
    '本地密钥文件不见了，已保存的密码无法解密。可以在密码管理器里清空后重新开始。',
  'vault-key-invalid':
    '本地密钥文件的权限或属主不对，Emperor 不会读取它。可以在密码管理器里清空后重新开始。',
  'vault-locked': '凭据库已锁定，请先用主密码解锁。',
  'vault-kdf-unavailable':
    '这个凭据库的主密码用 Argon2id 派生，当前运行环境不支持，无法解锁。',
  'vault-file-invalid': '凭据库文件无法识别，可能已损坏。',
  'credential-not-found': '找不到这个凭据，可能已被删除。',
  'credential-field-missing': '这个凭据没有保存该字段。',
  'credential-binding-mismatch': '目标与凭据绑定不一致。',
  'credential-unreadable':
    '已保存的凭据无法解密。本地密钥可能已更换，请重新填写并保存。',
  'credential-empty': '至少填写用户名、密码或 TOTP 密钥中的一项。',
  'invalid-label': '名称不能为空，最多 120 个字符。',
  'invalid-binding':
    '绑定无效：网站 origin 只能包含协议、主机和端口（如 https://example.com）；App 绑定须填写 Bundle ID，以及 Team ID 或绝对路径。',
  'invalid-totp': 'TOTP 密钥无效，应为至少 16 位的 Base32 字符。',
  'master-password-too-short': '主密码至少需要 12 个字符。',
  'invalid-request': '请求格式无效。',
  'reveal-unverified': '系统身份验证已取消或不可用。',
  internal: '凭据库操作失败。',
}

export function vaultErrorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  const reason = /\[credential-vault:([a-z-]+)\]/.exec(message)?.[1]
  return (reason && REASON_TEXT[reason]) || message
}
