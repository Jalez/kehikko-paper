import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answerAt as answer } from '../doors.ts'
import { paperState } from '../machine.ts'
import { forgetAllProposals, restartProposals } from '../proposals.ts'
import { DIGEST_QUIET_MS } from 'kehikot-module-protocol/proposals'
import { resetDigester, setTeller } from '../tell.ts'
import { DeclinedList } from '../src/declined.tsx'
import { TagWidget, type InlineSuggestion } from '../src/editor/source-editor.tsx'
import type { Declined } from '../src/use-paper.ts'

/**
 * Declining a suggestion with a reason: kept with the decision, readable by
 * the agent that suggested it, said in the one digest its session gets when
 * the person has answered all its suggestions (where its call carried a place
 * token), and drawn in the page as text.
 */

const SOURCE = [
  '\\begin{document}',
  'The claim has a tpyo in it and it runs on for long enough that the',
  'author wrapped the line, and a second sentence that also has a mistkae.',
  '\\end{document}',
  '',
].join('\n')

let root = ''
let project = ''
let main = ''
let told: { project: string; token: string; body: string }[] = []

/** Timers the test moves by hand: the digest's quiet while without waiting 30 s. */
function fakeClock() {
  let now = 0
  let timers: { run: () => void; at: number }[] = []
  return {
    setTimer: (run: () => void, ms: number) => {
      const timer = { run, at: now + ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer: unknown) => {
      timers = timers.filter((one) => one !== timer)
    },
    advance(ms: number) {
      now += ms
      for (const timer of timers.filter((one) => one.at <= now)) {
        timers = timers.filter((one) => one !== timer)
        timer.run()
      }
    },
    waiting: () => timers.length,
  }
}
let clock = fakeClock()
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123'

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-decline-')))
  project = join(root, 'work')
  const paper = join(project, '.kehikot', 'paper', 'a-paper')
  mkdirSync(paper, { recursive: true })
  main = join(paper, 'main.tex')
  writeFileSync(main, SOURCE)
  forgetAllProposals()
  told = []
  setTeller((p, token, body) => told.push({ project: p, token, body }))
  clock = fakeClock()
  resetDigester(clock)
})

afterEach(() => {
  cleanup()
  setTeller(null)
  resetDigester()
  rmSync(root, { recursive: true, force: true })
  forgetAllProposals()
})

