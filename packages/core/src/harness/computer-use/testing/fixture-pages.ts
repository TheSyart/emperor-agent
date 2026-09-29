/**
 * Fixture pages for the fake browser driver. The same page names are served
 * as real HTML by the Electron end-to-end fixture site (M1), so the driver
 * contract cases can run against both.
 */

import type { UiRole } from '../types'

export interface FixtureElement {
  readonly id: string
  readonly role: UiRole
  readonly name: string
  readonly value?: string
  /** `password` / `cc-number` / `one-time-code` / `hidden` never expose a value. */
  readonly sensitive?: 'password' | 'cc-number' | 'one-time-code' | 'hidden'
  readonly options?: readonly string[]
  readonly frameId?: string
  /** Origin of the cross-origin frame the element lives in. */
  readonly frameOrigin?: string
  /** Clicking follows this link (page-relative or absolute). */
  readonly href?: string
  /** Same-document route change on click. */
  readonly pushState?: string
  /** Clicking opens a popup to this URL. */
  readonly popup?: string
  /** Clicking downloads this file (page-relative URL). */
  readonly download?: string
  /** A file input. */
  readonly file?: boolean
  readonly disabled?: boolean
  readonly shadow?: boolean
}

export interface FixturePage {
  readonly path: string
  readonly title: string
  readonly text: string
  readonly elements: readonly FixtureElement[]
  /** Elements that appear only after this many milliseconds. */
  readonly delayedElements?: {
    readonly afterMs: number
    readonly elements: readonly FixtureElement[]
  }
  readonly notes?: readonly string[]
}

const longList: FixtureElement[] = Array.from({ length: 400 }, (_, index) => ({
  id: `item-${index}`,
  role: 'link',
  name: `Item ${index + 1}`,
  href: `/long#${index + 1}`,
}))

export const FIXTURE_PAGES: Readonly<Record<string, FixturePage>> = {
  '/form': {
    path: '/form',
    title: 'Fixture form',
    text: 'Sign up for the fixture newsletter.',
    elements: [
      { id: 'name', role: 'textbox', name: 'Name', value: '' },
      { id: 'email', role: 'textbox', name: 'Email', value: '' },
      {
        id: 'password',
        role: 'textbox',
        name: 'Password',
        value: '',
        sensitive: 'password',
      },
      {
        id: 'card',
        role: 'textbox',
        name: 'Card number',
        value: '',
        sensitive: 'cc-number',
      },
      {
        id: 'otp',
        role: 'textbox',
        name: 'One-time code',
        value: '',
        sensitive: 'one-time-code',
      },
      {
        id: 'country',
        role: 'combobox',
        name: 'Country',
        value: 'China',
        options: ['China', 'Japan', 'France'],
      },
      { id: 'agree', role: 'checkbox', name: 'I agree', value: 'false' },
      { id: 'submit', role: 'button', name: 'Submit', href: '/done' },
      { id: 'disabled', role: 'button', name: 'Disabled', disabled: true },
    ],
  },
  '/done': {
    path: '/done',
    title: 'Thanks',
    text: 'Thanks for signing up.',
    elements: [
      { id: 'back', role: 'link', name: 'Back to form', href: '/form' },
    ],
  },
  '/spa': {
    path: '/spa',
    title: 'SPA',
    text: 'Single page app.',
    elements: [
      { id: 'tab-a', role: 'tab', name: 'Tab A', pushState: '/spa#a' },
      { id: 'tab-b', role: 'tab', name: 'Tab B', pushState: '/spa#b' },
    ],
  },
  '/long': {
    path: '/long',
    title: 'Long list',
    text: 'A long list of links.',
    elements: longList,
  },
  '/frames': {
    path: '/frames',
    title: 'Frames',
    text: 'A page with frames.',
    elements: [
      { id: 'outer', role: 'button', name: 'Outer button' },
      {
        id: 'inner',
        role: 'button',
        name: 'Inner button',
        frameId: 'same-origin-frame',
      },
    ],
    notes: ['cross-origin frame https://other.test/embed not expanded'],
  },
  '/embedded-pay': {
    path: '/embedded-pay',
    title: 'Embedded payment',
    text: 'A shop page embedding a payment frame of another site.',
    elements: [
      { id: 'coupon', role: 'button', name: 'Apply coupon' },
      {
        id: 'card-next',
        role: 'button',
        name: 'Continue with card',
        frameId: 'pay-frame',
        frameOrigin: 'https://other.test',
      },
    ],
  },
  '/shadow': {
    path: '/shadow',
    title: 'Shadow DOM',
    text: 'Custom elements.',
    elements: [
      {
        id: 'shadow-button',
        role: 'button',
        name: 'Shadow button',
        shadow: true,
      },
    ],
  },
  '/login': {
    path: '/login',
    title: 'Sign in',
    text: 'Sign in to the fixture site.',
    elements: [
      { id: 'user', role: 'textbox', name: 'Username', value: '' },
      {
        id: 'pass',
        role: 'textbox',
        name: 'Password',
        value: '',
        sensitive: 'password',
      },
      {
        id: 'otp',
        role: 'textbox',
        name: 'One-time code',
        value: '',
        sensitive: 'one-time-code',
      },
      { id: 'signin', role: 'button', name: 'Sign in' },
    ],
  },
  '/files': {
    path: '/files',
    title: 'Files',
    text: 'Reports to download.',
    elements: [
      {
        id: 'report',
        role: 'link',
        name: 'Download report',
        download: '/files/report.csv',
      },
      {
        id: 'installer',
        role: 'link',
        name: 'Download installer',
        download: '/files/setup.dmg',
      },
    ],
  },
  '/upload': {
    path: '/upload',
    title: 'Upload',
    text: 'Attach a document.',
    elements: [
      { id: 'doc', role: 'button', name: 'Document', file: true },
      { id: 'send', role: 'button', name: 'Send' },
    ],
  },
  '/popup': {
    path: '/popup',
    title: 'Popup',
    text: 'Opens a window.',
    elements: [
      { id: 'open', role: 'button', name: 'Open window', popup: '/done' },
    ],
  },
  '/slow': {
    path: '/slow',
    title: 'Slow',
    text: 'Loading…',
    elements: [],
    delayedElements: {
      afterMs: 120,
      elements: [{ id: 'ready', role: 'button', name: 'Ready' }],
    },
  },
  '/checkout': {
    path: '/checkout',
    title: 'Checkout',
    text: 'Review your order.',
    elements: [
      { id: 'pay', role: 'button', name: 'Pay now', href: '/done' },
      { id: 'delete', role: 'button', name: '删除账户' },
    ],
  },
}

export const FIXTURE_ORIGIN = 'https://fixture.test'
export const OTHER_ORIGIN = 'https://other.test'
