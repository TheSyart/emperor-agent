<script setup lang="ts">
/**
 * Avatar — one square identity mark (DS-04).
 *   kind: sprite    a child agent's portrait, picked by `id` (stable hash)
 *                   or pinned by `frameId`; cropped at the drawn size into a
 *                   canvas (spriteAvatar.ts), never the whole sheet
 *         color     the first letter of `label` on a soft tile in one of six
 *                   avatar colours picked from `id` (or the label)
 *         logo      a model provider's logo (`iconId`) or an image (`src`,
 *                   plugin logos); falls back to the colour tile
 *         initials  the first letter of `label` on a neutral tile
 *   size: 16 | 20 | 24 (default) | 28 | 40 — off-scale sizes are refused in
 *         development and drawn at the nearest step
 * `status` puts a small state dot on a sprite (running / completed /
 * failed). Decorative (aria-hidden) unless `labelled`, which exposes it as
 * an image named by `label`.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { providerGlyphIcons } from '../../icons'
import {
  providerIconAsset,
  providerIconGlyph,
  providerIconIsMonochrome,
  providerIconMaskCssUrl,
} from '../../model/providerIcons'
import { avatarSeed } from '../workspace/environmentModel'
import {
  avatarColorSlot,
  avatarInitial,
  isAvatarSize,
  nearestAvatarSize,
  type AvatarSize,
} from './avatar'
import {
  portraitBitmap,
  portraitLayout,
  spritePixels,
  spriteSupported,
} from './spriteAvatar'
import { SUBAGENT_PORTRAITS, subagentPortrait } from './subagentPortraits'

const props = withDefaults(
  defineProps<{
    kind?: 'sprite' | 'color' | 'logo' | 'initials'
    size?: AvatarSize
    id?: string | null
    frameId?: string
    iconId?: string | null
    src?: string | null
    label?: string
    status?: string
    labelled?: boolean
  }>(),
  {
    kind: 'initials',
    size: 24,
    id: null,
    frameId: undefined,
    iconId: null,
    src: null,
    label: '',
    status: undefined,
    labelled: false,
  },
)

const size = computed<AvatarSize>(() => {
  if (isAvatarSize(props.size)) return props.size
  if (import.meta.env.DEV)
    console.error(
      `Avatar size "${String(props.size)}" is off the scale; use 16 | 20 | 24 | 28 | 40`,
    )
  return nearestAvatarSize(Number(props.size) || 24)
})

// ── sprite ──
const portrait = computed(
  () =>
    SUBAGENT_PORTRAITS.find((frame) => frame.id === props.frameId) ??
    subagentPortrait(avatarSeed(props.id ?? '')),
)
const pixels = computed(() => spritePixels(size.value))
const canvas = ref<HTMLCanvasElement | null>(null)
let generation = 0

async function paint() {
  const target = canvas.value
  if (props.kind !== 'sprite' || !target || !spriteSupported()) return
  const current = ++generation
  const frame = portrait.value
  const px = pixels.value
  const rect = frame.rect as [number, number, number, number]
  const layout = portraitLayout(rect, px)
  const bitmap = await portraitBitmap(frame.sheet, frame.id, rect, layout)
  if (current !== generation || !bitmap || canvas.value !== target) return
  const context = target.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, px, px)
  context.drawImage(bitmap, layout.x, layout.y)
}

onMounted(() => void paint())
watch(
  () => [props.kind, portrait.value.id, pixels.value],
  () => void paint(),
  { flush: 'post' },
)

// ── logo ──
const asset = computed(() =>
  props.kind === 'logo' && !props.src ? providerIconAsset(props.iconId) : null,
)
const monochrome = computed(() => providerIconIsMonochrome(props.iconId))
const glyph = computed(() => {
  if (props.kind !== 'logo' || props.src || asset.value) return null
  const id = providerIconGlyph(props.iconId)
  return id ? providerGlyphIcons[id] : null
})
const maskStyle = computed(() =>
  asset.value ? { '--avatar-mask': providerIconMaskCssUrl(asset.value) } : {},
)
const broken = ref(false)
watch(
  () => props.src,
  () => (broken.value = false),
)

// ── letters ──
const shown = computed(() => {
  if (props.kind === 'sprite') return 'sprite'
  if (props.kind === 'logo') {
    if (props.src && !broken.value) return 'image'
    if (asset.value) return monochrome.value ? 'mask' : 'asset'
    if (glyph.value) return 'glyph'
    return 'color'
  }
  return props.kind
})
const initial = computed(() => avatarInitial(props.label))
const colorSlot = computed(() =>
  avatarColorSlot(props.id || props.label || '?'),
)
</script>

<template>
  <span
    class="ds-avatar"
    :data-kind="kind"
    :data-size="size"
    :data-shown="shown"
    :data-avatar="kind === 'sprite' ? portrait.id : undefined"
    :data-agent-identity="kind === 'sprite' ? (id ?? undefined) : undefined"
    :data-status="kind === 'sprite' ? status : undefined"
    :data-color="shown === 'color' ? colorSlot : undefined"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :role="labelled ? 'img' : undefined"
    :aria-label="labelled ? label : undefined"
    :aria-hidden="labelled ? undefined : 'true'"
  >
    <canvas
      v-if="shown === 'sprite'"
      ref="canvas"
      class="art sprite"
      :width="pixels"
      :height="pixels"
    />
    <img
      v-else-if="shown === 'image'"
      class="art image"
      :src="src!"
      alt=""
      draggable="false"
      @error="broken = true"
    />
    <span v-else-if="shown === 'mask'" class="art mono" :style="maskStyle" />
    <img
      v-else-if="shown === 'asset'"
      class="art logo"
      :src="asset!"
      alt=""
      draggable="false"
    />
    <component :is="glyph" v-else-if="shown === 'glyph'" class="art glyph" />
    <span v-else class="letter">{{ initial }}</span>
  </span>
</template>

<style scoped>
.ds-avatar {
  --avatar-box: 24px;
  --avatar-art: var(--icon-sm);
  --avatar-tone: var(--avatar-1);
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-sm);
  background: var(--surface-active);
  color: rgb(var(--text-2));
  user-select: none;
}

.ds-avatar[data-size='16'] {
  --avatar-box: 16px;
  border-radius: var(--r-xs);
}

.ds-avatar[data-size='20'] {
  --avatar-box: 20px;
  border-radius: var(--r-xs);
}

.ds-avatar[data-size='28'] {
  --avatar-box: 28px;
  --avatar-art: var(--icon-md);
}

.ds-avatar[data-size='40'] {
  --avatar-box: 40px;
  --avatar-art: calc(var(--icon-lg) + var(--space-0-5));
  border-radius: var(--r-md);
}

/* Portrait sheets have a warm neutral ground in both themes. */
.ds-avatar[data-shown='sprite'] {
  background: rgb(var(--avatar-surface));
}

