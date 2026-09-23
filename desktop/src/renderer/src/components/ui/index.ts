// dsh design-system primitives (M3). Scoped styles consume theme tokens only;
// global motion classes live in styles/dsh/animations.css.
export { default as CodeBlock } from './CodeBlock.vue'
export { default as Button } from './Button.vue'
export { default as Chip } from './Chip.vue'
export { default as DiffBlock } from './DiffBlock.vue'
export { default as DisclosureRow } from './DisclosureRow.vue'
export { default as ElapsedClock } from './ElapsedClock.vue'
export { default as IconButton } from './IconButton.vue'
export { default as InOutCard } from './InOutCard.vue'
export { default as JsonTree } from './JsonTree.vue'
export { default as Menu } from './Menu.vue'
export { default as MenuItem } from './MenuItem.vue'
export { default as Modal } from './Modal.vue'
export { default as Pill } from './Pill.vue'
export { default as ProviderLogo } from './ProviderLogo.vue'
export { default as ReadBlock } from './ReadBlock.vue'
export { default as SearchBlock } from './SearchBlock.vue'
export { default as Shimmer } from './Shimmer.vue'
export { default as StateDot } from './StateDot.vue'
export { default as Tabs } from './Tabs.vue'
export { default as TerminalBlock } from './TerminalBlock.vue'
export { default as Toast } from './Toast.vue'
export { default as Tooltip } from './Tooltip.vue'
export { default as WebBlock } from './WebBlock.vue'
export type {
  ReadBlockLine,
  SearchFileGroup,
  SearchLineMatch,
  TabItem,
  WebSource,
} from './blockTypes'
export type { DiffHunk, DiffRow, DiffRowKind } from './diffRows'
export { buildDiffRows, diffCopyText, diffFooter } from './diffRows'
export type { StateDotState } from './stateDot'
export { stateFromStatus } from './stateDot'
export { formatElapsed } from './elapsed'
export { headTailCap } from './headTailCap'
