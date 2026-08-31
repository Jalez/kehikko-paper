/**
 * When another module points at a byte range, what does this one actually mark?
 *
 * ## The complaint, and why it needed measuring in two places
 *
 * "The notes module is too unable to highlight the exact part of the text the
 * note is based on." That sentence names one symptom and two possible causes in
 * two repositories: either the notes container publishes an imprecise range, or the
 * range is right and this module draws something else. Neither can be settled
 * by reading code, because the answer is a comparison between a byte range in a
 * `.tex` file and the words that end up wearing `.passage-mark` on screen.
 *
 * The other half is `dev/what-is-pointed-at.ts` in the notes module, which
 * slices the file with the offsets a press would publish and compares them
 * against the note's own words. On the thesis this was run against it printed
 * `62 notes, 62 with a range published, 0 whose bytes are not the note's
 * words` — so the numbers arriving here are exact, and everything below is
 * about what this module does with an exact range.
 *
 * ## What it does
 *
 * Frames this module inside a nine-line host on this module's own origin — see
 * the long note in `measure-selection.mjs` about `frame-ancestors`, which is
 * the reason a probe cannot just serve a page of its own — opens the thesis,
 * and points at every note in that project's notes store in turn. For each one
 * it prints the words the note is about and the words that came out marked.
 *
 * ## The numbers it was written against
 *
 * Sixty-one notes, of which three are about `main_snippet.tex` — a file this
 * paper does not include, which `pointedAt` answers with a sentence and no mark,
 * correctly.
 *
 *                                  before   after
 *   marked in the words              7        7
 *   marked in the margin of a block  28       51
 *   not marked at all                26       3
 *
 * The first column is `reader/pointed.ts` falling back to the last block of the
 * file for any range it draws none of, and `reader/blocks.tsx` then refusing to
 * mark that block because it does not overlap. Twenty-three in-paper notes
 * walked the reader somewhere and showed them nothing. The three left in the
 * second column are the `main_snippet.tex` ones, which is the right answer.
 *
 * The middle row is not a consolation prize: `index.css` has an essay saying
 * the margin rule IS the answer for a passage whose source this module folds
 * away, and it is where the comment runs and the lifted `\todo{}`s belong.
 *
 *
 *   bun dev/measure-marked.mjs        (paper on 7870; ./run.sh if it is down)
 */
import { readFileSync } from 'node:fs'

import { chromium } from '/Users/jaakkorajala/.claude/jobs/85f6bc23/tmp/node_modules/playwright/index.mjs'

const ORIGIN = process.env.PAPER_ORIGIN ?? 'http://127.0.0.1:7870'
const HOST_PAGE = `${ORIGIN}/app?probe=host`
const PAPER = `${ORIGIN}/app?probe=frame`
const PROJECT = process.env.PROJECT ?? '/Users/jaakkorajala/Claude/Projects/CS-DEGREE/05_drafts/thesis_latex'
const EPIC = process.env.EPIC ?? 'thesis'
const LIMIT = Number(process.env.LIMIT ?? '0')

const store = JSON.parse(readFileSync(`${PROJECT}/.kehikot/notes/notes.json`, 'utf8'))
/* Only the notes about files this paper holds, and only ranged ones — a note on
   `main.log` is a note about a build log and this module has never claimed to
   draw it. */
const notes = store.notes
  .filter((n) => n.path.endsWith('.tex') && n.from !== null && n.to !== null)
  .slice(0, LIMIT || undefined)

/** The words a note is about, as this module would render them: whitespace flattened. */
const flat = (s) => s.replace(/\s+/g, ' ').trim()

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ??
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
})
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } })
const page = await ctx.newPage()