function tool(name: string, args: Record<string, unknown>, place?: string): string {
  const reply = answer('POST', '/mcp', new URLSearchParams(place ? { 'kehikot-place': place } : {}), {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  return (reply?.body as { result?: { content?: { text?: string }[] } })?.result?.content?.[0]?.text ?? ''
}
const idOf = (said: string): string => said.replace(/^Filed as (\S+)\..*$/s, '$1')
const tokenOf = (said: string): string => /Revision token: (\S+)/.exec(said)?.[1] ?? ''
const suggest = (find: string, replace: string, extra: Record<string, unknown> = {}, place?: string) =>
  tool('propose_edit', { project, epic: 'a-paper', file: 'main.tex', find, replace, why: 'Spelling.', ...extra }, place)
const q = () => new URLSearchParams({ epic: 'a-paper', project })
const decline = (id: string, reason?: unknown) =>
  answer('POST', '/api/proposal', q(), { id, decision: 'reject', ...(reason === undefined ? {} : { reason }) }, TICKET)
const giveReason = (id: string, reason: unknown) =>
  answer('POST', '/api/review', q(), { action: 'decline-reason', id, reason }, TICKET)
const declinedNow = () =>
  ((answer('GET', '/api/proposals', q(), null)?.body as { declined?: Declined[] }).declined ?? [])
const listed = () => tool('list_proposals', { project, epic: 'a-paper' })

describe('declining, kept with the decision', () => {
  test('without a reason: one press, declined, and said to have no reason', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    const reply = decline(id)
    expect(reply?.status).toBe(200)
    expect(readFileSync(main, 'utf8')).toBe(SOURCE)
    const [one] = declinedNow()
    expect(one).toMatchObject({ id, file: 'main.tex', reason: '', count: 1 })
    expect(listed()).toContain(`${id}\tmain.tex`)
    expect(listed()).toMatch(/state: declined by the author at \S+\tno reason given/)
  })

  test('with a reason: kept with who and when, survives a restart, and list_proposals says it as data', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    decline(id, '  The misspelling is a quote from the source; keep it.  ')
    restartProposals()
    expect(declinedNow()[0]!.reason).toBe('The misspelling is a quote from the source; keep it.')
    expect(listed()).toContain('reason: "The misspelling is a quote from the source; keep it."')
    const kept = JSON.parse(
      readFileSync(join(paperState(project, 'a-paper'), 'suggestions.json'), 'utf8'),
    ) as { outcomes: { id: string; declinedReason?: string; declinedBy?: string; declinedAt?: number }[] }
    const outcome = kept.outcomes.find((o) => o.id === id)!
    expect(outcome.declinedReason).toBe('The misspelling is a quote from the source; keep it.')
    expect(outcome.declinedBy).toBe('author')
    expect(typeof outcome.declinedAt).toBe('number')
  })

  test('the reason can be added afterwards, changed, and cleared, while it is listed', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    decline(id)
    expect(giveReason(id, 'Too informal.')?.status).toBe(200)
    expect(declinedNow()[0]!.reason).toBe('Too informal.')
    expect(listed()).toContain('reason: "Too informal."')
    giveReason(id, 'Changes the quoted wording.')
    expect(declinedNow()[0]!.reason).toBe('Changes the quoted wording.')
    giveReason(id, '')
    expect(declinedNow()[0]!.reason).toBe('')
    expect(listed()).toContain('no reason given')
  })

  test('only a declined suggestion takes a reason for declining', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    expect(giveReason(id, 'Nope.')?.status).toBe(404)
    answer('POST', '/api/proposal', q(), { id, decision: 'accept' }, TICKET)
    expect(giveReason(id, 'Nope.')?.status).toBe(404)
  })

  test('the cap: 1000 characters is kept, 1001 is refused on both paths and nothing is declined', () => {
    const a = idOf(suggest('tpyo', 'typo'))
    expect(decline(a, 'x'.repeat(1001))?.status).toBe(400)
    expect(declinedNow()).toEqual([])
    expect(decline(a, 'x'.repeat(1000))?.status).toBe(200)
    expect(declinedNow()[0]!.reason).toHaveLength(1000)
    expect(giveReason(a, 'y'.repeat(1001))?.status).toBe(400)
    expect(declinedNow()[0]!.reason).toBe('x'.repeat(1000))
  })

  test('plain text: markup is kept as written, control characters go, line breaks stay', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    decline(id, '<b>no</b>\u0007 \\emph{really}\r\nsecond line')
    expect(declinedNow()[0]!.reason).toBe('<b>no</b> \\emph{really}\nsecond line')
  })

  test('a group is one decision: every member keeps the reason, and it is listed once', () => {
    const a = idOf(suggest('tpyo', 'typo', { group: 'g1' }))
    suggest('mistkae', 'mistake', { group: 'g1' })
    decline(a, 'Both are deliberate.')
    const list = declinedNow()
    expect(list).toHaveLength(1)
    expect(list[0]!.count).toBe(2)
    expect(listed().match(/reason: "Both are deliberate."/g)).toHaveLength(2)
  })

  test('revising a declined suggestion is refused with the reason in the words', () => {
    const said = suggest('tpyo', 'typo')
    decline(idOf(said), 'Keep the quote.')
    const why = tool('revise_edit', { project, epic: 'a-paper', id: idOf(said), token: tokenOf(said), replace: 'typos' })
    expect(why).toContain('already declined by the author, who said: "Keep the quote."')
  })
})

