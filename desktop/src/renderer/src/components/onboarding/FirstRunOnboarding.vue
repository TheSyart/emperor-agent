<script setup lang="ts">
/**
 * FirstRunOnboarding — the full-window first-run guide (UI-S17), shown at
 * launch while there is no model entry at all (firstRunModel.ts decides)
 * and from the hero's 开始接入.
 *
 * 欢迎 offers a local server (probed when the guide opens; first and
 * recommended when one runs) or an API key. 连接 → 选择模型 (→ 确认参数,
 * only when a picked model has an unknown value) are the add-model
 * dialog's own steps on its controller, so there is one way to add a
 * model. 就绪 tests the new model in the background; 开始使用 returns to
 * the chat. 稍后配置 puts the guide off for good (the hero keeps a way
 * back).
 *
 * A modal layer with the shared focus trap: the app behind is inert.
 * Escape goes back one step; on 欢迎 it is 稍后配置.
 *
 * Emits: close('later' | 'done').
 */
import { computed, nextTick, ref, watch } from 'vue'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cpu,
  KeyRound,
  Lock,
} from 'lucide-vue-next'
import heroDarkUrl from '../../../../../../assets/generated/model-setup-hero-dark.webp'
import heroLightUrl from '../../../../../../assets/generated/model-setup-hero-light.webp'
import { testModelEntry } from '../../api/model'
import { useAppContext } from '../../composables/useAppContext'
import { useTheme } from '../../composables/useTheme'
import { applyModelConfig } from '../../model/applyModelConfig'
import BrandMark from '../brand/BrandMark.vue'
import ConfirmParamsStep from '../settings/model/ConfirmParamsStep.vue'
import ConnectStep from '../settings/model/ConnectStep.vue'
import PickModelsStep from '../settings/model/PickModelsStep.vue'
import {
  createAddModelController,
  provideAddModel,
} from '../settings/model/addModelController'
import Badge from '../ui/Badge.vue'
import Button from '../ui/Button.vue'
import Dot from '../ui/Dot.vue'
import Kbd from '../ui/Kbd.vue'
import LinkButton from '../ui/LinkButton.vue'
import Surface from '../ui/Surface.vue'
import { useModalLayer } from '../ui/modalStack'
import { useFocusTrap } from '../ui/useFocusTrap'
import type { ModelConfigPayload } from '../../types'
import { rememberFirstRunDismissed } from './firstRunGate'
import {
  RAIL,
  railIndex,
  setupHeading,
  welcomeChoices,
  type FirstRunStage,
  type WelcomeChoice,
} from './firstRunModel'

const emit = defineEmits<{ close: [reason: 'later' | 'done'] }>()

const ctx = useAppContext()
const { theme } = useTheme()
const heroUrl = computed(() =>
  theme.value === 'light' ? heroLightUrl : heroDarkUrl,
)

const root = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const stage = ref<FirstRunStage>('welcome')
const open = ref(true)

/** What 就绪 reports: the provider, the model in use and its test. */
const ready = ref({ provider: '', model: '' })
const test = ref<'running' | 'ok' | 'failed'>('running')
const testError = ref('')

const add = createAddModelController({
  payload: () => ctx.boot.value!.modelConfig,
  skipKnownConfirm: true,
  onSaved: (result) => void finish(result),
})
provideAddModel(add)
void add.start()

const choices = computed(() =>
  welcomeChoices(add.options, add.local, add.localProbed),
)
const rail = computed(() => railIndex(stage.value, add.step))
const providerLabel = computed(
  () => add.option?.displayName ?? add.connection.provider ?? '',
)
const heading = computed(() =>
  setupHeading({
    step: add.step,
    provider: add.connection.provider,
    providerLabel: providerLabel.value,
    isLocal: add.isLocal,
    running: Boolean(
      add.connection.provider && add.local[add.connection.provider]?.running,
    ),
    modelCount: add.models.length,
  }),
)
const testText = computed(() =>
  test.value === 'running'
    ? '正在测试连接…'
    : test.value === 'ok'
      ? '连接测试通过'
      : `连接测试失败：${testError.value}`,
)

function choose(choice: WelcomeChoice): void {
  add.query = ''
  add.error = null
  if (choice.provider) add.pickProvider(choice.provider)
  else add.connection.provider = null
  add.step = 'connect'
  stage.value = 'setup'
}

function toWelcome(): void {
  stage.value = 'welcome'
}

