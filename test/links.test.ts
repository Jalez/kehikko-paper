import { describe, expect, test } from 'bun:test'

import { follow, linksOf, placeOf, webAddressOf } from '../src/pdf/links.ts'

describe('an address a link may open', () => {
  test('http and https, as written', () => {
    expect(webAddressOf('https://github.com/Jalez/skills')).toBe('https://github.com/Jalez/skills')
    expect(webAddressOf('http://example.org/a?b=c#d')).toBe('http://example.org/a?b=c#d')
  })

  test('nothing else: not javascript, file, data, mailto, a relative path, or text with spaces in it', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<p>', 'mailto:a@b.c', '/relative', 'https://exa mple.org', 'https:///', '', null, 7]) {
      expect(webAddressOf(bad)).toBeNull()
    }
  })
})

describe('the links on a page', () => {
  test('a URI link and a destination link, turned to points from the top-left; anything else left out', () => {
    const links = linksOf(
      [
        { subtype: 'Link', rect: [100, 700, 200, 712], url: 'https://github.com/Jalez/skills' },
        { subtype: 'Link', rect: [72, 600, 140, 610], dest: 'section.2' },
        { subtype: 'Link', rect: [72, 500, 140, 510], dest: [{ num: 4, gen: 0 }, { name: 'XYZ' }, 72, 700, null] },
        { subtype: 'Link', rect: [0, 0, 10, 10], unsafeUrl: 'javascript:alert(1)' },
        { subtype: 'Link', rect: [0, 0, 10, 10] },
        { subtype: 'Link', rect: [5, 5, 5, 9], url: 'https://flat.example' },
        { subtype: 'Widget', rect: [0, 0, 10, 10], url: 'https://form.example' },
        null,
      ],
      792,
    )
    expect(links).toHaveLength(3)
    expect(links[0]).toEqual({ rect: { page: 0, x: 100, y: 792 - 712, w: 100, h: 12 }, to: { kind: 'web', url: 'https://github.com/Jalez/skills' } })
    expect(links[1]!.to).toEqual({ kind: 'dest', dest: 'section.2' })
    expect(links[2]!.to.kind).toBe('dest')
  })

  test('an address pdf.js did not vouch for is still taken when it is https', () => {
    expect(linksOf([{ subtype: 'Link', rect: [0, 0, 10, 10], unsafeUrl: 'https://example.org/x' }], 100)[0]!.to).toEqual({ kind: 'web', url: 'https://example.org/x' })
  })
})

describe('where a link inside the paper goes', () => {
  const ref = { num: 9, gen: 0 }
  const doc = {
    getDestination: async (id: string) => (id === 'section.2' ? [ref, { name: 'XYZ' }, 72, 700, null] : null),
    getPageIndex: async (r: unknown) => (r === ref ? 4 : -1),
    getPage: async () => ({ getViewport: () => ({ height: 792 }) }),
  }

  test('a named destination: its page, one-based, and how far down from the top', async () => {
    expect(await placeOf(doc, 'section.2')).toEqual({ page: 5, y: 92 })
  })

  test('an explicit one, by page number, that fits the page: the page and no height', async () => {
    expect(await placeOf(doc, [2, { name: 'Fit' }])).toEqual({ page: 3, y: null })
    expect(await placeOf(doc, [ref, { name: 'FitH' }, 792])).toEqual({ page: 5, y: 0 })
  })

  test('a destination the PDF does not know is nowhere, and nothing is thrown', async () => {
    expect(await placeOf(doc, 'missing')).toBeNull()
    expect(await placeOf({ ...doc, getPageIndex: async () => Promise.reject(new Error('bad ref')) }, [ref, { name: 'XYZ' }, 0, 0, 0])).toBeNull()
  })
})

describe('following an address', () => {
  const tabs: string[] = []
  const tab = (url: string) => void tabs.push(url)

  test('the canvas took it — shown in the module that shows pages, or put in front of the person: no tab', async () => {
    tabs.length = 0
    const asked: string[] = []
    expect(await follow('https://a.example', async (url) => (asked.push(url), { outcome: 'shown' }), tab)).toBe('canvas')
    expect(await follow('https://a.example', async () => ({ outcome: 'offered' }), tab)).toBe('canvas')
    expect(asked).toEqual(['https://a.example'])
    expect(tabs).toEqual([])
  })

  test('declined, not answered by an older host, refused, or no host at all: a new tab, never nowhere', async () => {
    tabs.length = 0
    expect(await follow('https://a.example', async () => ({ outcome: 'declined' }), tab)).toBe('tab')
    expect(await follow('https://b.example', async () => null, tab)).toBe('tab')
    expect(await follow('https://c.example', async () => Promise.reject(new Error('gone')), tab)).toBe('tab')
    expect(await follow('http://d.example', undefined, tab)).toBe('tab')
    expect(tabs).toEqual(['https://a.example', 'https://b.example', 'https://c.example', 'http://d.example'])
  })

  test('without a host the tab opens in the same turn as the press, so no popup blocker takes it', () => {
    tabs.length = 0
    void follow('https://now.example', undefined, tab)
    expect(tabs).toEqual(['https://now.example'])
  })

  test('an address that is not http or https goes nowhere: not to the canvas and not to a tab', async () => {
    tabs.length = 0
    let asked = false
    expect(await follow('javascript:alert(1)', async () => ((asked = true), { outcome: 'shown' }), tab)).toBe('nowhere')
    expect(asked).toBe(false)
    expect(tabs).toEqual([])
  })
})
