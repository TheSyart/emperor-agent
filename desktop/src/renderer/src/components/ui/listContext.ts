/**
 * List → ListRow channel (DS-04): a row inside a <List> is an option of a
 * listbox (role option, aria-selected); a row on its own is a button.
 */
import { inject, provide, type InjectionKey } from 'vue'

export interface ListContext {
  listbox: true
}

const LIST_CONTEXT: InjectionKey<ListContext> = Symbol('ds-list')

export function provideList(): void {
  provide(LIST_CONTEXT, { listbox: true })
}

export function useList(): ListContext | null {
  return inject(LIST_CONTEXT, null)
}

/** The rows a keyboard move can land on, in the row's own list. */
export function siblingRows(row: HTMLElement): HTMLElement[] {
  const scope =
    row.closest<HTMLElement>('[data-ds-list]') ?? row.parentElement ?? row
  return [
    ...scope.querySelectorAll<HTMLElement>(
      '.ds-list-row:not([aria-disabled="true"])',
    ),
  ]
}
