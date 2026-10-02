import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../errors'
import {
  DEFAULT_EXTERNAL_BROWSER_SETTINGS,
  EXTERNAL_SITE_RULES_FILE,
  ExternalSiteRuleStore,
  SITE_TOOLS_AVAILABILITY,
  applyExternalBrowserSettingsPatch,
  externalBrowserSettingsView,
  externalSiteDecision,
  externalSiteRule,
  normalizeSitePattern,
  stricterDecision,
  widensExternalBrowserSettings,
  type ExternalBrowserSettings,
} from './external-site-rules'

function settings(
  sites: ExternalBrowserSettings['sites'],
  defaults: ExternalBrowserSettings['defaults'] = {
    browse: 'allow',
    download: 'ask',
  },
): ExternalBrowserSettings {
  return { ...DEFAULT_EXTERNAL_BROWSER_SETTINGS, defaults, sites }
}

describe('Chrome/Edge site patterns', () => {
  it('keeps a host, a host with its subdomains and an exact origin', () => {
    expect(normalizeSitePattern(' GitHub.com ')).toBe('github.com')
    expect(normalizeSitePattern('*.MyBank.example')).toBe('*.mybank.example')
    expect(normalizeSitePattern('https://example.com:8443/path?q=1')).toBe(
      'https://example.com:8443',
    )
    expect(normalizeSitePattern('https://example.com:443')).toBe(
      'https://example.com',
    )
    expect(normalizeSitePattern('example.com.')).toBe('example.com')
    expect(normalizeSitePattern('例子.测试')).toBe('xn--fsqu00a.xn--0zwm56d')
    expect(normalizeSitePattern('localhost')).toBe('localhost')
    expect(normalizeSitePattern('http://localhost:3000')).toBe(
      'http://localhost:3000',
    )
  })

  it('refuses anything else', () => {
    for (const bad of [
      '',
      '   ',
      '*',
      '*.',
      'a.*.example.com',
      '*example.com',
      'example.com/path',
      'localhost:3000',
      'ftp://example.com',
      'chrome://settings',
      'https://user:secret@example.com',
      'exa mple.com',
      '*.127.0.0.1',
      'x'.repeat(400),
    ])
      expect(normalizeSitePattern(bad), bad).toBeNull()
  })
})

describe('Chrome/Edge site rules', () => {
  const rules = settings([
    { pattern: '*.mybank.example', browse: 'ask', download: 'block' },
    { pattern: 'github.com', browse: 'allow', download: 'allow' },
    { pattern: 'login.mybank.example', browse: 'block', download: 'block' },
    {
      pattern: 'https://mybank.example:8443',
      browse: 'allow',
      download: 'ask',
    },
  ])

  it('uses the default row when nothing matches', () => {
    expect(
      externalSiteRule(rules, 'https://news.example/today'),
    ).toBeUndefined()
    expect(externalSiteDecision(rules, 'https://news.example/', 'browse')).toBe(
      'allow',
    )
    expect(
      externalSiteDecision(rules, 'https://news.example/', 'download'),
    ).toBe('ask')
  })

  it('matches a host exactly, whatever the scheme and port', () => {
    expect(
      externalSiteDecision(rules, 'http://github.com:8080/x', 'download'),
    ).toBe('allow')
    // A subdomain is another host.
    expect(
      externalSiteDecision(rules, 'https://gist.github.com/', 'download'),
    ).toBe('ask')
  })

  it('matches *.host on the host itself and every subdomain', () => {
    expect(
      externalSiteDecision(rules, 'https://mybank.example/', 'browse'),
    ).toBe('ask')
    expect(
      externalSiteDecision(rules, 'https://a.b.mybank.example/', 'download'),
    ).toBe('block')
    expect(
      externalSiteDecision(rules, 'https://notmybank.example/', 'browse'),
    ).toBe('allow')
  })

  it('lets the most specific rule win: origin, then host, then the longest wildcard', () => {
    expect(
      externalSiteDecision(rules, 'https://login.mybank.example/', 'browse'),
    ).toBe('block')
    expect(
      externalSiteDecision(rules, 'https://mybank.example:8443/', 'browse'),
    ).toBe('allow')
    const nested = settings([
      { pattern: '*.example.com', browse: 'block', download: 'block' },
      { pattern: '*.docs.example.com', browse: 'allow', download: 'ask' },
    ])
    expect(
      externalSiteDecision(nested, 'https://api.docs.example.com/', 'browse'),
    ).toBe('allow')
    expect(externalSiteDecision(nested, 'https://example.com/', 'browse')).toBe(
      'block',
    )
  })

  it('never lets a non-web address through', () => {
    for (const url of ['chrome://settings', 'file:///etc/passwd', 'nonsense'])
      expect(externalSiteDecision(rules, url, 'browse')).toBe('block')
  })

  it('orders decisions from allow to block', () => {
    expect(stricterDecision('allow', 'ask')).toBe('ask')
    expect(stricterDecision('block', 'ask')).toBe('block')
    expect(stricterDecision('allow', 'allow')).toBe('allow')
  })
})