function later(): void {
  rememberFirstRunDismissed()
  open.value = false
  emit('close', 'later')
}

function done(): void {
  open.value = false
  emit('close', 'done')
}

function back(): void {
  if (stage.value === 'welcome') later()
  else if (stage.value === 'ready') done()
  else if (add.step === 'confirm') add.step = 'pick'
  else if (add.step === 'pick') add.step = 'connect'
  else toWelcome()
}

/** Saved: apply the config, show 就绪, test the model now in use. */
async function finish(
  result: ModelConfigPayload & { savedEntryIds: string[] },
): Promise<void> {
  applyModelConfig(ctx.boot.value, result)
  const current = result.current
  ready.value = {
    provider: current?.providerLabel || providerLabel.value,
    model: current?.effectiveDisplayName || current?.modelId || '',
  }
  stage.value = 'ready'
  const ids = result.savedEntryIds
  const entryId =
    result.activeModelId && ids.includes(result.activeModelId)
      ? result.activeModelId
      : ids[0]
  if (!entryId) {
    test.value = 'ok'
    return
  }
  test.value = 'running'
  try {
    const outcome = await testModelEntry(entryId, 'text')
    test.value = outcome.ok ? 'ok' : 'failed'
    testError.value = outcome.ok ? '' : (outcome.error ?? '没有回复')
  } catch (error) {
    test.value = 'failed'
    testError.value = error instanceof Error ? error.message : String(error)
  }
}

useModalLayer(open, back)
useFocusTrap(root, open)

// The local probe can reorder 欢迎 (a running server comes first): keep
// the focus on the first way in while the user has not moved it.
watch(
  () => add.localProbed,
  async (probed) => {
    if (!probed || stage.value !== 'welcome') return
    await nextTick()
    const active = document.activeElement
    if (active && active !== document.body && !active.closest('[data-choice]'))
      return
    content.value?.querySelector<HTMLElement>('[data-choice]')?.focus()
  },
)

// A new step: focus its first field (or its main action).
watch([stage, () => add.step], async () => {
  await nextTick()
  const scope = content.value
  const target =
    scope?.querySelector<HTMLElement>('[data-autofocus]') ??
    scope?.querySelector<HTMLElement>(
      'input:not([type="checkbox"]):not([disabled])',
    ) ??
    scope?.querySelector<HTMLElement>('.ds-button[data-variant="primary"]')
  target?.focus()
})
</script>

