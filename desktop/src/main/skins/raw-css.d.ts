/** Vite's `?raw` import: a file's text (theme-sources.ts). */
declare module '*.css?raw' {
  const text: string
  export default text
}
