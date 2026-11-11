import { describe, expect, test } from 'bun:test'
import { DOCUMENT_PROPOSALS, MODULE_FOLDERS, documentRoot, foldersOwned, manifestSchema, serviceDescriptor } from 'kehikot-module-protocol'

import { answer } from '../doors.ts'
import { MANIFEST } from '../manifest.ts'

/**
 * The service other modules use this one through (protocol 2.83.0): an epic's paper as a document that
 * takes edits only as proposals. Whoever uses it reads its folder and its tools from here, so they are
 * held to what this module really has.
 */
describe('document.proposals', () => {
  const descriptor = serviceDescriptor(DOCUMENT_PROPOSALS, MANIFEST.services?.[DOCUMENT_PROPOSALS])

  test('is provided, and its descriptor parses with the protocol schema', () => {
    expect(descriptor).not.toBeNull()
    expect(manifestSchema.parse(MANIFEST).services?.[DOCUMENT_PROPOSALS]).toBeTruthy()
  })

  test('its folder is the one this module keeps papers in', () => {
    expect(documentRoot(descriptor!, 'my-epic')).toBe('.kehikot/paper/my-epic')
    expect(descriptor!.main).toBe('main.tex')
  })

  test('every tool it names is on the door', async () => {
    const reply = await answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = ((reply?.body as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name)
    for (const tool of Object.values(descriptor!.tools)) expect(names).toContain(tool)
  })
})

/** The folder this module owns under `.kehikot/` (protocol 2.85.0), said so a module showing files can name its owner. */
describe('module.folders', () => {
  test('declares the paper folder, authored, under this module\'s name', () => {
    const descriptor = serviceDescriptor(MODULE_FOLDERS, MANIFEST.services?.[MODULE_FOLDERS])
    expect(descriptor).not.toBeNull()
    expect(descriptor!.name).toBe('Paper')
    expect(descriptor!.folders.map((one) => [one.folder, one.derived])).toEqual([['paper', false]])
    const owned = foldersOwned([{ module: 'kehikot.paper', descriptor: MANIFEST.services?.[MODULE_FOLDERS] } as never])
    expect(owned.get('paper')?.name).toBe('Paper')
  })

  test('document.proposals is unchanged beside it', () => {
    expect(MANIFEST.services?.[DOCUMENT_PROPOSALS]).toEqual({
      name: 'Paper',
      root: '.kehikot/paper/{epic}',
      main: 'main.tex',
      tools: { sections: 'list_sections', source: 'read_source', propose: 'propose_edit', proposals: 'list_proposals' },
    })
  })
})
