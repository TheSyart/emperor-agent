/**
 * The contacts page's categories (GRP-21). A contact belongs to each of its
 * own `domains`; external agents are 外部 and appear only there; one with
 * no known domain falls back to 其他. Empty categories are left out.
 *
 * The chosen category is a module ref so it survives `/contacts` ↔
 * `/contacts/:id`; tests reset it.
 */
import { ref } from 'vue'
import type { Contact } from '@emperor/core/api'
import { DOMAIN_LABELS } from './contactProfileModel'

export interface ContactCategory {
  id: string
  label: string
  contacts: Contact[]
}

const DOMAIN_ORDER = [
  'product',
  'engineering',
  'design',
  'content',
  'data',
  'security',
  'decision',
] as const

export function contactCategories(
  contacts: readonly Contact[],
): ContactCategory[] {
  const all = [...contacts]
  const local = all.filter((contact) => contact.kind !== 'external')
  const out: ContactCategory[] = [{ id: 'all', label: '全部', contacts: all }]
  for (const domain of DOMAIN_ORDER) {
    const members = local.filter((contact) => contact.domains.includes(domain))
    if (members.length)
      out.push({ id: domain, label: DOMAIN_LABELS[domain], contacts: members })
  }
  const external = all.filter((contact) => contact.kind === 'external')
  if (external.length)
    out.push({ id: 'external', label: '外部', contacts: external })
  const other = local.filter(
    (contact) =>
      contact.domains.length === 0 || contact.domains.includes('other'),
  )
  if (other.length) out.push({ id: 'other', label: '其他', contacts: other })
  return out
}

/** The category on screen, kept across the list and a profile. */
export const activeContactCategory = ref('all')

/** Tests: a fresh page starts on 全部. */
export function resetContactCategoryForTest(): void {
  activeContactCategory.value = 'all'
}
