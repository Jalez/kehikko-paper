import { describe, expect, test } from 'bun:test'
import { DOCUMENT_PROPOSALS, documentRoot, manifestSchema, serviceDescriptor } from 'kehikot-module-protocol'

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
