import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { rowsAdvice } from 'kehikot-module-protocol'

import { ROWS_PATH, rows, rowsText } from '../dev/rows.ts'

describe('the rows kehikot-check-rows reads', () => {
  test('kehikot.rows.json is what headerOf and footerItems make now (bun dev/rows.ts writes it)', () => {
    expect(readFileSync(ROWS_PATH, 'utf8')).toBe(rowsText())
  })

  test('the header and footer are placed by the rule, in every state', () => {
    for (const one of rows()) expect(rowsAdvice(one.header, one.footer, { state: one.state })).toEqual([])
  })

  test('the accepted count is in the footer, and the header says only what it lists', () => {
    const [, waiting] = rows()
    expect(JSON.stringify(waiting!.header)).not.toContain('Accepted changes ·')
    expect(waiting!.footer.find((item) => item.id === 'accepted')).toMatchObject({ kind: 'text', text: '3 accepted' })
  })
})
