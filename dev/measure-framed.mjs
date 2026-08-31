/**
 * The paper as the owner actually sees it: inside a Kehikot container, in a frame.
 *
 * Standalone measurement could never settle the report that "the first A4 can be
 * partially swallowed from the top by its container", because the two mechanisms that
 * could do it only exist when the module is framed:
 *
 *  - The host places module iframes in a layer UNDER the grid, positioned from
 *    measured rects (`src/host/rects.ts` in the kehikko repo). If the container's
 *    box and the frame's translate ever disagree, the module's top is clipped by
 *    something inside the module that cannot scroll it back.
 *  - `scrollIntoView` scrolls every scrollable ancestor, and when framed there is
 *    a host document above the module that standalone does not have.
 *
 * So this drives the real host: it opens the canvas, switches to the project and
 * the kehikko that carry `roadmap.paper`, finds that frame, and prints the
 * container's box beside the frame's box beside the module's own top-of-page
 * numbers — before and after a scroll to the end and back, and after asking the
 * sections sidebar to turn a page, which is the one thing in the module that
 * calls `scrollIntoView`.
 *
 * `hiddenAtTop` is the column's top minus page one's top, in the module's own
 * coordinates: positive means the sheet starts above the visible area.
 *
 *   bun dev/measure-framed.mjs      (host on 4180/4181, paper on 7870)
 */
import { chromium } from '/Users/jaakkorajala/.claude/jobs/85f6bc23/tmp/node_modules/playwright/index.mjs'

const PAPER = 'http://127.0.0.1:7870/app'

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ??
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
})
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:4181/', { waitUntil: 'load' })
await page.waitForTimeout(3000)

/* The kehikko that has the paper on it lives in another project, and the host
   remembers both in localStorage — but it writes them back on load, so they are
   switched through the UI rather than stamped into storage. */
await page.click('[aria-label="switch project"]')
await page.waitForTimeout(500)
await page.getByRole('menuitem', { name: 'thesis_latex' }).click()
await page.waitForTimeout(6000)

const box = async () =>
  page.evaluate((src) => {
    const f = [...document.querySelectorAll('iframe')].find((el) => el.src === src)
    if (!f) return null
    const fr = f.getBoundingClientRect()
    /* The container the frame is supposed to be sitting in. The host draws the
       grid and the frames in two different layers — the frame is positioned
       from a MEASURED rect of the container's body (`src/host/rects.ts`) — so
       these are two independent answers to "where is this module", and a
       disagreement between them is exactly the failure worth looking for: it
       would clip the module's top with nothing able to scroll it back.

       The body carries no attribute of its own, so it is found the way a person
       would: the grid item whose header says Paper, and the hollow div under
       that header (`Container.tsx`, `ref={body}`). */
    const item = [...document.querySelectorAll('.react-grid-item')].find((el) =>
      /(^|\s)Paper(\s|$)/.test(el.querySelector('header')?.innerText ?? ''),
    )
    const holder = item?.querySelector('header')?.parentElement?.nextElementSibling ?? null
    const hr = holder?.getBoundingClientRect()
    return {
      frame: { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.width), h: Math.round(fr.height) },
      container: hr ? { x: Math.round(hr.x), y: Math.round(hr.y), w: Math.round(hr.width), h: Math.round(hr.height) } : null,
    }
  }, PAPER)

const inside = async () => {
  const frame = page.frames().find((f) => f.url().startsWith(PAPER))
  if (!frame) return 'no paper frame'
  return frame.evaluate(() => {
    const col = document.querySelector('.reading-column')
    const one = document.querySelector('[data-page="1"]')
    if (!col || !one) return { state: document.body.innerText.slice(0, 120) }
    const c = col.getBoundingClientRect()
    const p = one.getBoundingClientRect()
    const doc = document.scrollingElement
    return {
      colTop: Math.round(c.top),
      pageTop: Math.round(p.top),
      hiddenAtTop: Math.round(c.top - p.top),
      scrollTop: Math.round(col.scrollTop),
      docScrollTop: Math.round(doc.scrollTop),
      docOverflow: doc.scrollHeight - doc.clientHeight,
      winInner: window.innerHeight,
      docHeight: document.documentElement.scrollHeight,
    }
  })
}

console.log('boxes           ', JSON.stringify(await box()))
console.log('at rest         ', JSON.stringify(await inside()))

const frame = page.frames().find((f) => f.url().startsWith(PAPER))
if (frame) {
  await frame.evaluate(() => {
    const col = document.querySelector('.reading-column')
    col.scrollTo({ top: col.scrollHeight })
  })
  await page.waitForTimeout(600)
  console.log('scrolled to end ', JSON.stringify(await inside()))
  await frame.evaluate(() => document.querySelector('.reading-column').scrollTo({ top: 0 }))
  await page.waitForTimeout(600)
  console.log('back to the top ', JSON.stringify(await inside()))

  /* The one gesture in the module that calls `scrollIntoView`, which scrolls
     every scrollable ancestor and therefore might move the HOST. */
  const turned = await frame.evaluate(async () => {
    const col = document.querySelector('.reading-column')
    document.querySelector('[data-slot="sidebar-trigger"]')?.click()
    await new Promise((r) => setTimeout(r, 400))
    const items = [...document.querySelectorAll('[data-slot="sidebar-menu-button"]')]
    const n = items.length
    items[Math.min(6, n - 1)]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 1200))
    /* Reported so a run that measured nothing cannot be read as a run that
       measured nothing wrong: if the column did not move, the gesture did not
       happen and the `scrollIntoView` hypothesis was not tested. */
    return { sections: n, movedTo: Math.round(col.scrollTop) }
  })
  await page.waitForTimeout(600)
  console.log('a section press ', JSON.stringify(turned))
  console.log('after a section ', JSON.stringify(await inside()))
  console.log('host scrollTop  ', await page.evaluate(() => document.scrollingElement.scrollTop))
  console.log('boxes after     ', JSON.stringify(await box()))
}

await browser.close()
