import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(__dirname, path), 'utf8')
const card = read('ComposerCard.vue')
const controller = read('../chat/composerController.ts')
const modelControl = read('../chat/composerModelControl.ts')
const palette = read('../chat/composerPalette.ts')
const model = read('ModelPicker.vue')

/** The repository root (desktop/src/renderer/src/components/composer). */
const REPO = resolve(__dirname, '../../../../../..')

/** Text files under `dir`, skipping dependencies and build output. */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'node_modules' ||
      entry === 'out' ||
      entry === 'dist' ||
      entry === 'screenshots' ||
      entry === 'test-results' ||
      entry.startsWith('.')
    )
      continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (/\.(?:ts|vue|css|md|mjs|cjs|js|json)$/.test(entry)) out.push(path)
  }
  return out
}

describe('ComposerCard controller/view ownership', () => {
  it('keeps stateful behaviour in the shared controller and the SFC as a view', () => {
    expect(card).toContain('useComposerController(props, emit)')
    expect(card).not.toContain('useAttachments(')
    expect(controller).toContain('useAttachments(')
    expect(modelControl).toContain("emit('set-permission', mode)")
    expect(controller).toContain("emit('start-goal', content)")
    expect(controller).toContain('Goal Outcome 暂仅支持纯文字')
    expect(controller).toContain('uploading.value.size > 0')
    expect(palette).toContain('buildCapabilityPickerGroups(')
  })

  it('retains the public view contract', () => {
    expect(card).toContain('defineExpose(controller.expose)')
    expect(card).toContain(':disabled="sendDisabled"')
    expect(card).toContain('<PermissionChip')
    expect(card).toContain('<ModelPicker')
    expect(card).toContain("emit('dismiss-lifecycle')")
    expect(card).toContain("emit('activate-plan')")
    // UI-S04: Plan lives in the permission menu, usage in the model menu.
    expect(card).not.toContain('<PlanChip')
    expect(card).not.toContain('<ContextMeter')
  })

  it('switches models by entry id and keeps reasoning choices distinct', () => {
    expect(model).toContain("emit('select-model', entry.entryId)")
    expect(model).toContain('entry.entryId === activeId')
    expect(modelControl).toContain('currentModel?.reasoningEfforts')
    expect(modelControl).toContain("if (normalized === 'xhigh') return 'XHigh'")
    expect(modelControl).toContain("if (normalized === 'max') return 'Max'")
  })

  it('caps the draft at the dsh 14-line height', () => {
    expect(controller).toContain('COMPOSER_TEXT_MAX_HEIGHT = 336')
  })
})

describe('UI-S04: the old text box is gone', () => {
  it('7 · leaves no symbol of the old textarea input path in the repository', () => {
    // Spelled in pieces so this file does not name them itself.
    const retired = [
      ['COMPOSER', 'INPUT', 'FLAG'].join('_'),
      ['emperor', 'composer', 'input'].join('.'),
      ['insert', 'InlineToken'].join(''),
      ['normalize', 'ComposerCapabilityInput'].join(''),
      ['render', 'ComposerInlineTokens'].join(''),
      ['has', 'ComposerCapabilityTokens'].join(''),
      ['composer', 'CapabilityTokens'].join(''),
      ['insert', 'capability', 'token'].join('_'),
      ['highlight', 'Layer'].join(''),
      ['sync', 'HighlightScroll'].join(''),
      ['composer', 'inline', 'token'].join('-'),
      ['rich', 'Input'].join(''),
      ['@skill', '(${'].join(''),
      ['@mcp', '(${'].join(''),
      ['Plan', 'Chip'].join(''),
      ['Context', 'Meter'].join(''),
      ['legacy', 'InputRequested'].join(''),
    ]
    const self = relative(REPO, __filename)
    const offenders: string[] = []
    for (const root of ['desktop/src', 'desktop/tests', 'docs']) {
      for (const path of sources(join(REPO, root))) {
        const rel = relative(REPO, path)
        // The changelog records history, not code.
        if (rel === self || rel === 'docs/release/CHANGELOG.md') continue
        const text = readFileSync(path, 'utf8')
        for (const symbol of retired)
          if (text.includes(symbol)) offenders.push(`${rel}: ${symbol}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('renders only the rich editor (no textarea in the composer)', () => {
    expect(card).not.toMatch(/<textarea/)
    expect(card).toContain('<ComposerEditor')
  })

  it('8 · keeps composerController.ts within 700 lines', () => {
    const lines = controller.split('\n').length
    expect(lines).toBeLessThanOrEqual(700)
  })
})
