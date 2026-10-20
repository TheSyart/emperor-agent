/**
 * The composer's lists (split out of composerController.ts, UI-S04):
 * the `/` palette at the start of a message (commands and Skills, then a
 * command's argument completions), `@query` anywhere (plugins) and ` /query`
 * in the middle of a message (Skills), the + menu's 插入 Skill 或插件 list,
 * which one is open, the selected row, and the hint for a typed `/word`
 * that names nothing. The controller applies the chosen row.
 */
import type { CommandCompletion } from '@emperor/core/api'
import { computed, ref, watch, type Ref } from 'vue'
import type { CapabilityPickerItem } from '../../capabilities/capabilityPicker'
import {
  buildCapabilityPickerGroups,
  skillChipItem,
} from '../../capabilities/capabilityPickerModel'
import {
  pluginCatalog,
  pluginChipItem,
  pluginChoices,
  rankPluginChoices,
} from '../../capabilities/pluginChoices'
import {
  buildSlashPaletteGroups,
  isPathLikeSlashToken,
  rankSlashPaletteItems,
  skillIdOf,
} from '../../commands'
import type { SlashPaletteItem } from '../../commands'
import { actionIcons, toolIcon, type IconComponent } from '../../icons'
import type { PluginSummary, RuntimeGoalView } from '../../types'
import type {
  ComposerCatalog,
  ComposerTrigger,
} from '../composer/editor/composerDocument'

export interface ComposerPaletteProps {
  busy: boolean
  commands: SlashPaletteItem[]
  plugins?: readonly PluginSummary[]
  goal?: RuntimeGoalView | null
  planPaused?: boolean
  completeCommand?: (
    commandId: string,
    rawArgs: string,
    cursor: number,
  ) => Promise<CommandCompletion[]>
  refreshCommands?: () => Promise<void>
}

export type ComposerPaletteMode = 'add' | 'slash' | 'mention'

