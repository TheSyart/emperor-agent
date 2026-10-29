<script setup lang="ts">
/**
 * 设置 › 常规 › 外观 › 皮肤 (BRD-05): the official skins, then imported
 * ones, each a card with a small preview in its own colours (and its
 * picture, while decorations are shown), who made it and whether it has
 * one look or both. 使用 puts it on; 从文件夹导入… lets main pick and
 * check a folder (asking before a skin with the same id is replaced, and
 * listing every reason a folder is refused); imported skins can be
 * deleted. A folder in the Home that no longer passes is listed with why.
 * Loaded with this page only.
 */
import { computed, onMounted, ref } from 'vue'
import {
  DEFAULT_SKIN_ID,
  type SkinListEntry,
  type SkinSwatch,
  type SkinView,
} from '../../../../../shared/skin-contract'
import { useAppContext } from '../../../composables/useAppContext'
import { useTheme } from '../../../composables/useTheme'
import { selectSkin, useSkin } from '../../../skin/skinState'
import Button from '../../ui/Button.vue'
import { confirm } from '../../ui/confirm'
import { Badge, EmptyState, Notice, SettingsGroup } from '../ui'
import { importSkin, listSkins, pickSkinFolder, removeSkin } from './skinsApi'

const ctx = useAppContext()
const { theme } = useTheme()
const { skin: active, decorations } = useSkin()

const entries = ref<SkinListEntry[]>([])
const loadError = ref('')
const loading = ref(true)
const busy = ref(false)
const problems = ref<string[]>([])

const activeId = computed(() => active.value?.id ?? DEFAULT_SKIN_ID)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function load(): Promise<void> {
  try {
    entries.value = await listSkins()
    loadError.value = ''
  } catch (error) {
    loadError.value = messageOf(error)
  } finally {
    loading.value = false
  }
}

function looks(view: SkinView): string {
  if (view.base === 'light') return '只有浅色'
  if (view.base === 'dark') return '只有深色'
  return '浅色和深色'
}

function swatch(view: SkinView): SkinSwatch | undefined {
  return view.base === 'auto'
    ? view.preview[theme.value]
    : view.preview[view.base]
}

function previewStyle(view: SkinView): Record<string, string> {
  const colours = swatch(view)
  if (!colours) return {}
  return {
    '--pv-canvas': colours.canvas,
    '--pv-base': colours.base,
    '--pv-raised': colours.raised,
    '--pv-text-1': colours.text1,
    '--pv-text-2': colours.text2,
    '--pv-brand': colours.brand,
  }
}

function picture(view: SkinView): string | null {
  if (!decorations.value) return null
  return view.slots.hero ?? null
}

async function use(view: SkinView): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await selectSkin(view.id)
  } catch (error) {
    ctx.showError(messageOf(error), '没能换皮肤')
  } finally {
    busy.value = false
  }
}

async function importFolder(): Promise<void> {
  if (busy.value) return
  busy.value = true
  problems.value = []
  try {
    const picked = await pickSkinFolder()
    if (picked.kind === 'canceled') return
    if (picked.kind === 'refused') {
      problems.value = picked.problems
      return
    }
    if (
      picked.replaces &&
      !(await confirm({
        title: `替换皮肤「${picked.skin.name}」？`,
        body: '已导入的同一个皮肤（id 相同）会被这个文件夹里的替换。',
        confirmLabel: '替换',
      }))
    )
      return
    const done = await importSkin(picked.stageId)
    if ('problems' in done) {
      problems.value = done.problems
      return
    }
    ctx.showToast(`已导入皮肤「${done.skin.name}」`)
    await load()
    if (activeId.value === done.skin.id) await selectSkin(done.skin.id)
  } catch (error) {
    ctx.showError(messageOf(error), '没能导入皮肤')
  } finally {
    busy.value = false
  }
}

async function remove(view: SkinView): Promise<void> {
  if (
    busy.value ||
    !(await confirm({
      title: `删除皮肤「${view.name}」？`,
      body: '删掉 Emperor 里的这份皮肤，不影响你原来的文件夹。',
      confirmLabel: '删除',
      tone: 'danger',
    }))
  )
    return
  busy.value = true
  try {
    await removeSkin(view.id)
    if (activeId.value === view.id) await selectSkin(DEFAULT_SKIN_ID)
    await load()
  } catch (error) {
    ctx.showError(messageOf(error), '没能删除皮肤')
  } finally {
    busy.value = false
  }
}

async function removeBroken(id: string, name: string): Promise<void> {
  await remove({ id, name } as SkinView)
}

onMounted(() => void load())
</script>

