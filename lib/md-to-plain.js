/**
 * Markdown to QQ-friendly plain text.
 *
 * QQ renders no markdown in `msg_type: 0`, so raw markdown reaches the reader
 * as literal punctuation. This module keeps the *structure* a reader needs
 * (headings, list bullets, code, links) while dropping the syntax that would
 * otherwise show up as noise.
 *
 * It is deliberately line-oriented and non-recursive: agent output is mostly
 * headings, lists, fenced code, and links, and a full parser would buy nothing
 * but failure modes.
 *
 * @module dsh-qq/md-to-plain
 */

/**
 * Read a GitHub-flavoured table starting at one line.
 *
 * A table is a row of cells whose NEXT line is a delimiter row; requiring that
 * delimiter is what keeps a sentence containing a pipe from being read as one.
 *
 * @param lines - every line of the document.
 * @param start - the index of the candidate header row.
 * @returns `{ header, rows, end }` where `end` is the last consumed index, or
 *   null when no table starts here.
 */
function readTable(lines, start) {
  const header = splitRow(lines[start])
  if (header === null) return null
  const delimiter = splitRow(lines[start + 1] ?? '')
  if (delimiter === null || !delimiter.every((cell) => /^:?-{1,}:?$/.test(cell.trim()))) return null
  const rows = []
  let end = start + 1
  for (let index = start + 2; index < lines.length; index += 1) {
    const cells = splitRow(lines[index])
    if (cells === null) break
    rows.push(cells)
    end = index
  }
  if (rows.length === 0) return null
  return { header, rows, end }
}

/**
 * Split one table row into trimmed cells, or null when it is not a row.
 *
 * @param line - the line.
 * @returns The cells, or null.
 */
function splitRow(line) {
  const text = String(line ?? '').trim()
  if (!text.startsWith('|') || !text.endsWith('|') || text.length < 2) return null
  return text.slice(1, -1).split('|').map((cell) => stripInline(cell.trim()))
}

/**
 * Render a table as lines a phone can read.
 *
 * Two columns become `label: value` pairs, which is how a table is usually
 * written anyway; wider tables keep their cells in order under the header.
 *
 * @param table - the value from {@link readTable}.
 * @returns One line per body row.
 */
function renderTable(table) {
  const twoColumn = table.header.length === 2
  return table.rows.map((cells) => {
    if (twoColumn) return `· ${table.header[0]}：${cells[0] ?? ''} · ${table.header[1]}：${cells[1] ?? ''}`
    return `· ${cells.join(' · ')}`
  })
}

/** Characters QQ treats as structural, collapsed when a line is full of them. */
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/

/**
 * Convert markdown into readable plain text.
 *
 * @param markdown - the source text.
 * @param options - conversion switches.
 * @param options.keepCodeFence - keep the fence markers, for contexts that want
 *   to show that a block was code. Defaults to false.
 * @returns The plain-text rendering.
 */
export function markdownToPlain(markdown, options = {}) {
  if (typeof markdown !== 'string' || markdown === '') return ''
  const keepFence = options.keepCodeFence === true
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let inFence = false
  let fenceMarker = ''

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = /^\s*(```+|~~~+)\s*(\S*)\s*$/.exec(line)
    if (fence !== null) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
        if (keepFence) out.push(fence[2] === '' ? '```' : `\`\`\`${fence[2]}`)
      } else {
        inFence = false
        fenceMarker = ''
        if (keepFence) out.push('```')
      }
      continue
    }

    // Inside a fence the text is literal: never touch its punctuation.
    if (inFence) {
      out.push(line)
      continue
    }

    if (RULE.test(line)) {
      out.push('———')
      continue
    }

    // A table is the one construct QQ's markdown does not render, so it is
    // rewritten here as label/value lines. Without this the plain-text path
    // left the pipes exactly as they were, which is how every table this bridge
    // forwarded arrived as a row of vertical bars.
    const table = readTable(lines, index)
    if (table !== null) {
      for (const rendered of renderTable(table)) out.push(rendered)
      index = table.end
      continue
    }

    let text = line

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text)
    if (heading !== null) {
      out.push(`【${stripInline(heading[2])}】`)
      continue
    }

    const quote = /^\s{0,3}>\s?(.*)$/.exec(text)
    if (quote !== null) {
      out.push(`｜${stripInline(quote[1])}`)
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text)
    if (bullet !== null) {
      out.push(`${bullet[1]}· ${stripInline(bullet[2])}`)
      continue
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(text)
    if (ordered !== null) {
      out.push(`${ordered[1]}${ordered[2]}. ${stripInline(ordered[3])}`)
      continue
    }

    out.push(stripInline(text))
  }

  void fenceMarker
  return collapseBlankLines(out).join('\n').trim()
}

/**
 * Remove inline markdown syntax while keeping the text it wrapped.
 *
 * @param text - one line of markdown.
 * @returns The same line without inline markers.
 */
export function stripInline(text) {
  let out = text
  // Images before links: `![alt](url)` must not be eaten by the link rule.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => (alt === '' ? url : `${alt} ${url}`))
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => (label === '' || label === url ? url : `${label}（${url}）`))
  out = out.replace(/`([^`]+)`/g, '$1')
  out = out.replace(/(\*\*|__)(.+?)\1/g, '$2')
  out = out.replace(/(?<![*\w])(\*|_)(?!\s)(.+?)(?<!\s)\1(?![*\w])/g, '$2')
  out = out.replace(/~~(.+?)~~/g, '$1')
  // Autolinks and bare `<url>` forms.
  out = out.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
  return out
}

/**
 * Collapse runs of blank lines so the result stays inside QQ's message budget.
 *
 * @param lines - output lines.
 * @returns Lines with at most one consecutive blank.
 */
function collapseBlankLines(lines) {
  const out = []
  let blank = false
  for (const line of lines) {
    const isBlank = line.trim() === ''
    if (isBlank && blank) continue
    blank = isBlank
    out.push(line)
  }
  return out
}

/**
 * Split text into chunks that fit a byte budget, preferring line boundaries.
 *
 * QQ rejects over-long messages, so a long agent answer must become several
 * sends. Splitting on newlines keeps code and lists readable; a single line
 * longer than the budget is split by character count as a fallback.
 *
 * @param text - the text to split.
 * @param maxBytes - inclusive byte budget per chunk (UTF-8).
 * @returns One or more non-empty chunks, in order.
 */
export function splitByBytes(text, maxBytes) {
  const budget = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 4_000
  const source = typeof text === 'string' ? text : ''
  if (source === '') return []
  if (Buffer.byteLength(source, 'utf8') <= budget) return [source]

  const chunks = []
  let current = ''
  let currentBytes = 0

  const flush = () => {
    if (current !== '') chunks.push(current)
    current = ''
    currentBytes = 0
  }

  for (const line of source.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    if (currentBytes + lineBytes > budget && current !== '') flush()

    if (lineBytes > budget) {
      // A single oversized line (a minified blob, a long URL): cut by characters.
      let piece = ''
      let pieceBytes = 0
      for (const char of line) {
        const charBytes = Buffer.byteLength(char, 'utf8')
        if (pieceBytes + charBytes > budget && piece !== '') {
          chunks.push(piece)
          piece = ''
          pieceBytes = 0
        }
        piece += char
        pieceBytes += charBytes
      }
      current = piece
      currentBytes = pieceBytes
      continue
    }

    current = current === '' ? line : `${current}\n${line}`
    currentBytes += lineBytes
  }
  flush()
  return chunks
}
