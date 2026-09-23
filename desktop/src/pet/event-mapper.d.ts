/**
 * Types for event-mapper.js, the pet window's plain UMD script, so TypeScript
 * callers (Settings › 桌宠 tests) can check against it. Not packaged: the pet
 * runtime ships through the explicit file filter in electron-builder.yml.
 */
export interface PetStrip {
  file: string
  frames: number
  fps: number
  alternate: boolean
}

export declare const SPRITE_FRAME: { width: number; height: number }
export declare const SPRITES: Record<string, PetStrip>
/** Runtime animation key → key of SPRITES. */
export declare const ASSETS: Record<string, string>
export declare function spriteFor(animation: string): PetStrip
export declare function mapPetEvent(
  event: unknown,
): Record<string, unknown> | null