<template>
  <div class="skins-page">
    <SettingsGroup
      title="皮肤"
      description="皮肤只改颜色、标题字体和几张装饰图；对话正文、代码、改动对比、权限确认、费用和登录界面保持原样。"
      variant="stack"
      data-group="skins"
    >
      <Notice
        v-if="loadError"
        tone="error"
        title="读不出皮肤列表"
        :description="loadError"
      >
        <template #actions>
          <Button size="sm" variant="secondary" @click="load()">重试</Button>
        </template>
      </Notice>
      <EmptyState
        v-else-if="loading && !entries.length"
        title="正在读取皮肤…"
        variant="inline"
      />
      <div v-else class="grid">
        <template v-for="entry in entries" :key="entry.id">
          <div
            v-if="entry.ok"
            class="card"
            :data-skin-card="entry.id"
            :data-active="entry.id === activeId || undefined"
          >
            <div
              class="preview"
              data-skin-preview
              aria-hidden="true"
              :style="previewStyle(entry.view)"
            >
              <span class="side"
                ><span class="line" /><span class="line short"
              /></span>
              <span class="main"
                ><span class="headline" /><span class="composer"
              /></span>
              <img
                v-if="picture(entry.view)"
                class="picture"
                :src="picture(entry.view)!"
                alt=""
                draggable="false"
                loading="lazy"
              />
            </div>
            <div class="meta">
              <div class="name-row">
                <span class="name">{{ entry.view.name }}</span>
                <Badge
                  :label="entry.view.official ? '官方' : '导入'"
                  :tone="entry.view.official ? 'accent' : 'neutral'"
                />
              </div>
              <p v-if="entry.view.description" class="description">
                {{ entry.view.description }}
              </p>
              <p class="facts">
                {{ entry.view.author || '未署名' }} · {{ looks(entry.view) }}
              </p>
            </div>
            <div class="actions">
              <Button
                v-if="entry.id === activeId"
                size="sm"
                variant="secondary"
                disabled
                >使用中</Button
              >
              <Button
                v-else
                size="sm"
                variant="secondary"
                :disabled="busy"
                @click="use(entry.view)"
                >使用</Button
              >
              <Button
                v-if="!entry.view.official"
                size="sm"
                variant="ghost"
                :disabled="busy"
                @click="remove(entry.view)"
                >删除</Button
              >
            </div>
          </div>
          <div v-else class="card broken" :data-skin-card="entry.id">
            <Notice tone="warn" :title="`「${entry.name}」无法使用`">
              <ul class="reasons">
                <li v-for="reason in entry.problems" :key="reason">
                  {{ reason }}
                </li>
              </ul>
            </Notice>
            <div class="actions">
              <Button
                size="sm"
                variant="ghost"
                :disabled="busy"
                @click="removeBroken(entry.id, entry.name)"
                >删除</Button
              >
            </div>
          </div>
        </template>
      </div>
    </SettingsGroup>

    <SettingsGroup
      title="导入"
      description="选一个含有 skin.json 的文件夹。Emperor 会先检查：不能带脚本、网页、SVG 或样式表，图片只能是 PNG / WebP，文字要看得清。"
      variant="stack"
      data-group="skin-import"
    >
      <Notice
        v-if="problems.length"
        tone="error"
        title="没能导入"
        data-skin-import-problems
      >
        <ul class="reasons">
          <li v-for="reason in problems" :key="reason">{{ reason }}</li>
        </ul>
      </Notice>
      <div class="import-row">
        <Button variant="secondary" :disabled="busy" @click="importFolder()"
          >从文件夹导入…</Button
        >
      </div>
    </SettingsGroup>
  </div>
</template>

<style scoped>
.skins-page {
  display: grid;
  gap: var(--space-6);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-3);
}

.card {
  display: grid;
  align-content: start;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--r-md);
  background: rgb(var(--settings-card-fill));
  box-shadow: 0 0 0 0.5px var(--hairline);
}

.card[data-active] {
  box-shadow: 0 0 0 1.5px rgb(var(--accent));
}

.preview {
  position: relative;
  display: grid;
  grid-template-columns: 34% 1fr;
  height: calc(var(--space-8) * 3);
  overflow: hidden;
  border-radius: var(--r-sm);
  background: rgb(var(--pv-base, var(--surface-base)));
  box-shadow: 0 0 0 0.5px var(--hairline);
}

.side {
  display: grid;
  align-content: start;
  gap: var(--space-1);
  padding: var(--space-2);
  background: rgb(var(--pv-canvas, var(--surface-canvas)));
}

.main {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
}

.line,
.headline,
.composer {
  display: block;
  height: var(--space-1-5);
  border-radius: var(--r-xs);
}

.line {
  width: 80%;
  background: rgb(var(--pv-text-2, var(--text-2)) / 0.35);
}

.line.short {
  width: 56%;
}

.headline {
  width: calc(var(--space-8) * 2);
  background: rgb(var(--pv-text-1, var(--text-1)));
}

.composer {
  width: calc(var(--space-8) * 3);
  height: var(--space-4);
  background: rgb(var(--pv-raised, var(--surface-raised)));
  box-shadow: inset 0 -2px 0 rgb(var(--pv-brand, var(--brand)));
}

.picture {
  position: absolute;
  right: var(--space-1);
  bottom: 0;
  height: 86%;
  object-fit: contain;
  pointer-events: none;
}

.meta {
  display: grid;
  gap: var(--space-0-5);
  min-width: 0;
}

.name-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
}

.name {
  color: rgb(var(--text-1));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-medium);
}

.description,
.facts {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.description {
  color: rgb(var(--text-2));
}

.actions {
  display: flex;
  gap: var(--space-1);
}

.reasons {
  margin: 0;
  padding-left: var(--space-4);
  overflow-wrap: anywhere;
}

.import-row {
  display: flex;
}
</style>
