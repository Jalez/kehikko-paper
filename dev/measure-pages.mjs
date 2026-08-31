/**
 * What the paper actually measures on screen, against the running module.
 *
 * Two questions this answers, both of which were argued about from screenshots
 * before anybody put a number on them:
 *
 *  1. **The gap between sheets.** `GAP` in `reader/paginated.tsx` is a
 *     `marginBottom` in SCREEN pixels on the wrapper, and the wrapper's height
 *     is the sheet's height ALREADY multiplied by `scale`. So the gap is the
 *     one thing in this view that does not shrink with the container: as a
 *     fraction of a page it grows as the container narrows, which is what turns
 *     a stack of pages into a list of cards. This prints the gap, the page
 *     height and the ratio at every width worth caring about.
 *
 *  2. **Is anything clipped off the top?** The report was that the first A4 can
 *     be "partially swallowed from the top by its container". `hiddenAtTop` is
 *     the column's top minus page 1's top: positive means the sheet begins
 *     above the visible area. Printed at every size, at scrollTop 0.
 *
 * It also prints the largest vertical gap between two consecutive rendered
 * blocks on the first sheet, in PAGE units, because the same report was later
 * attributed to "a huge gap between main.tex and 1_introduction.tex" — and the
 * only way to tell an oversized margin from an empty block from an ordinary
 * chapter-opening space is to measure all three.
 *
 *   bun dev/measure-pages.mjs [epic]     (module must be running on 7870)
 */
import { chromium } from '/Users/jaakkorajala/.claude/jobs/85f6bc23/tmp/node_modules/playwright/index.mjs'

const epic = process.argv[2] ?? 'thesis'
const URL = `http://127.0.0.1:7870/?epic=${encodeURIComponent(epic)}`
const SIZES = [
  [220, 700],
  [340, 700],
  [460, 360],
  [700, 300],
  [900, 220],
  [1100, 700],
]

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ??
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
})
const page = await browser.newPage()

console.log(`epic=${epic}`)
for (const [w, h] of SIZES) {
  await page.setViewportSize({ width: w, height: h })
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('[data-page="1"] .sheet', { timeout: 15000 })
  await page.waitForTimeout(300)
  const out = await page.evaluate(() => {
    const col = document.querySelector('.reading-column')
    const a = document.querySelector('[data-page="1"]')
    const b = document.querySelector('[data-page="2"]')
    const sheet = a.querySelector('.sheet')
    const scale = Number(sheet.dataset.pageScale)
    const ra = a.getBoundingClientRect()

    /* Every rendered block on sheet one, top to bottom, so the space BETWEEN
       two of them can be read off rather than guessed at. Divided by the scale
       so the answer is in the page's own units, which is where the CSS that
       made it lives. */
    const rows = [...sheet.querySelectorAll(':scope > header, :scope > .block-row')]
    let worst = { gap: 0, after: null, before: null }
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].getBoundingClientRect()
      const here = rows[i].getBoundingClientRect()
      const gap = (here.top - prev.bottom) / scale
      if (gap > worst.gap) {
        worst = {
          gap: Math.round(gap),
          after: rows[i - 1].dataset.blockId ?? 'header',
          before: rows[i].dataset.blockId ?? '?',
        }
      }
    }
    return {
      scale,
      colWidth: col.clientWidth,
      pageH: Math.round(ra.height),
      gapPx: b ? Math.round((b.getBoundingClientRect().top - ra.bottom) * 10) / 10 : null,
      hiddenAtTop: Math.round(col.getBoundingClientRect().top - ra.top),
      docOverflow: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
      colHeight: col.clientHeight,
      chromeH: Math.round(col.getBoundingClientRect().top),
      pages: document.querySelectorAll('[data-page]').length,
      worst,
      /* How much of sheet one is blank before its first drawn glyph, in page
         units: the "the top of the page is empty" complaint, as a number. */
      firstInkAt: Math.round((rows[0].getBoundingClientRect().top - sheet.getBoundingClientRect().top) / scale),
    }
  })
  const pct = out.gapPx === null ? '—' : ((out.gapPx / out.pageH) * 100).toFixed(2) + '%'
  console.log(
    `${String(w).padStart(4)}x${String(h).padEnd(4)} scale=${out.scale.toFixed(3)} col=${out.colWidth}x${out.colHeight} ` +
      `chrome=${out.chromeH}px pages=${out.pages} page=${out.pageH}px gap=${out.gapPx}px (${pct} of a page) ` +
      `hiddenAtTop=${out.hiddenAtTop} docOverflow=${out.docOverflow} firstInk=${out.firstInkAt}pu ` +
      `worstGapOnSheet1=${out.worst.gap}pu between ${out.worst.after} and ${out.worst.before}`,
  )
}

await browser.close()
