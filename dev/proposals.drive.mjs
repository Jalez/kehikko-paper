/*
 * Three things about the floating Accept/Reject card that only a real browser
 * can measure, against the running module.
 *
 *     CHROME=<path to chromium> PROJECT=<scratch project> \
 *       node dev/proposals.drive.mjs [page url] [width] [height]
 *
 * ## Why a driver and not a test
 *
 * Every one of these is a property of the RENDERED page, and the DOM harness
 * cannot produce any of them:
 *
 *  1. **Where the reader is after pressing Accept.** `scrollTop` on the column
 *     is a number the browser keeps, and happy-dom keeps it too — but nothing
 *     there clamps it when the children are replaced, which is the mechanism
 *     under suspicion. Only a layout engine can lose a scroll position.
 *  2. **Whether the card holds still while the words scroll.** The card is
 *     positioned by Floating UI from the anchor's `getBoundingClientRect`,
 *     re-run on the column's scroll event. Whether it lands in the same frame
 *     as the words, or one behind, is a question about frames, and whether it
 *     flips from above the words to below them as they near the top edge is a
 *     question about collision geometry. Neither exists without layout.
 *  3. **Whether two cards near each other cover one another.** Two boxes that
 *     overlap take up no more room than one, so no measure of size can see it;
 *     it needs two rectangles and `elementFromPoint` over a button's centre.
 *
 * ## What it needs
 *
 * A project folder holding `.kehikot/paper/<epic>/main.tex` whose prose contains
 * the three FIND strings below, and this module running against a SCRATCH
 * `ROADMAP_MODULES_DIR`, because the dev server rewrites the registration for
 * whatever port it binds. Pressing Accept WRITES the file and commits, so the
 * driver puts the file back from `main.tex.orig` beside the project and clears
 * `proposals.json` before it starts, and files its own suggestions through the
 * MCP door the way an agent would.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT ?? '/tmp/height-drive/node_modules/playwright-core/index.mjs')

const PROJECT = process.env.PROJECT ?? '/tmp/paper-drive/project'
const EPIC = process.env.EPIC ?? 'scratch'
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:7991'
const PAGE = process.argv[2] || `${ORIGIN}/app?epic=${encodeURIComponent(EPIC)}&project=${encodeURIComponent(PROJECT)}`
const WIDTH = Number(process.argv[3] ?? 460)
const HEIGHT = Number(process.argv[4] ?? 360)

/* Two on consecutive lines of the paper, and one far away from them. */
const SUGGESTED = [
  { find: 'Marker 5-2 ends here', replace: 'Marker 5-2 closes here', why: 'Closes reads better than ends.' },
  { find: 'Paragraph 5-3 begins here', replace: 'Paragraph 5-3 opens here', why: 'Opens reads better than begins.' },
  { find: 'Marker 2-4 ends here', replace: 'Marker 2-4 stops here', why: 'A third one, far away, to accept.' },
]

/* ---- Put the paper back and file the suggestions ------------------------ */

const paperDir = join(PROJECT, '.kehikot', 'paper', EPIC)
const orig = join(PROJECT, '..', 'main.tex.orig')
if (existsSync(orig)) copyFileSync(orig, join(paperDir, 'main.tex'))

/* Whatever is still waiting from the last run is rejected through the same
   door the page uses, with the ticket the page is printed with — suggestions
   live in the server's memory, so there is no file to clear. */