<template>
  <div
    ref="root"
    class="first-run"
    role="dialog"
    aria-modal="true"
    aria-labelledby="first-run-title"
    :data-stage="stage"
    data-testid="first-run"
  >
    <img
      class="art"
      :src="heroUrl"
      alt=""
      aria-hidden="true"
      draggable="false"
    />

    <header class="bar">
      <span class="brand">
        <BrandMark :size="22" />
        <span class="brand-name">Emperor Agent</span>
      </span>
      <ol v-if="rail >= 0" class="rail" aria-label="接入进度">
        <li
          v-for="(label, index) in RAIL"
          :key="label"
          :data-state="
            index < rail ? 'done' : index === rail ? 'current' : 'next'
          "
          :aria-current="index === rail ? 'step' : undefined"
        >
          <span class="rail-index">
            <Check v-if="index < rail" :size="12" />
            <template v-else>{{ index + 1 }}</template>
          </span>
          {{ label }}
        </li>
      </ol>
      <Button
        v-if="stage !== 'ready'"
        class="later"
        size="sm"
        data-dismiss
        @click="later"
        >稍后配置<Kbd class="later-key">Esc</Kbd></Button
      >
    </header>

    <main ref="content" class="content">
      <section v-if="stage === 'welcome'" class="welcome">
        <p class="eyebrow">开始之前</p>
        <h1 id="first-run-title" class="display">把任务交给<br />本地 Agent</h1>
        <p class="lede">
          接入一个模型，Emperor 就能在这台 Mac
          上对话、调用工具、记住你的偏好，并把任务做完。
        </p>
        <p id="first-run-ways" class="ways-label">选择接入方式</p>
        <div
          class="choices"
          role="group"
          aria-labelledby="first-run-ways"
          :aria-busy="add.localProbed ? undefined : 'true'"
          :data-probed="add.localProbed || undefined"
        >
          <Surface
            v-for="(choice, index) in choices"
            :key="choice.key"
            as="button"
            interactive
            radius="lg"
            pad="none"
            class="choice"
            :data-choice="choice.key"
            :data-recommended="choice.recommended || undefined"
            :data-autofocus="index === 0 ? '' : undefined"
            @click="choose(choice)"
          >
            <span class="choice-icon">
              <component
                :is="choice.key === 'local' ? Cpu : KeyRound"
                :size="20"
              />
            </span>
            <span class="choice-text">
              <span class="choice-title"
                >{{ choice.title
                }}<Badge v-if="choice.recommended" tone="accent" label="推荐"
              /></span>
              <span class="choice-desc"
                ><Dot v-if="choice.recommended" state="ok" size="sm" />{{
                  choice.description
                }}</span
              >
            </span>
            <ChevronRight :size="16" class="choice-chevron" />
          </Surface>
        </div>
        <p class="privacy">
          <Lock :size="14" />模型配置保存在本机私有数据目录。
        </p>
      </section>

      <section v-else-if="stage === 'setup'" class="setup">
        <LinkButton
          v-if="add.step === 'connect'"
          class="back"
          @click="toWelcome"
          ><ArrowLeft :size="14" />返回</LinkButton
        >
        <h2 id="first-run-title" class="title">{{ heading.title }}</h2>
        <p class="subtitle">{{ heading.subtitle }}</p>
        <div class="step">
          <ConnectStep v-if="add.step === 'connect'" />
          <PickModelsStep v-else-if="add.step === 'pick'" />
          <ConfirmParamsStep v-else />
        </div>
      </section>

      <section v-else class="ready">
        <span class="ready-mark"><Check :size="20" /></span>
        <h1 id="first-run-title" class="display">准备好了</h1>
        <p class="lede">
          已接入 {{ ready.provider }}，默认使用
          <span class="mono">{{ ready.model }}</span
          >。
        </p>
        <p class="test" role="status" :data-state="test">
          <Dot
            :state="test === 'ok' ? 'ok' : test === 'failed' ? 'error' : 'idle'"
            size="sm"
          />{{ testText }}
        </p>
        <div class="ready-actions">
          <Button variant="primary" size="lg" data-autofocus @click="done"
            >开始使用</Button
          >
        </div>
        <p class="hint">之后可以在 设置 › 模型 添加更多模型。</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
/* Above the app, its sticky bars and overlays; below popovers (the step
   selects), toasts, confirms and menus. */
.first-run {
  position: fixed;
  inset: 0;
  z-index: var(--z-drawer);
  display: grid;
  grid-template-rows: 64px minmax(0, 1fr);
  overflow-x: hidden;
  overflow-y: auto;
  background: rgb(var(--surface-canvas));
  color: rgb(var(--text-1));
}

/* The illustration is 1600 × 1000: shown at most 1040 wide (crisp enough
   on Retina) and faded into the canvas, whose colour its ground matches. */
.art {
  position: absolute;
  top: 50%;
  right: 0;
  z-index: var(--z-base);
  width: min(1040px, 72%);
  aspect-ratio: 16 / 10;
  object-fit: cover;
  transform: translateY(-50%);
  /* Faded on the left, top and bottom; the right edge meets the window. */
  mask-image:
    linear-gradient(to right, transparent 0%, rgb(var(--surface-canvas)) 40%),
    linear-gradient(
      to bottom,
      transparent 0%,
      rgb(var(--surface-canvas)) 22%,
      rgb(var(--surface-canvas)) 78%,
      transparent 100%
    );
  mask-composite: intersect;
  pointer-events: none;
  user-select: none;
  transition: opacity var(--motion-slow) var(--ease-standard);
}

.first-run[data-stage='setup'] .art {
  opacity: 0.45;
}

.bar {
  position: relative;
  z-index: var(--z-raised);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-7);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2-5);
}

.brand-name {
  font: var(--weight-semibold) var(--type-title-sm) var(--font-sans);
  letter-spacing: 0.01em;
}

.rail {
  position: absolute;
  left: 50%;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
  transform: translateX(-50%);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-3));
}

