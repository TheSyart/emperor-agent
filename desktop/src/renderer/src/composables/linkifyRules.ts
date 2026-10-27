/**
 * Which bare names markdown-it's linkify turns into links (GRP-14).
 *
 * linkify-it links a name without a scheme when it ends in a known top-level
 * domain, and its list holds every two-letter country code. So file names
 * came out as web links: 「多agent对话失败模式.md」 as http://xn--…md (an
 * internationalised domain), notes.md, main.py, lib.rs, run.sh too.
 *
 * A name without a scheme now links only when it can only be a web address:
 * - it starts with `www.` — always;
 * - else its host is plain ASCII and does not end in a common file
 *   extension that is also a country code (`.md`, `.py`, `.rs`, …).
 * So `example.com` and `example.com/docs` still link, as before; anything
 * with a scheme (`https://…`, `mailto:`) and e-mail addresses are untouched.
 */
import type MarkdownIt from 'markdown-it'

/** File extensions that are also two-letter top-level domains. */
const FILE_EXTENSIONS = new Set([
  'md',
  'py',
  'rs',
  'sh',
  'pl',
  'pm',
  'ts',
  'tf',
  'mk',
  'cc',
  'mm',
  'am',
  'ac',
  'ps',
])

interface FuzzyMatch {
  schema: string
  raw: string
}

/** True for a link to keep: a scheme, www., or a plain ASCII web host. */
export function keepAutoLink(match: FuzzyMatch): boolean {
  // `mailto:` (e-mail addresses) and every link written with its scheme.
  if (match.schema) return true
  if (/^www\./i.test(match.raw)) return true
  const host = match.raw.split(/[/?#:]/, 1)[0] ?? ''
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]+$/.test(host)) return false
  const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase()
  return !FILE_EXTENSIONS.has(tld)
}

/** Apply the rule to a markdown-it instance's linkify (once per instance). */
export function restrictAutoLinks(md: MarkdownIt): void {
  const linkify = md.linkify
  const match = linkify.match.bind(linkify)
  linkify.match = (text: string) => {
    const found = match(text)
    return found ? found.filter(keepAutoLink) : found
  }
}