const ticket = JSON.parse(
  (await (await fetch(`${ORIGIN}/app`)).text()).match(/id="roadmap-paper-ticket"[^>]*>([^<]*)</)[1],
)
const where = `epic=${encodeURIComponent(EPIC)}&project=${encodeURIComponent(PROJECT)}`
const waiting = await (await fetch(`${ORIGIN}/api/proposals?${where}`)).json()
for (const p of waiting.proposals ?? []) {
  await fetch(`${ORIGIN}/api/proposal?${where}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: p.id, decision: 'reject', ticket }),
  })
}

let nextId = 1
async function rpc(method, params) {
  const res = await fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  return res.json()
}
for (const s of SUGGESTED) {
  const answer = await rpc('tools/call', { name: 'propose_edit', arguments: { project: PROJECT, epic: EPIC, ...s } })
  const text = answer.result?.content?.[0]?.text ?? JSON.stringify(answer)
  if (!text.startsWith('Filed as')) {
    console.log('could not file a suggestion:', text)
    process.exit(2)
  }
}

/* ---- Open the page --------------------------------------------------------- */

const browser = await chromium.launch({ executablePath: process.env.CHROME })
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
const problems = []
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-page="1"] .sheet', { timeout: 15000 })
await page.waitForSelector('[data-proposal]', { state: 'attached', timeout: 15000 })
await page.waitForTimeout(400)

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/** The geometry of every card and the span it points at, from inside the page. */
const survey = () =>
  page.evaluate(() => {
    const col = document.querySelector('.reading-column')
    const c = col.getBoundingClientRect()
    const cards = Array.from(document.querySelectorAll('[data-proposal]')).map((card) => {
      const id = card.getAttribute('data-proposal')
      const r = card.getBoundingClientRect()
      const accept = card.querySelector('button')
      const a = accept.getBoundingClientRect()
      const hit = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2)
      /* Not drawn: the popover's `visibility: hidden` when its words had left
         the column, or — for a card that scrolls with the words — simply out of
         the column's box. Either way nothing is on screen to be covered. */
      const visible =
        getComputedStyle(card).visibility !== 'hidden' &&
        r.width > 0 &&
        r.bottom > c.top &&
        r.top < c.bottom
      return {
        id,
        why: card.querySelector('.proposal-why')?.textContent ?? '',
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        hidden: !visible,
        acceptCovered: !(hit && accept.contains(hit)),
        coveredBy: hit ? (hit.closest('[data-proposal]')?.getAttribute('data-proposal') ?? hit.tagName) : 'nothing',
      }
    })
    const anchors = Array.from(document.querySelectorAll('[data-proposed-change]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { text: el.textContent, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
    })
    return { column: { top: c.top, bottom: c.bottom, scrollTop: col.scrollTop, scrollHeight: col.scrollHeight }, cards, anchors }
  })

const overlap = (a, b) => {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? Math.round(w * h) : 0
}

/* ---- 3. Two cards next to each other ---------------------------------------- */

console.log(`\n${WIDTH}×${HEIGHT}  ${PAGE}`)
console.log('\n## Two changes on consecutive lines')

/* Bring the pair into view: the anchor for the first suggestion. */
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('[data-has-proposals]')).find((n) => n.textContent.includes('Marker 5-2')).querySelector('[data-proposed-change]')
  el.scrollIntoView({ block: 'center' })
})
await page.waitForTimeout(300)
let s = await survey()
const near = s.cards.filter((c) => !c.hidden)
console.log(`  cards drawn: ${near.length}; anchors on this paper: ${s.anchors.length}`)
for (const c of near) console.log(`  ${c.id}  top=${c.rect.top.toFixed(1)} bottom=${c.rect.bottom.toFixed(1)}  "${c.why}"  accept covered: ${c.acceptCovered} (${c.coveredBy})`)
let worst = 0
for (let i = 0; i < near.length; i++)
  for (let j = i + 1; j < near.length; j++) worst = Math.max(worst, overlap(near[i].rect, near[j].rect))
check('two cards near each other do not overlap', worst === 0, `${worst}px² of overlap`)
check('every drawn Accept button is reachable', near.every((c) => !c.acceptCovered), near.filter((c) => c.acceptCovered).map((c) => `${c.id} under ${c.coveredBy}`).join(', ') || 'all reachable')

/* ---- 2. The card while scrolling --------------------------------------------- */

console.log('\n## The card while the column scrolls')

/* Park the first anchor low in the column so there is room to scroll it upward
   through the whole column before it leaves. */
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('[data-has-proposals]')).find((n) => n.textContent.includes('Marker 5-2')).querySelector('[data-proposed-change]')
  el.scrollIntoView({ block: 'end' })
})
await page.waitForTimeout(300)

const trace = await page.evaluate(async (step) => {
  const col = document.querySelector('.reading-column')
  const anchor = Array.from(document.querySelectorAll('[data-has-proposals]')).find((n) => n.textContent.includes('Marker 5-2')).querySelector('[data-proposed-change]')
  const card = () => {
    const why = 'Closes reads better than ends.'
    return Array.from(document.querySelectorAll('[data-proposal]')).find((c) => c.querySelector('.proposal-why')?.textContent === why)
  }
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
  const measure = () => {
    const a = anchor.getBoundingClientRect()
    const c = card()
    const r = c ? c.getBoundingClientRect() : null
    const wrapper = c ? c.parentElement : null
    return {
      scrollTop: col.scrollTop,
      anchorTop: a.top,
      cardTop: r ? r.top : null,
      cardBottom: r ? r.bottom : null,
      side: c ? c.getAttribute('data-side') : null,
      hidden: !c || getComputedStyle(c).visibility === 'hidden' || getComputedStyle(wrapper).visibility === 'hidden',
      arrowLeft: c ? (c.querySelector('[data-slot="popover-arrow"]')?.getBoundingClientRect().left ?? null) : null,
    }
  }
  const out = []
  const colTop = col.getBoundingClientRect().top
  const height = col.clientHeight
  for (let i = 0; i < 60; i++) {
    col.scrollTop += step
    /* The browser dispatches the scroll event at the next rendering step, so a
       reading taken NOW is before any positioning code has run; the reading
       after one frame is what a reader sees painted. Both are kept: the first
       says how far the card is from where it will end up, i.e. how far behind
       the words it is drawn for one frame. */
    const now = measure()
    await frame()
    await frame()
    const after = measure()
    out.push({ ...after, beforeCardTop: now.cardTop, anchorInColumn: after.anchorTop - colTop, height })
    if (after.anchorTop < colTop - 40) break
  }
  return out
}, 6)

/* The card belongs a fixed distance from the words it points at. Where it is
   drawn on the near side and neither has left the column, that distance must
   not change from one frame to the next — a card that keeps its distance is a
   card that holds still relative to the text. */
const visible = trace.filter((t) => !t.hidden && t.cardTop !== null)
const offsets = visible.map((t) => +(t.cardTop - t.anchorTop).toFixed(1))
const sides = new Set(visible.map((t) => t.side))
const distinct = [...new Set(offsets)]
console.log(`  frames measured: ${trace.length}, card visible in ${visible.length}, sides seen: ${[...sides].join(', ')}`)
console.log(`  card top − anchor top, per frame: ${offsets.join(' ')}`)
const lag = visible.filter((t) => t.beforeCardTop !== null && Math.abs(t.beforeCardTop - t.cardTop) > 0.5).length
console.log(`  frames where the card was drawn somewhere else before the next paint: ${lag}`)
check('the card keeps one distance from its words while they scroll', distinct.length <= 1, `${distinct.length} distinct offsets: ${distinct.join(', ')}`)
check('the card stays on one side of its words', sides.size <= 1, `sides: ${[...sides].join(', ')}`)
const leftEarly = trace.findIndex((t) => t.hidden)
const stillIn = leftEarly >= 0 ? trace[leftEarly].anchorInColumn : null
check('the card is shown as long as its words are in the column', stillIn === null || stillIn < 0, stillIn === null ? 'never hidden' : `hidden with the words ${stillIn.toFixed(1)}px below the top edge`)

/* ---- 1. Accepting keeps the reader's place ---------------------------------- */

console.log('\n## Accepting a change')

await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('[data-has-proposals]')).find((n) => n.textContent.includes('Marker 2-4')).querySelector('[data-proposed-change]')
  el.scrollIntoView({ block: 'center' })
})
await page.waitForTimeout(300)
const before = await survey()
const far = before.cards.find((c) => c.why.startsWith('A third'))
const pending = before.cards.length
console.log(`  scrollTop before: ${before.column.scrollTop}; cards: ${pending}`)
const accept = page.locator(`[data-proposal="${far.id}"] button`, { hasText: 'Accept' })
await accept.click()
await page.waitForFunction((n) => document.querySelectorAll('[data-proposal]').length < n, pending, { timeout: 10000 })
await page.waitForTimeout(400)
const after = await survey()
console.log(`  scrollTop after:  ${after.column.scrollTop}; cards: ${after.cards.length}; scrollHeight ${before.column.scrollHeight} → ${after.column.scrollHeight}`)
check('accepting keeps the reader where they were', Math.abs(after.column.scrollTop - before.column.scrollTop) < 2, `moved by ${(after.column.scrollTop - before.column.scrollTop).toFixed(1)}px`)

/* ---- 1b. Accepting while the canvas is pointing at a passage ------------- */

console.log('\n## Accepting a change while the canvas points at a passage')

/*
 * The reported jump only happens FRAMED: a host's context can carry a passage
 * — the note somebody clicked in another container — and the page walks to it.
 * The walk used to be re-done every time the paper object was replaced, which
 * a write does, so every Accept scrolled the reader back to the passage. An
 * unframed page has no passage and cannot show it.
 *
 * Framed means `window.parent !== window`, so the module is put in an iframe
 * on a same-origin page — its CSP allows `frame-ancestors 'self'` — and the
 * greeting is posted into the frame the way a host would, with a passage
 * pointing at the first paragraph of the paper.
 */
const tex = readFileSync(join(paperDir, 'main.tex'))
const from = tex.indexOf('Paragraph 3-1 begins here')
/* The path as the PAPER names it, because `fileOf` compares against
   `paper.dir` and on this machine `/tmp` is a symlink to `/private/tmp`. */
const opened = await (await fetch(`${ORIGIN}/api/paper?${where}`)).json()
const passage = {
  path: join(opened.paper.dir, 'main.tex'),
  page: 1,
  from,
  to: from + 'Paragraph 3-1 begins here'.length,
  quoted: 'Paragraph 3-1 begins here',
}
const harness = `${ORIGIN}/drive-harness`
const host = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
await host.route(harness, (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:0"><iframe id="m" src="${ORIGIN}/app" style="width:100vw;height:100vh;border:0"></iframe></body></html>`,
  }),
)
await host.goto(harness)
const frame = host.frame({ url: /\/app/ }) ?? (await host.waitForEvent('frameattached'))
await frame.waitForLoadState('domcontentloaded')
await frame.waitForTimeout(400)
await frame.evaluate(
  ({ projectPath, epic, passage }) => {
    window.postMessage(
      {
        type: 'roadmap.hello',
        protocol: 2,
        session: 'proposals-drive',
        context: { projectPath, project: 'scratch', epic, theme: 'light', passage },
        state: null,
      },
      '*',
    )
  },
  { projectPath: PROJECT, epic: EPIC, passage },
)
await frame.waitForSelector('[data-page="1"] .sheet', { timeout: 15000 })
await frame.waitForSelector('[data-proposal]', { state: 'attached', timeout: 15000 })
await frame.waitForTimeout(600)
const walkedTo = await frame.evaluate(() => ({
  scrollTop: document.querySelector('.reading-column').scrollTop,
  said: document.querySelector('p[aria-live="polite"]')?.textContent ?? '',
}))
console.log(`  the greeting's passage walked the reader to scrollTop ${walkedTo.scrollTop}; the page said: "${walkedTo.said}"`)