export function useComposerPalette(
  props: Readonly<ComposerPaletteProps>,
  state: {
    /** The draft's text. */
    value: Ref<string>
    /** A `/` or `@` being typed at the caret. */
    trigger: Ref<ComposerTrigger | null>
    /** The composer root: a press outside it closes the + list. */
    shell: Ref<HTMLElement | null>
  },
) {
  const { value, trigger, shell } = state
  const addMenuOpen = ref(false)
  const argumentCompletions = ref<CommandCompletion[]>([])
  const selectionIndex = ref(0)
  const dismissedSlashInput = ref('')
  /** Esc hides one typed `/query` or `@query` until it changes. */
  const dismissedTrigger = ref('')
  let completionGeneration = 0

  const skillItems = computed(() =>
    props.commands.filter((item) => item.kind === 'skill'),
  )
  const skillLabels = computed(
    () =>
      new Map(skillItems.value.map((item) => [skillIdOf(item), item.title])),
  )
  const plugins = computed(() => pluginChoices(props.plugins ?? []))
  const pluginNames = computed(() => pluginCatalog(plugins.value))
  /** Names that become chips when typed or pasted: skills and usable plugins. */
  const catalog: ComposerCatalog = {
    skill: (id) => skillLabels.value.get(id),
    plugin: (id) => pluginNames.value.label(id),
    pluginLogo: (id) => pluginNames.value.logo(id),
  }

  const suggestions = computed(() => {
    const text = value.value
    if (!text.startsWith('/')) return []
    if (dismissedSlashInput.value === text) return []
    if (/^\/\S+\s/.test(text)) return []
    return rankSlashPaletteItems(
      props.commands,
      text.slice(1).split(/\s+/, 1)[0]!.toLowerCase(),
    )
  })
  /** The command or Skill the draft starts with, by name or alias. */
  const exactCommand = computed(() => {
    const token = value.value.match(/^\/\S+/)?.[0]?.toLowerCase()
    if (!token) return null
    return (
      props.commands.find(
        (item) =>
          item.name.toLowerCase() === token ||
          item.aliases?.some((alias) => alias.toLowerCase() === token),
      ) ?? null
    )
  })
  const slashGroups = computed(() => {
    if (argumentCompletions.value.length) {
      const command = exactCommand.value
      if (!command) return []
      return [
        {
          label: command.title,
          items: argumentCompletions.value.map((item, index) => ({
            id: `completion:${command.commandId}:${index}`,
            action: 'insert_command' as const,
            label: item.label,
            description: item.description || command.description,
            meta: item.kind || '参数',
            completion: `${command.name} ${item.value}`,
            icon: commandIcon(command.name),
            tone: 'slate' as const,
          })),
        },
      ]
    }
    return buildSlashPaletteGroups(
      [
        ...suggestions.value.filter((item) => item.kind === 'command'),
        ...suggestions.value.filter((item) => item.kind === 'skill'),
      ],
      {
        busy: props.busy,
        canContinue:
          props.goal?.phase === 'paused' || Boolean(props.planPaused),
      },
    ).map(({ label, items }) => ({
      label,
      // A Skill becomes a chip, not text.
      items: items.map((item) =>
        item.kind === 'skill'
          ? skillChipItem(item)
          : paletteItemFromSlash(item),
      ),
    }))
  })
  const addGroups = computed(() =>
    buildCapabilityPickerGroups({
      commands: props.commands,
      plugins: plugins.value,
    }),
  )
  /**
   * `@query` anywhere: plugins only, usable first. ` /name` in the middle
   * of a message: skills only (commands start it).
   */
  const mentionGroups = computed(() => {
    const current = trigger.value
    if (!current) return []
    if (dismissedTrigger.value === triggerKey(current)) return []
    if (current.sigil === '@') {
      const items = rankPluginChoices(plugins.value, current.query)
        .slice(0, 12)
        .map(pluginChipItem)
      return items.length ? [{ label: '插件', items }] : []
    }
    if (current.atStart) return []
    const items = rankSlashPaletteItems(skillItems.value, current.query)
      .slice(0, 12)
      .map(skillChipItem)
    return items.length ? [{ label: 'Skills', items }] : []
  })
  const mode = computed<ComposerPaletteMode | null>(() => {
    if (addMenuOpen.value) return 'add'
    if (slashGroups.value.length) return 'slash'
    if (mentionGroups.value.length) return 'mention'
    return null
  })
  const groups = computed(() =>
    mode.value === 'add'
      ? addGroups.value
      : mode.value === 'mention'
        ? mentionGroups.value
        : slashGroups.value,
  )
  const items = computed(() => groups.value.flatMap((group) => group.items))
  const activeItem = computed(() => {
    if (!items.value.length) return undefined
    return items.value[Math.min(selectionIndex.value, items.value.length - 1)]
  })
  const heading = computed(() =>
    mode.value === 'add'
      ? '添加能力'
      : mode.value === 'mention'
        ? trigger.value?.sigil === '@'
          ? '插件'
          : '技能'
        : '斜杠命令',
  )
  const hint = computed(() =>
    mode.value === 'add' ? '插入 Skill 或插件' : 'Tab 补全第一项',
  )
  /** A typed `/word` that names no command or skill: it goes out as text. */
  const unknownSlashHint = computed(() => {
    const token = value.value.match(/^\/\S+/)?.[0]
    if (!token || token === '/' || isPathLikeSlashToken(token)) return ''
    if (!props.commands.length || mode.value !== null) return ''
    return exactCommand.value ? '' : `${token} 不是命令，将作为普通消息发送`
  })

  watch(mode, (current, previous) => {
    if (current === 'slash' && previous !== 'slash')
      void props.refreshCommands?.()
  })

  watch(value, async (text) => {
    if (dismissedSlashInput.value && dismissedSlashInput.value !== text)
      dismissedSlashInput.value = ''
    selectionIndex.value = 0
    const generation = ++completionGeneration
    argumentCompletions.value = []
    const command = exactCommand.value
    const token = text.match(/^\/\S+/)?.[0] || ''
    if (!command || !props.completeCommand || !/^\/\S+\s/.test(text)) return
    try {
      const rawArgs = text.slice(token.length).trimStart()
      const completions = await props.completeCommand(
        command.commandId,
        rawArgs,
        rawArgs.length,
      )
      if (generation === completionGeneration)
        argumentCompletions.value = completions
    } catch {
      if (generation === completionGeneration) argumentCompletions.value = []
    }
  })

  function move(delta: 1 | -1): void {
    const count = items.value.length
    if (!count) return
    selectionIndex.value = (selectionIndex.value + delta + count) % count
  }

  /** Esc: hide the open `/` or `@` list until what was typed changes. */
  function dismiss(): boolean {
    if (mode.value === 'slash') {
      dismissedSlashInput.value = value.value
      return true
    }
    if (mode.value === 'mention') {
      if (trigger.value) dismissedTrigger.value = triggerKey(trigger.value)
      return true
    }
    return false
  }

  /** A row was used: start over at the top, the lists show again. */
  function reset(): void {
    selectionIndex.value = 0
    dismissedSlashInput.value = ''
  }

  /** The typed `@query` stays as text; its list closes. */
  function dismissTrigger(): void {
    if (trigger.value) dismissedTrigger.value = triggerKey(trigger.value)
    selectionIndex.value = 0
  }

  function onTrigger(next: ComposerTrigger | null): void {
    trigger.value = next
    if (next === null) dismissedTrigger.value = ''
  }

  function toggleAdd(): void {
    if (addMenuOpen.value) {
      closeAdd()
      return
    }
    addMenuOpen.value = true
    document.addEventListener('pointerdown', onAddPointerDown, true)
  }

  function closeAdd(): void {
    if (!addMenuOpen.value) return
    addMenuOpen.value = false
    document.removeEventListener('pointerdown', onAddPointerDown, true)
  }

  function onAddPointerDown(event: PointerEvent): void {
    if (!(event.target instanceof Node)) return
    if (!shell.value?.contains(event.target)) closeAdd()
  }

  return {
    catalog,
    mode,
    groups,
    activeItem,
    heading,
    hint,
    unknownSlashHint,
    exactCommand,
    argumentCompletions,
    selectionIndex,
    move,
    dismiss,
    reset,
    dismissTrigger,
    onTrigger,
    toggleAdd,
    closeAdd,
  }
}