describe('changing the rules', () => {
  const base = DEFAULT_EXTERNAL_BROWSER_SETTINGS

  it('normalizes patterns, replaces a repeated one and keeps the rest', () => {
    const next = applyExternalBrowserSettingsPatch(base, {
      defaults: { download: 'block' },
      sites: [
        { pattern: 'GitHub.com', browse: 'allow', download: 'ask' },
        { pattern: 'github.com', browse: 'allow', download: 'allow' },
        { pattern: '*.Bank.example', browse: 'ask', download: 'block' },
      ],
      history: 'never',
    })
    expect(next).toEqual({
      defaults: { browse: 'allow', download: 'block' },
      sites: [
        { pattern: 'github.com', browse: 'allow', download: 'allow' },
        { pattern: '*.bank.example', browse: 'ask', download: 'block' },
      ],
      history: 'never',
      siteTools: false,
    })
  })

  it('says in plain words what is wrong with a pattern', () => {
    expect(() =>
      applyExternalBrowserSettingsPatch(base, {
        sites: [
          { pattern: 'example.com/path', browse: 'allow', download: 'ask' },
        ],
      }),
    ).toThrow(ValidationError)
    expect(() =>
      applyExternalBrowserSettingsPatch(base, {
        sites: [{ pattern: '*', browse: 'block', download: 'block' }],
      }),
    ).toThrow(/不是有效的网站或模式/)
    expect(() =>
      applyExternalBrowserSettingsPatch(base, {
        sites: Array.from({ length: 201 }, (_, index) => ({
          pattern: `site${index}.example`,
          browse: 'allow' as const,
          download: 'ask' as const,
        })),
      }),
    ).toThrow(/最多 200/)
  })

  it('knows when a change lets the Agent do more', () => {
    const blocked = applyExternalBrowserSettingsPatch(base, {
      sites: [
        { pattern: '*.bank.example', browse: 'block', download: 'block' },
      ],
    })
    // Narrowing: a block rule, a stricter default, history off.
    expect(widensExternalBrowserSettings(base, blocked)).toBe(false)
    expect(
      widensExternalBrowserSettings(
        base,
        applyExternalBrowserSettingsPatch(base, {
          defaults: { browse: 'ask' },
          history: 'never',
        }),
      ),
    ).toBe(false)
    // Widening: removing that block, allowing one of its hosts, a looser
    // default, history without asking, site tools on.
    expect(
      widensExternalBrowserSettings(
        blocked,
        applyExternalBrowserSettingsPatch(blocked, { sites: [] }),
      ),
    ).toBe(true)
    expect(
      widensExternalBrowserSettings(
        blocked,
        applyExternalBrowserSettingsPatch(blocked, {
          sites: [
            ...blocked.sites,
            { pattern: 'pay.bank.example', browse: 'allow', download: 'block' },
          ],
        }),
      ),
    ).toBe(true)
    expect(
      widensExternalBrowserSettings(
        base,
        applyExternalBrowserSettingsPatch(base, {
          defaults: { download: 'allow' },
        }),
      ),
    ).toBe(true)
    expect(
      widensExternalBrowserSettings(
        base,
        applyExternalBrowserSettingsPatch(base, { history: 'allow' }),
      ),
    ).toBe(true)
    expect(
      widensExternalBrowserSettings(base, { ...base, siteTools: true }),
    ).toBe(true)
  })
})

