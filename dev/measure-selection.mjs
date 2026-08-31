/**
 * Does highlighting a sentence move the page under the person highlighting it?
 *
 * ## What this establishes, and why nothing simpler could
 *
 * The reported failure — "when you highlight an area, it jumps to 'center' that
 * section" — cannot happen standalone. Unframed there is no host, `point` finds
 * no conversation and returns, and no context ever comes back; the only thing
 * in the module that centres anything is the `walk` effect in
 * `reader/paginated.tsx`, and nothing standalone can set a walk from a
 * selection. So a probe that loaded `/app` directly would measure a scroll
 * position that never moved and would have proved the bug absent while it was
 * on screen in front of the owner.
 *
 * The loop only closes with a host in it: a selection is published as
 * `passage.set`, the host puts it in `context.passage`, and the context is
 * broadcast to EVERY framed module — which includes the one that just sent it.
 * That returning passage is indistinguishable, to the code that receives it,
 * from a note container pointing this reader at a chapter.
 *
 * So this file is a host. Nine lines of one, doing exactly the three things
 * that matter: greet, answer `passage.set`, and echo the passage back as a
 * context. It is deliberately not the real host — `measure-framed.mjs` drives
 * that, and needs the whole canvas up on 4180/4181 with the right project
 * selected. This one needs the paper module and nothing else, which is what
 * makes it worth keeping: it will still run on a machine where the canvas is
 * not checked out.
 *
 * ## What it prints
 *
 * The reading column's `scrollTop` before the selection and after it. They must
 * be equal. `moved` is the difference and is the whole assertion — a run that
 * prints a non-zero `moved` is the bug, and a run that prints `selection: null`
 * or `echoed: false` has measured nothing at all and must not be read as a
 * pass. Both of those are printed for that reason.
 *
 * Then two pointings that did NOT come from this module, because a fix here
 * that simply stopped scrolling would pass the first measurement and break the
 * feature: a range off screen must still bring the reader to it, and a range
 * already in front of them must not move them at all.
 *
 * ## The numbers this was written against
 *
 * One paragraph near the top of the column, 900×820 frame, the single-file
 * paper `a-green-gate-means-something`:
 *
 *                            before the fix   after
 *   the reader's own highlight    -166 px      0 px
 *   pointed at an off-screen range +3671      +3373    (must move; it does)
 *   pointed at a range in view      -339        0
 *
 * The first line is the reported bug. The third is `block: 'center'` against
 * `block: 'nearest'` and is the reason the second number is not identical
 * either — `center` overshoots to put the target mid-column, `nearest` stops as
 * soon as it is on screen.
 *
 *   bun dev/measure-selection.mjs        (paper on 7870; ./run.sh if it is down)
 */
import { chromium } from '/Users/jaakkorajala/.claude/jobs/85f6bc23/tmp/node_modules/playwright/index.mjs'

const ORIGIN = process.env.PAPER_ORIGIN ?? 'http://127.0.0.1:7870'
/*
 * The probe host is served BY the module's own origin, and that is not a
 * shortcut.
 *
 * `/app` answers with `content-security-policy: frame-ancestors 'self'
 * http://127.0.0.1:4181` — the real canvas and nothing else. A harness page on
 * `about:blank`, a `data:` URL, or any little server on a spare port is an
 * origin that header refuses, and the refusal is silent from the outside: the
 * iframe simply never appears among the page's frames, which is exactly how the
 * first run of this file failed. The real canvas's port is taken by the real
 * canvas, and this probe exists to not need it.
 *
 * So the top-level page is `/app` too, with a query string to tell the two
 * apart. It renders the module's own "nothing is open" screen behind the frame,
 * which is unused and costs nothing: unframed, `window.parent === window`, so
 * that copy never speaks the protocol and cannot answer or send anything the
 * measurement below could confuse for the framed one's behaviour.
 */
