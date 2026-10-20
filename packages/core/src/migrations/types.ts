/** One step `migrations/<from>-<to>.ts` (REL-03). */
export interface DataMigration {
  /** `<from>-<to>`, the file name. */
  readonly id: string
  readonly from: number
  readonly to: number
  /** Files (relative to the home) the step may change or create. */
  files(home: string): string[]
  run(home: string): void
}