describe('the agent that suggested it is told once, when the person has answered them all', () => {
  const accept = (id: string) => answer('POST', '/api/proposal', q(), { id, decision: 'accept' }, TICKET)

  test('answered all: one digest after the quiet while, to the token that came with propose_edit', () => {
    const a = idOf(suggest('tpyo', 'typo', {}, TOKEN))
    const b = idOf(suggest('mistkae', 'mistake', {}, TOKEN))
    accept(a)
    expect(clock.waiting()).toBe(0)
    decline(b, 'It is a quotation.')
    expect(told).toEqual([])
    clock.advance(DIGEST_QUIET_MS - 1)
    expect(told).toEqual([])
    clock.advance(1)
    expect(told).toHaveLength(1)
    expect(told[0]!.token).toBe(TOKEN)
    expect(told[0]!.project).toBe(project)
    expect(told[0]!.body).toBe(
      'Your 2 proposed changes to main.tex were answered: 1 accepted, 1 declined: "It is a quotation.". list_proposals shows each one.',
    )
  })

  test('no message per decision: answering one of two says nothing while the other is open', () => {
    const a = idOf(suggest('tpyo', 'typo', {}, TOKEN))
    idOf(suggest('mistkae', 'mistake', {}, TOKEN))
    decline(a, 'No.')
    clock.advance(DIGEST_QUIET_MS * 10)
    expect(told).toEqual([])
  })

  test('a decision in the quiet while starts it again', () => {
    const a = idOf(suggest('tpyo', 'typo', {}, TOKEN))
    decline(a, 'First.')
    clock.advance(DIGEST_QUIET_MS - 1000)
    const b = idOf(suggest('mistkae', 'mistake', {}, TOKEN))
    decline(b, 'Second.')
    clock.advance(DIGEST_QUIET_MS - 1000)
    expect(told).toEqual([])
    clock.advance(1000)
    expect(told).toHaveLength(1)
    expect(told[0]!.body).toBe(
      'Your 2 proposed changes to main.tex were answered: 2 declined: "First."; "Second.". list_proposals shows each one.',
    )
  })

  test('a group beside a lone suggestion: two decisions, each reason once', () => {
    const a = idOf(suggest('tpyo', 'typo', { group: 'g1' }, TOKEN))
    suggest('mistkae', 'mistake', { group: 'g1' }, TOKEN)
    const b = idOf(suggest('The claim', 'A claim', {}, TOKEN))
    decline(a, 'Both are deliberate.')
    decline(b, 'Keep the article.')
    clock.advance(DIGEST_QUIET_MS)
    expect(told.map((one) => one.body)).toEqual([
      'Your 2 proposed changes to main.tex were answered: 2 declined: "Both are deliberate."; "Keep the article.". list_proposals shows each one.',
    ])
  })

  test('a reason given later to a declined group is still said once', () => {
    const a = idOf(suggest('tpyo', 'typo', { group: 'g1' }, TOKEN))
    suggest('mistkae', 'mistake', { group: 'g1' }, TOKEN)
    decline(a)
    giveReason(a, 'Deliberate.')
    clock.advance(DIGEST_QUIET_MS)
    expect(told.map((one) => one.body)).toEqual(['Your proposed change to main.tex was answered: 1 declined: "Deliberate.". list_proposals shows each one.'])
  })

  test('declined without a reason, then one added in the quiet while: the digest says the reason', () => {
    const id = idOf(suggest('tpyo', 'typo', {}, TOKEN))
    decline(id)
    giveReason(id, 'On reflection: a quote.')
    clock.advance(DIGEST_QUIET_MS)
    expect(told.map((one) => one.body)).toEqual([
      'Your proposed change to main.tex was answered: 1 declined: "On reflection: a quote.". list_proposals shows each one.',
    ])
  })

  test('a group is one digest, counted as one decision with its reason once; a call with no place token is told nothing', () => {
    const a = idOf(suggest('tpyo', 'typo', { group: 'g1' }, TOKEN))
    suggest('mistkae', 'mistake', { group: 'g1' }, TOKEN)
    decline(a, 'No.')
    clock.advance(DIGEST_QUIET_MS)
    expect(told).toHaveLength(1)
    expect(told[0]!.body).toBe('Your proposed change to main.tex was answered: 1 declined: "No.". list_proposals shows each one.')
    told = []
    const b = idOf(suggest('tpyo', 'typos'))
    decline(b, 'No.')
    clock.advance(DIGEST_QUIET_MS)
    expect(told).toEqual([])
  })

  test('the tool descriptions say a declined suggestion may carry the reason', () => {
    const reply = answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (reply?.body as { result: { tools: { name: string; description: string }[] } }).result.tools
    const of = (name: string) => tools.find((t) => t.name === name)!.description
    expect(of('propose_edit')).toContain('declined may carry their reason')
    expect(of('list_proposals')).toContain('reason')
  })
})