/* The second of the pair, because in the code this driver was written against
   the first one's Accept is under the second card — Playwright refuses the
   click for the same reason a reader cannot make it. */
await frame.evaluate(() => {
  const el = Array.from(document.querySelectorAll('[data-has-proposals]')).find((n) => n.textContent.includes('Paragraph 5-3')).querySelector('[data-proposed-change]')
  el.scrollIntoView({ block: 'center' })
})
/* A scroll is one of the gestures that takes the container off mute, and a
   real reader scrolls with a wheel; say so the way the browser would. */
await host.mouse.move(WIDTH / 2, HEIGHT / 2)
await host.mouse.wheel(0, 0)
await frame.waitForTimeout(300)
const framedBefore = await frame.evaluate(() => ({
  scrollTop: document.querySelector('.reading-column').scrollTop,
  cards: document.querySelectorAll('[data-proposal]').length,
  id: Array.from(document.querySelectorAll('[data-proposal]')).find((c) => c.querySelector('.proposal-why').textContent.startsWith('Opens'))?.getAttribute('data-proposal'),
}))
console.log(`  scrollTop before: ${framedBefore.scrollTop}; cards: ${framedBefore.cards}`)
await frame.locator(`[data-proposal="${framedBefore.id}"] button`, { hasText: 'Accept' }).click()
await frame.waitForFunction((n) => document.querySelectorAll('[data-proposal]').length < n, framedBefore.cards, { timeout: 10000 })
await frame.waitForTimeout(600)
const framedAfter = await frame.evaluate(() => ({
  scrollTop: document.querySelector('.reading-column').scrollTop,
  cards: document.querySelectorAll('[data-proposal]').length,
}))
console.log(`  scrollTop after:  ${framedAfter.scrollTop}; cards: ${framedAfter.cards}`)
check(
  'accepting keeps the reader where they were, with a passage pointed at',
  Math.abs(framedAfter.scrollTop - framedBefore.scrollTop) < 2,
  `moved by ${(framedAfter.scrollTop - framedBefore.scrollTop).toFixed(1)}px`,
)
await host.close()

if (problems.length) {
  console.log('\npage errors:')
  for (const p of problems) console.log(' ', p)
}
await browser.close()
console.log(failures.length ? `\n${failures.length} failing` : '\nall passing')
process.exit(failures.length ? 1 : 0)