.rail li {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.rail li + li::before {
  width: 28px;
  height: 0.5px;
  margin-right: var(--space-1);
  background: var(--stroke-3);
  content: '';
}

.rail li[data-state='current'] {
  color: rgb(var(--text-1));
  font-weight: var(--weight-semibold);
}

.rail li[data-state='done'] {
  color: rgb(var(--text-1));
}

.rail-index {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  box-shadow: inset 0 0 0 0.5px var(--stroke-3);
  font-size: var(--fs-xxxs);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

.rail li[data-state='current'] .rail-index {
  background: rgb(var(--accent));
  box-shadow: none;
  color: rgb(var(--text-on-accent));
}

.rail li[data-state='done'] .rail-index {
  background: rgb(var(--accent-soft));
  box-shadow: none;
  color: rgb(var(--text-link));
}

.later {
  color: rgb(var(--text-2));
}

.later-key {
  margin-left: var(--space-1-5);
  padding: 0 var(--space-1);
  border-radius: var(--r-xs);
  box-shadow: inset 0 0 0 0.5px var(--stroke-3);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
}

.content {
  position: relative;
  z-index: var(--z-raised);
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: min(560px, 100%);
  box-sizing: border-box;
  padding: var(--space-6) 0 var(--space-8) clamp(32px, 8.4vw, 120px);
}

.welcome,
.setup,
.ready {
  display: flex;
  flex-direction: column;
}

.eyebrow {
  margin: 0 0 var(--space-4);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  letter-spacing: 0.08em;
  color: rgb(var(--text-3));
}

.display {
  margin: 0;
  font-size: 56px;
  line-height: 64px;
  font-weight: var(--weight-semibold);
  letter-spacing: -0.01em;
  text-wrap: balance;
}

.lede {
  max-width: 470px;
  margin: var(--space-6) 0 0;
  font-size: 17px;
  line-height: 28px;
  color: rgb(var(--text-2));
  text-wrap: pretty;
}

.ways-label {
  margin: calc(var(--space-8) + var(--space-3)) 0 var(--space-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-3));
}

.choices {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-standard);
}

.choices[data-probed] {
  opacity: 1;
}

.choice {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  min-height: 80px;
  padding: var(--space-4) var(--space-5);
  background: rgb(var(--surface-base));
}

.choice[data-recommended] {
  box-shadow: inset 0 0 0 1px rgb(var(--accent) / 0.55);
}

.choice:focus-visible {
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.6);
}

.choice-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: var(--r-md);
  background: var(--surface-hover);
  color: rgb(var(--text-2));
}

.choice[data-recommended] .choice-icon {
  color: rgb(var(--text-link));
}

.choice-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.choice-title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: var(--weight-semibold);
}

.choice-desc {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-3));
}

.choice-chevron {
  flex: none;
  color: rgb(var(--text-3));
}

.privacy {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-5) 0 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.back {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: var(--space-1-5);
}

.title {
  margin: var(--space-4) 0 0;
  font-size: 32px;
  line-height: 40px;
  font-weight: var(--weight-semibold);
}

.subtitle {
  margin: var(--space-2) 0 0;
  font-size: var(--fs-md);
  line-height: var(--lh-base);
  color: rgb(var(--text-2));
  text-wrap: pretty;
}

.step {
  margin-top: var(--space-6);
}

.ready-mark {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin-bottom: var(--space-7);
  border-radius: var(--r-full);
  background: rgb(var(--ok-soft));
  color: rgb(var(--ok));
}

.mono {
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: rgb(var(--text-1));
}

.test {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: var(--space-2);
  margin: var(--space-6) 0 0;
  padding: var(--space-1-5) var(--space-3);
  border-radius: var(--r-full);
  background: rgb(var(--surface-base));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.ready-actions {
  display: flex;
  margin-top: calc(var(--space-8) + var(--space-3));
}

.hint {
  margin: var(--space-4) 0 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

/* A narrow window: the illustration becomes a banner above the copy. */
@media (max-width: 760px) {
  .first-run {
    --banner: 250px;
    display: block;
  }

  .first-run[data-stage='setup'] {
    --banner: 150px;
  }

  .art {
    top: 0;
    left: 0;
    width: 100%;
    height: var(--banner);
    aspect-ratio: auto;
    object-position: 80% 50%;
    transform: none;
    mask-image: linear-gradient(
      to bottom,
      rgb(var(--surface-canvas)) 55%,
      transparent 100%
    );
  }

  .bar {
    height: 64px;
  }

  .rail {
    display: none;
  }

  /* The copy starts over the banner's fade. */
  .content {
    width: auto;
    padding: calc(var(--banner) - 56px) var(--space-8) var(--space-8);
  }

  .display {
    font-size: 36px;
    line-height: 44px;
  }
}
</style>
