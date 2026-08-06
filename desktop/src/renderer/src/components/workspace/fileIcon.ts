import {
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideoCamera,
  Folder,
} from 'lucide-vue-next'
import type { Component } from 'vue'

export type FileIconTone =
  | 'accent'
  | 'brand'
  | 'warn'
  | 'ok'
  | 'cyan'
  | 'violet'
  | 'blue'
  | 'muted'
  | 'subtle'

export interface FileIconSpec {
  icon: Component
  tone: FileIconTone
}

const DIRECTORY: FileIconSpec = { icon: Folder, tone: 'subtle' }
const FALLBACK: FileIconSpec = { icon: File, tone: 'subtle' }

const EXT_ICONS: Record<string, FileIconSpec> = {
  html: { icon: FileCode, tone: 'brand' },
  htm: { icon: FileCode, tone: 'brand' },
  vue: { icon: FileCode, tone: 'ok' },
  css: { icon: FileCode, tone: 'accent' },
  scss: { icon: FileCode, tone: 'accent' },
  less: { icon: FileCode, tone: 'accent' },
  js: { icon: FileCode, tone: 'warn' },
  mjs: { icon: FileCode, tone: 'warn' },
  cjs: { icon: FileCode, tone: 'warn' },
  jsx: { icon: FileCode, tone: 'warn' },
  ts: { icon: FileCode, tone: 'blue' },
  mts: { icon: FileCode, tone: 'blue' },
  cts: { icon: FileCode, tone: 'blue' },
  tsx: { icon: FileCode, tone: 'blue' },
  json: { icon: FileJson, tone: 'warn' },
  jsonc: { icon: FileJson, tone: 'warn' },
  md: { icon: FileText, tone: 'muted' },
  markdown: { icon: FileText, tone: 'muted' },
  txt: { icon: FileText, tone: 'subtle' },
  sh: { icon: FileTerminal, tone: 'ok' },
  bash: { icon: FileTerminal, tone: 'ok' },
  zsh: { icon: FileTerminal, tone: 'ok' },
  yml: { icon: FileCog, tone: 'muted' },
  yaml: { icon: FileCog, tone: 'muted' },
  toml: { icon: FileCog, tone: 'muted' },
  ini: { icon: FileCog, tone: 'muted' },
  env: { icon: FileCog, tone: 'muted' },
  svg: { icon: FileImage, tone: 'violet' },
  png: { icon: FileImage, tone: 'violet' },
  jpg: { icon: FileImage, tone: 'violet' },
  jpeg: { icon: FileImage, tone: 'violet' },
  gif: { icon: FileImage, tone: 'violet' },
  webp: { icon: FileImage, tone: 'violet' },
  ico: { icon: FileImage, tone: 'violet' },
  mp3: { icon: FileMusic, tone: 'violet' },
  wav: { icon: FileMusic, tone: 'violet' },
  ogg: { icon: FileMusic, tone: 'violet' },
  mp4: { icon: FileVideoCamera, tone: 'violet' },
  mov: { icon: FileVideoCamera, tone: 'violet' },
  webm: { icon: FileVideoCamera, tone: 'violet' },
  csv: { icon: FileSpreadsheet, tone: 'ok' },
  tsv: { icon: FileSpreadsheet, tone: 'ok' },
  zip: { icon: FileArchive, tone: 'subtle' },
  tar: { icon: FileArchive, tone: 'subtle' },
  gz: { icon: FileArchive, tone: 'subtle' },
  lock: { icon: FileLock, tone: 'muted' },
  py: { icon: FileCode, tone: 'subtle' },
  rb: { icon: FileCode, tone: 'subtle' },
  go: { icon: FileCode, tone: 'subtle' },
  rs: { icon: FileCode, tone: 'subtle' },
  java: { icon: FileCode, tone: 'subtle' },
  sql: { icon: FileCode, tone: 'subtle' },
}

export function fileIconFor(name: string, isDirectory: boolean): FileIconSpec {
  if (isDirectory) return DIRECTORY
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return FALLBACK
  return EXT_ICONS[name.slice(dot + 1).toLowerCase()] ?? FALLBACK
}
