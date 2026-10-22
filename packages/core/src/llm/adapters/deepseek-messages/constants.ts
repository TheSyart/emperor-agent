/**
 * Every protocol constant of the DeepSeek Messages route in one place, so a
 * beta header or path change is one edit (KRN-07, plan risk R8).
 *
 * Sources (checked 2026-10-20):
 * - https://api-docs.deepseek.com/guides/anthropic_api — base URL
 *   `https://api.deepseek.com/anthropic`; `x-api-key`; `anthropic-version`
 *   ignored; `anthropic-beta` ignored on /messages except that an image
 *   source of type `file` needs `files-api-2025-04-14`; `thinking`
 *   supported (budget_tokens ignored); `output_config` supports only
 *   `effort`; `redacted_thinking` and `document` blocks not supported.
 * - https://api-docs.deepseek.com/guides/thinking_mode — Anthropic format:
 *   `thinking: {type: enabled|disabled}` and
 *   `output_config: {effort: low|high|max}`; requested medium maps to high.
 * - https://api-docs.deepseek.com/guides/files_api — `POST /files`
 *   (multipart: file, purpose=user_data, expires_after[anchor]=created_at,
 *   expires_after[seconds] 3600–2592000), `GET /files?order=asc`,
 *   `DELETE /files/{id}`; files are shared by both API families; 64 MiB per
 *   file, 10000 files and 25 GiB per account.
 * - https://api-docs.deepseek.com/guides/vision — the Anthropic image source
 *   types `base64` / `url` / `file`; ~1300×1300 pixels after the server's
 *   resize, at most 1024 tokens per image; images only in user messages.
 */

/** The only host whose DeepSeek entries default to Messages. */
export const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com'
/** Origin of the official API (OpenAI-compatible endpoints and the Files API). */
export const DEEPSEEK_ORIGIN = 'https://api.deepseek.com'
/** Path of the Anthropic-compatible base under the origin. */
export const ANTHROPIC_BASE_PATH = '/anthropic'
/** Messages endpoint under the Anthropic-compatible base (as the Anthropic SDK appends it). */
export const MESSAGES_PATH = '/v1/messages'
/** Files API under the origin (OpenAI-compatible shape: purpose, expiry, ordered listing). */
export const FILES_PATH = '/files'

/** Sent for conformity; DeepSeek ignores it. */
export const ANTHROPIC_VERSION = '2023-06-01'
/** The one beta DeepSeek reads on /messages: image sources of type `file`. */
export const FILES_API_BETA = 'files-api-2025-04-14'

/** Uploaded images expire on DeepSeek's side after a day. */
export const FILE_EXPIRY_SECONDS = 86_400
/** A cached file id is reused only while it has at least this long to live. */
export const FILE_REFRESH_MARGIN_MS = 3_600_000
/** After an upload failure, images go inline for this long before trying again. */
export const FILES_BACKOFF_MS = 10 * 60_000
/** Every file Emperor uploads is named with this prefix; cleanup deletes only these. */
export const EMPEROR_FILE_PREFIX = 'emperor-'
/** How many of Emperor's oldest uploads one full-account cleanup deletes. */
export const QUOTA_EVICTION_COUNT = 50
/** Listing page size and page limit for that cleanup. */
export const FILES_LIST_LIMIT = 100
export const FILES_LIST_MAX_PAGES = 20
/** Largest file the Files API accepts. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** JPEG qualities tried, in order, for an image that needs re-encoding. */
export const JPEG_QUALITIES = [85, 75, 60] as const
/** The server resizes to about this many pixels; larger images are scaled down before upload. */
export const REQUEST_IMAGE_MAX_PIXELS = 1300 * 1300
/** An upload above this size is re-encoded (the first JPEG quality under it wins). */
export const UPLOAD_IMAGE_TARGET_BYTES = 5 * 1024 * 1024
/** Bumped whenever the upload variant rules change, so old cache keys stop matching. */
export const UPLOAD_VARIANT_VERSION = 'v1'