describe('in the page: declining from the tag', () => {
  const one = (over: Partial<InlineSuggestion> = {}): InlineSuggestion => ({
    id: 'p1', key: 'k1', from: 0, to: 4, replacement: 'x', after: false, current: true, armed: false,
    why: 'Because.', revisions: 0, count: 1, tag: true, editing: false, proposed: 'x', kind: 'staged', found: 0, adjusted: false, ...over,
  })
  const draw = (s: InlineSuggestion) => {
    const answers: unknown[][] = []
    const declining = new Map<string, string>()
    const on = {
      list: [s], drafts: new Map<string, string>(), declining, toggle() {}, draft() {}, why() {}, version() {}, stopEditing() {}, pick() {},
      answer: (...args: unknown[]) => answers.push(args),
    }
    const tag = new TagWidget(s, on).toDOM()
    return { tag, answers, declining }
  }
  const press = (el: Element | null) => (el as HTMLElement).click()
  const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

  /* #72: the reason is asked where Decline was pressed, not afterwards in a list. */
  test('Decline opens a field on this tag, beside the diff, and declines nothing yet', () => {
    const { tag, answers, declining } = draw(one())
    const form = tag.querySelector<HTMLElement>('[data-sugg-decline]')!
    expect(form.hidden).toBe(true)
    const button = tag.querySelector<HTMLElement>('[data-sugg-answer="reject"]')!
    expect(button.textContent).toContain('Decline')
    expect(tag.querySelector('[data-sugg-decline-reason]')).toBeNull()
    press(button)
    expect(form.hidden).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(answers).toEqual([])
    expect(declining.has('p1')).toBe(true)
    const field = tag.querySelector<HTMLInputElement>('[data-sugg-decline-why]')!
    expect(field.placeholder).toStartWith('Why? (optional)')
    expect(field.maxLength).toBe(1000)
  })

  test('the fast path: Decline pressed again declines without a reason', () => {
    const { tag, answers } = draw(one())
    press(tag.querySelector('[data-sugg-answer="reject"]'))
    press(tag.querySelector('[data-sugg-answer="reject"]'))
    expect(answers).toEqual([['k1', 'reject', undefined, undefined]])
  })

  test('Enter on the empty field declines without a reason', () => {
    const { tag, answers } = draw(one())
    press(tag.querySelector('[data-sugg-answer="reject"]'))
    key(tag.querySelector('[data-sugg-decline-why]')!, 'Enter')
    expect(answers).toEqual([['k1', 'reject', undefined, undefined]])
  })

  test('words in the field go with the decision: Enter, or Decline with reason', () => {
    const { tag, answers } = draw(one())
    press(tag.querySelector('[data-sugg-answer="reject"]'))
    const field = tag.querySelector<HTMLInputElement>('[data-sugg-decline-why]')!
    const submit = tag.querySelector<HTMLElement>('[data-sugg-decline-submit]')!
    expect(submit.textContent).toBe('Decline')
    field.value = '  Keep the original.  '
    field.dispatchEvent(new Event('input', { bubbles: true }))
    expect(submit.textContent).toBe('Decline with reason')
    key(field, 'Enter')
    press(submit)
    expect(answers).toEqual([
      ['k1', 'reject', undefined, 'Keep the original.'],
      ['k1', 'reject', undefined, 'Keep the original.'],
    ])
  })

  test('Escape and Back close the field and decline nothing', () => {
    const { tag, answers, declining } = draw(one())
    press(tag.querySelector('[data-sugg-answer="reject"]'))
    key(tag.querySelector('[data-sugg-decline-why]')!, 'Escape')
    expect(tag.querySelector<HTMLElement>('[data-sugg-decline]')!.hidden).toBe(true)
    press(tag.querySelector('[data-sugg-answer="reject"]'))
    press(tag.querySelector('[data-sugg-decline-cancel]'))
    expect(tag.querySelector<HTMLElement>('[data-sugg-decline]')!.hidden).toBe(true)
    expect(answers).toEqual([])
    expect(declining.size).toBe(0)
  })

  test('a change found in the file has no reason to give an agent: Cancel change is one press, no field', () => {
    const { tag, answers } = draw(one({ kind: 'disk' }))
    expect(tag.querySelector('[data-sugg-decline]')).toBeNull()
    const button = tag.querySelector<HTMLElement>('[data-sugg-answer="reject"]')!
    expect(button.textContent).toContain('Cancel change')
    press(button)
    expect(answers).toEqual([['k1', 'reject']])
  })
})