const HOST_PAGE = `${ORIGIN}/app?probe=host`
const PAPER = `${ORIGIN}/app?probe=frame`
const PROJECT = process.env.PROJECT ?? '/Users/jaakkorajala/Projects/roadmap'
const EPIC = process.env.EPIC ?? 'a-green-gate-means-something'

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
    window.__log = { requests: [], echoed: false }

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
    /* Somebody else pointing: the same message the host sends when a note is
       pressed in another container. The passage never went through `passage.set`,
       so nothing in the module has any record of it — which is the whole
       difference between the two halves this probe measures. */
    window.__point = (passage) => {
      context.passage = passage
      send({ ...context, type: 'roadmap.context', protocol: 1 })
    }

    window.addEventListener('message', (ev) => {
      const m = ev.data
      if (!m || typeof m.type !== 'string' || !m.type.startsWith('roadmap.')) return
      if (m.type !== 'roadmap.request') return
      window.__log.requests.push({ method: m.method, params: m.params })
      send({ type: 'roadmap.response', id: m.id, ok: true, data: {} })
      /* The half of a host that this probe exists to reproduce: a passage set
         by one module becomes the context every module is told about, the
         sender included. */
      if (m.method === 'passage.set') {
        context.passage = m.params?.passage ?? null
        window.__log.echoed = true
        send({ ...context, type: 'roadmap.context', protocol: 1 })
      }
    })

    /* Greeted more than once because a module that has not mounted its listener
       yet would miss a single hello, and there is no signal to wait for that
       does not itself depend on the greeting having landed. It stops well
       before anything is measured: a greeting re-reads the paper, and a fetch
       landing mid-measurement would move the scroll for a reason that is not
       the one under test. */
    for (const wait of [400, 900, 1600]) {
      await new Promise((r) => setTimeout(r, wait === 400 ? 400 : 500))
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

const state = await paper.evaluate(() => {
  const col = document.querySelector('.reading-column')
  return {
    pages: document.querySelectorAll('[data-page]').length,
    scrollHeight: col ? col.scrollHeight : null,
    text: document.body.innerText.slice(0, 100),
  }
})
console.log('loaded          ', JSON.stringify(state))

/* Somewhere in the middle of the document, so a move in either direction is
   visible. At the very top a centring scroll upward would be clamped to zero
   and the bug would measure as absent. */
await paper.evaluate(() => {
  const col = document.querySelector('.reading-column')
  col.scrollTo({ top: Math.round(col.scrollHeight / 3) })
})
await page.waitForTimeout(500)

const before = await paper.evaluate(() => Math.round(document.querySelector('.reading-column').scrollTop))

const made = await paper.evaluate(() => {
  const col = document.querySelector('.reading-column')
  /* A paragraph the reader can actually see, chosen by geometry rather than by
     index: the selection has to be inside the visible part of the column for
     this to be the gesture a person makes, and for `selectionRect` to have
     something to report. */
  const box = col.getBoundingClientRect()
  const paras = [...col.querySelectorAll('p')].filter((p) => {
    const r = p.getBoundingClientRect()
    return r.top > box.top + 20 && r.bottom < box.bottom - 20 && (p.innerText ?? '').length > 60
  })
  /* The topmost one that qualifies, not the middle one. A paragraph already
     sitting near the middle of the column is a paragraph that centring barely
     has to move — the first run of this probe picked one and measured 29
     pixels, which is the bug, but 29 pixels is close enough to nothing that a
     later reader would reasonably wonder. Near the top of the viewport the same
     centring is worth hundreds. */
  const target = paras[0]
  if (!target) return { picked: null }
  const sel = window.getSelection()
  sel.removeAllRanges()
  const range = document.createRange()
  range.selectNodeContents(target)
  sel.addRange(range)
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  return { picked: (target.innerText ?? '').slice(0, 60), visible: paras.length }
})

/* Longer than `SETTLE_MS` (150) by a wide margin, plus a round trip through the
   probe host and the render the arriving context causes. */
await page.waitForTimeout(1500)

const after = await paper.evaluate(() => Math.round(document.querySelector('.reading-column').scrollTop))
const log = await page.evaluate(() => window.__log)

console.log('selection       ', JSON.stringify(made))
console.log('host heard      ', JSON.stringify(log.requests.map((r) => r.method)))
console.log('passage sent    ', JSON.stringify(log.requests.filter((r) => r.method === 'passage.set').map((r) => r.params.passage)))
console.log('echoed back     ', log.echoed)
console.log('scrollTop before', before)
console.log('scrollTop after ', after)
console.log('moved           ', after - before, after === before ? '(the page stayed put)' : '(THE PAGE MOVED)')

/*
 * The other half, and the reason a fix here cannot simply be "never scroll".
 *
 * A passage that this module did NOT publish — a note pressed in another container,
 * an agent, the host answering a `goto` — must still bring the reader to it,
 * because nobody can see it otherwise. Measured with a range at the very end of
 * the document, which is off screen from where the probe is standing.
 *
 * Then the same message again for a range that is already in front of the
 * reader. `nearest` is what makes that one cost nothing: the block is on
 * screen, so the smallest scroll that brings it into view is no scroll at all.
 * `center` moved the page in this case too, for a reader who could already see
 * exactly what they were being shown.
 */
/* The absolute path to point at, taken from what the module itself published
   rather than rebuilt from the project root and a filename. Two spellings of
   one file is the failure `use-published-passage.ts` joins paths in one place
   to avoid, and a probe that invented its own would be testing the wrong one. */
const PATH = log.requests.map((r) => r.params?.passage?.path).filter(Boolean).pop()

/* Read at the moment it is used, not once up front. The first pointing moves
   the reader three thousand pixels, so a "currently visible" block measured
   before it is not visible after it — which is how the first run of this probe
   reported a move for the on-screen case and looked like a failure of the fix
   rather than of the probe. */
const ranges = () =>
  paper.evaluate(() => {
    const col = document.querySelector('.reading-column')
    const box = col.getBoundingClientRect()
    const all = [...col.querySelectorAll('[data-src-start]')]
    const read = (el) => ({ from: Number(el.dataset.srcStart), to: Number(el.dataset.srcEnd) })
    const seen = all.find((el) => {
      const r = el.getBoundingClientRect()
      return r.top > box.top + 20 && r.bottom < box.bottom - 20
    })
    return { far: read(all[all.length - 1]), near: seen ? read(seen) : null }
  })

const point = async (range, label) => {
  const was = await paper.evaluate(() => Math.round(document.querySelector('.reading-column').scrollTop))
  await page.evaluate(
    ({ path, range }) => window.__point({ path, page: null, from: range.from, to: range.to, quoted: '' }),
    { path: PATH, range },
  )
  await page.waitForTimeout(1200)
  const now = await paper.evaluate(() => Math.round(document.querySelector('.reading-column').scrollTop))
  console.log(label, JSON.stringify({ range, was, now, moved: now - was }))
}

/* Must move: the reader cannot see it otherwise, and this is the behaviour the
   fix above has to leave alone. A zero here is the fix having gone too far. */
await point((await ranges()).far, 'pointed off screen')
/* Must not move: `nearest` is nothing when the block is already in view. */
const near = (await ranges()).near
if (near) await point(near, 'pointed on screen ')
else console.log('pointed on screen  (no block was fully in view to point at)')

await browser.close()