describe('ExternalSiteRuleStore', () => {
  function root(): string {
    return mkdtempSync(join(tmpdir(), 'cu-site-rules-'))
  }

  it('starts from the defaults: browse allowed, downloads need approval, history asks', () => {
    const store = new ExternalSiteRuleStore(root())
    expect(store.get()).toEqual({
      defaults: { browse: 'allow', download: 'ask' },
      sites: [],
      history: 'ask',
      siteTools: false,
    })
  })

  it('writes one private file, atomically, and reads it back', () => {
    const dir = root()
    const store = new ExternalSiteRuleStore(dir)
    store.update({
      sites: [{ pattern: 'github.com', browse: 'allow', download: 'allow' }],
    })
    const path = join(dir, EXTERNAL_SITE_RULES_FILE)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      sites: [{ pattern: 'github.com', browse: 'allow', download: 'allow' }],
    })
    // No temp file left behind.
    expect(readdirSync(dir)).toEqual([EXTERNAL_SITE_RULES_FILE])
    expect(new ExternalSiteRuleStore(dir).get().sites).toEqual([
      { pattern: 'github.com', browse: 'allow', download: 'allow' },
    ])
  })

  it('reads a newer or partly broken file field by field instead of dropping it', () => {
    const dir = root()
    writeFileSync(
      join(dir, EXTERNAL_SITE_RULES_FILE),
      JSON.stringify({
        schemaVersion: 2,
        defaults: { browse: 'ask', download: 'sometimes' },
        sites: [
          { pattern: 'github.com', browse: 'allow', download: 'allow' },
          { pattern: 'not a pattern', browse: 'allow', download: 'allow' },
          { pattern: 'x.example', browse: 'maybe', download: 'allow' },
        ],
        history: 'allow',
        siteTools: 'yes',
        somethingNew: { kept: false },
      }),
    )
    expect(new ExternalSiteRuleStore(dir).get()).toEqual({
      defaults: { browse: 'ask', download: 'ask' },
      sites: [{ pattern: 'github.com', browse: 'allow', download: 'allow' }],
      history: 'allow',
      siteTools: false,
    })
  })

  it('sets a corrupt file aside and starts from the defaults', () => {
    const dir = root()
    writeFileSync(join(dir, EXTERNAL_SITE_RULES_FILE), '{ not json')
    expect(new ExternalSiteRuleStore(dir).get()).toEqual(
      DEFAULT_EXTERNAL_BROWSER_SETTINGS,
    )
    expect(
      readdirSync(dir).some((name) => name !== EXTERNAL_SITE_RULES_FILE),
    ).toBe(true)
  })

  it('decides with what is stored', () => {
    const store = new ExternalSiteRuleStore(root())
    store.update({
      sites: [{ pattern: '*.bank.example', browse: 'ask', download: 'block' }],
    })
    expect(store.decide('https://www.bank.example/', 'browse')).toBe('ask')
    expect(store.decide('https://elsewhere.example/', 'download')).toBe('ask')
  })
})

describe('启用站点工具 (WebMCP, RV-11)', () => {
  it('is not available in the browsers people use today, and says why', () => {
    expect(SITE_TOOLS_AVAILABILITY.available).toBe(false)
    expect(SITE_TOOLS_AVAILABILITY.reason).toMatch(/正式版还没有/)
    expect(SITE_TOOLS_AVAILABILITY.reason).toMatch(/实验开关/)
  })

  it('cannot be switched on while it is not available (no make-believe switch)', () => {
    expect(() =>
      applyExternalBrowserSettingsPatch(DEFAULT_EXTERNAL_BROWSER_SETTINGS, {
        siteTools: true,
      }),
    ).toThrow(/站点工具目前不可用/)
    // Switching it off is always fine.
    expect(
      applyExternalBrowserSettingsPatch(DEFAULT_EXTERNAL_BROWSER_SETTINGS, {
        siteTools: false,
      }).siteTools,
    ).toBe(false)
  })

  it('reads as off, with the reason, even if a file says on', () => {
    expect(
      externalBrowserSettingsView({
        ...DEFAULT_EXTERNAL_BROWSER_SETTINGS,
        siteTools: true,
      }),
    ).toMatchObject({
      siteTools: false,
      siteToolsAvailable: false,
      siteToolsReason: SITE_TOOLS_AVAILABILITY.reason,
    })
  })
})