function paletteItemFromSlash(item: SlashPaletteItem): CapabilityPickerItem {
  return {
    id: item.id,
    action:
      item.name === '/plan'
        ? 'activate_plan'
        : item.name === '/goal'
          ? 'activate_goal'
          : 'insert_command',
    label: item.title,
    description: item.description,
    meta: item.kind === 'skill' ? item.sourceLabel : undefined,
    completion: item.completion,
    icon: item.kind === 'skill' ? toolIcon('skill') : commandIcon(item.name),
    tone: 'slate',
  }
}

function commandIcon(name: string): IconComponent {
  if (name === '/new') return actionIcons.commandNew
  if (name === '/compact') return actionIcons.commandCompact
  if (name === '/model') return actionIcons.commandModel
  if (name === '/reasoning') return actionIcons.commandReasoning
  if (name === '/permissions') return actionIcons.commandPermissions
  if (name === '/plan') return actionIcons.commandPlan
  if (name === '/goal') return actionIcons.commandGoal
  if (name === '/stop') return actionIcons.stop
  if (name === '/continue') return actionIcons.commandContinue
  return toolIcon('skill')
}

/** Identifies one typed `/query` (Esc hides its list until it changes). */
function triggerKey(trigger: ComposerTrigger): string {
  return `${trigger.sigil}${trigger.from}:${trigger.query}`
}