await page.goto(HOST_PAGE, { waitUntil: 'load' })
await page.evaluate(
  async ({ paper, project, epic }) => {
    const frame = document.createElement('iframe')
    frame.src = paper
    frame.style.cssText = 'position:fixed;inset:0;z-index:9;width:900px;height:820px;border:0;background:#fff'
    document.body.appendChild(frame)

    const context = {
      epic,
      project: 'probe',
      projectPath: project,
      theme: 'light',
      selection: [],
      passage: null,
      pinned: false,
      prompt: null,
      kehikko: null,
    }
    const send = (message) => frame.contentWindow?.postMessage(message, '*')
    window.__point = (passage) => {
      context.passage = passage
      send({ ...context, type: 'roadmap.context', protocol: 1 })
    }
    window.addEventListener('message', (ev) => {
      const m = ev.data
      if (!m || typeof m.type !== 'string' || m.type !== 'roadmap.request') return
      send({ type: 'roadmap.response', id: m.id, ok: true, data: {} })
    })
    for (const wait of [400, 500, 500]) {
      await new Promise((r) => setTimeout(r, wait))
      send({ type: 'roadmap.hello', protocol: 1, session: 'probe-session', context, state: null })
    }
  },
  { paper: PAPER, project: PROJECT, epic: EPIC },
)

await page.waitForTimeout(4000)

const paper = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(PAPER))
if (!paper) {
  console.log('no paper frame — is the module up on 7870?')
  await browser.close()
  process.exit(1)
}

const loaded = await paper.evaluate(() => ({
  pages: document.querySelectorAll('[data-page]').length,
  title: document.body.innerText.slice(0, 60).replace(/\n/g, ' '),
}))
console.log('loaded          ', JSON.stringify(loaded))
if (!loaded.pages) {
  console.log('nothing drawn — this probe has measured nothing. Is the epic right?')
  await browser.close()
  process.exit(1)
}

/**
 * Three outcomes, and the third is the bug.
 *
 * `spans` — some rendered words wear `.passage-mark`. Only possible where the
 * range names source this module draws, which for a note lifted out of a
 * `\todo{}` or a comment run it never does.
 *
 * `block` — no span, but the block the pointing resolved to carries its rule in
 * the margin. This is the RIGHT answer for a passage whose source is folded
 * away, and `index.css` has an essay saying so.
 *
 * `nothing` — the reader was walked somewhere and shown no mark of any kind.
 * That is what this probe was written to count, and before the two changes in
 * `reader/pointed.ts` and `reader/blocks.tsx` it counted 23 of 58.
 */
const outcome = { spans: 0, block: 0, nothing: 0 }
const off = []

for (const note of notes) {
  await page.evaluate(
    (passage) => window.__point(passage),
    { path: note.path, page: null, from: note.from, to: note.to, quoted: note.quoted.slice(0, 2000) },
  )
  await page.waitForTimeout(400)

  const drawn = await paper.evaluate(() => {
    const marked = [...document.querySelectorAll('.passage-mark')].map((el) => el.innerText)
    const blocks = [...document.querySelectorAll('[data-marked="1"]')].map((el) => ({
      kind: el.getAttribute('data-kind'),
      text: (el.innerText ?? '').slice(0, 200),
    }))
    return { marked, blocks }
  })

  const want = flat(note.quoted)
  const got = flat(drawn.marked.join(' '))
  const where = got ? 'spans' : drawn.blocks.length ? 'block' : 'nothing'
  outcome[where]++
  if (where === 'nothing') off.push({ note, want, got, blocks: drawn.blocks })
  else if (process.env.VERBOSE) {
    console.log(`${where.padEnd(7)} ${note.source?.kind.padEnd(7)} ${note.path.split('/').pop()}`)
    console.log(`  about: ${want.slice(0, 100)}`)
    console.log(`  drawn: ${(got || flat(drawn.blocks[0]?.text ?? '')).slice(0, 100)}`)
  }
}

console.log(
  `\n${notes.length} notes pointed at: ${outcome.spans} marked in the words, `
  + `${outcome.block} marked in the margin of the block, ${outcome.nothing} not marked at all.`,
)
for (const one of off) {
  console.log(`--- ${one.note.path.split('/').pop()} ${one.note.source?.kind} bytes ${one.note.from}–${one.note.to}`)
  console.log(`  the note is about: ${one.want.slice(0, 120)}`)
  console.log(`  nothing was marked; nearest block: ${(one.blocks[0]?.text ?? '(no block)').replace(/\n/g, ' ').slice(0, 100)}`)
}

await browser.close()