describe('in the page: the declined list', () => {
  const item = (over: Partial<Declined> = {}): Declined => ({
    id: 'd1', file: 'main.tex', old: 'tpyo', new: 'typo', why: 'Spelling.', at: 0, reason: '', count: 1, ...over,
  })

  test('a reason is drawn as text, never markup', () => {
    const { container } = render(<DeclinedList list={[item({ reason: '<b>bold</b> <a href="x">link</a>' })]} onReason={async () => true} />)
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('[data-declined-reason]')!.textContent).toBe('“<b>bold</b> <a href="x">link</a>”')
  })

  test('Add reason opens a field; Enter saves it, Escape cancels', async () => {
    const saved: [string, string][] = []
    render(<DeclinedList list={[item()]} onReason={async (id, reason) => (saved.push([id, reason]), true)} />)
    expect(screen.getByText('no reason given')).toBeTruthy()
    fireEvent.click(screen.getByText('Add reason'))
    let field = screen.getByLabelText('Why it was declined (optional)') as HTMLInputElement
    expect(field.maxLength).toBe(1000)
    fireEvent.change(field, { target: { value: 'Not this one' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(saved).toEqual([])
    expect(screen.queryByLabelText('Why it was declined (optional)')).toBeNull()
    fireEvent.click(screen.getByText('Add reason'))
    field = screen.getByLabelText('Why it was declined (optional)') as HTMLInputElement
    fireEvent.change(field, { target: { value: ' A quotation. ' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })
    expect(saved).toEqual([['d1', 'A quotation.']])
  })

  test('a declined change with a reason offers to edit it, starting from what was said', () => {
    render(<DeclinedList list={[item({ reason: 'Old reason' })]} onReason={async () => true} />)
    fireEvent.click(screen.getByText('Edit reason'))
    expect((screen.getByLabelText('Why it was declined (optional)') as HTMLInputElement).value).toBe('Old reason')
  })

  /* #72: who or what ended it, where it was, what it was, and the way back to it. */
  test('declined by you, set aside by an accepted change and withdrawn by the agent read differently', () => {
    const { container } = render(
      <DeclinedList
        list={[item({ id: 'a' }), item({ id: 'b', how: 'superseded' }), item({ id: 'c', how: 'withdrawn' })]}
        onReason={async () => true}
      />,
    )
    const by = [...container.querySelectorAll('[data-declined-by]')].map((el) => el.textContent)
    expect(by).toEqual(['Declined by you', 'Set aside: it overlapped a change you accepted', 'Withdrawn by the agent'])
    /* Only the person's own decision carries a reason to give. */
    expect(container.querySelectorAll('[data-declined-edit]')).toHaveLength(1)
    expect(screen.getAllByText('no reason given')).toHaveLength(1)
  })

  test('it says the file and section, the passage as quoted and proposed, and Show goes back to it', () => {
    const shown: [string, number][] = []
    const long = 'harjoitustehtävän keskusteluna sen sijaan, että se olisi staattinen tehtävänanto, jonka opiskelija lukee'
    const { container } = render(
      <DeclinedList
        list={[item({ file: 'chapters/2.tex', from: 120, old: long, new: 'Suuret kielimallit tekevät mahdolliseksi' })]}
        onReason={async () => true}
        sectionOf={(file, from) => (file === 'chapters/2.tex' && from === 120 ? 'Background' : null)}
        onShow={(file, from) => shown.push([file, from])}
      />,
    )
    expect(container.querySelector('[data-declined-section]')!.textContent).toBe('§ Background')
    expect(container.querySelector('[data-declined-change] del')!.textContent).toBe(long)
    fireEvent.click(screen.getByText('Show'))
    expect(shown).toEqual([['chapters/2.tex', 120]])
  })

  test('nothing declined lately draws nothing', () => {
    const { container } = render(<DeclinedList list={[]} onReason={async () => true} />)
    expect(container.innerHTML).toBe('')
  })
})