/* Provider logos sit on a panel tile with a hairline; 16px is bare. */
.ds-avatar[data-shown='mask'],
.ds-avatar[data-shown='asset'],
.ds-avatar[data-shown='glyph'] {
  background: rgb(var(--surface-base));
  box-shadow: inset 0 0 0 0.5px var(--stroke-3);
  color: rgb(var(--text-1));
}

.ds-avatar[data-size='16']:is(
    [data-shown='mask'],
    [data-shown='asset'],
    [data-shown='glyph']
  ) {
  background: transparent;
  box-shadow: none;
}

/* Plugin art is a full-bleed rounded tile already: no frame. */
.ds-avatar[data-shown='image'] {
  background: transparent;
}

.ds-avatar[data-shown='color'] {
  background: rgb(var(--avatar-tone) / 0.16);
  color: rgb(var(--avatar-tone));
}

.ds-avatar[data-color='2'] {
  --avatar-tone: var(--avatar-2);
}

.ds-avatar[data-color='3'] {
  --avatar-tone: var(--avatar-3);
}

.ds-avatar[data-color='4'] {
  --avatar-tone: var(--avatar-4);
}

.ds-avatar[data-color='5'] {
  --avatar-tone: var(--avatar-5);
}

.ds-avatar[data-color='6'] {
  --avatar-tone: var(--avatar-6);
}

.art {
  display: block;
  width: var(--avatar-art);
  height: var(--avatar-art);
  object-fit: contain;
}

.sprite,
.image {
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
}

.mono {
  background-color: currentColor;
  mask: var(--avatar-mask) center / contain no-repeat;
}

.glyph {
  color: rgb(var(--text-2));
}

.letter {
  font-size: calc(var(--avatar-box) * 0.46);
  line-height: 1;
  font-weight: var(--weight-semibold);
}

.ds-avatar[data-status]::after {
  content: '';
  position: absolute;
  right: -2px;
  bottom: -1px;
  width: var(--dot-sm);
  height: var(--dot-sm);
  border-radius: var(--r-full);
  box-shadow: 0 0 0 1.5px rgb(var(--surface-base));
  background: rgb(var(--text-3));
}

.ds-avatar[data-status='running']::after {
  background: rgb(var(--accent));
}

.ds-avatar[data-status='completed']::after {
  background: rgb(var(--ok));
}

.ds-avatar[data-status='failed']::after {
  background: rgb(var(--error));
}
</style>
