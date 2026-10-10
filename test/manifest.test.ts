import { describe, expect, test } from 'bun:test'
import { PROTOCOL, manifestSchema } from 'kehikot-module-protocol'

import { ID, MANIFEST } from '../manifest.ts'

/**
 * The manifest is the only half of this program a host reads, so the things
 * that can silently make a module unusable are checked here rather than
 * discovered in somebody else's log.
 */
describe('what this app claims about itself', () => {
  test('it is protocol 2, which is the whole reason this module was rewritten', () => {
    /* The module this was extracted from declared 1. A host running 2 framed it
       as incompatible and never greeted it: a container that loads a page and then
       refuses to talk to it, for a reason visible only on the host's side. */
    expect(MANIFEST.protocol).toBe(PROTOCOL)
    expect(PROTOCOL).toBe(2)
    expect(MANIFEST.declares.protocol).toBe(`>=2 <3`)
  })

  test('its mode is scoped to an epic, in protocol 2’s word for it', () => {
    /* `journey` was protocol 1's spelling and is what raised the number. An
       epic-scoped mode is the only kind that is told which epic is open, which
       is the only thing this app needs to know. */
    expect(MANIFEST.modes).toHaveLength(1)
    expect(MANIFEST.modes[0]?.scope).toBe('epic')
  })

  test('it declares storage, because it serves its own /api', () => {
    /*
     * Without this the host frames the page opaque, its fetches of its own
     * `/api` are cross-origin, and the server would have to answer everything
     * with a permissive `Access-Control-Allow-Origin` — which is an invitation
     * to every page in every tab to read this origin. That combination, in
     * front of a write path, is what was wrong with the program this replaces.
     */
    expect(MANIFEST.declares.storage).toBe(true)
  })

  test('it asks to say where the reader is pointing and which files are on screen, and to have one line kept for it, and for nothing else', () => {
    /* Which epic is open is not in this list because it is not a capability: it
       arrives on the greeting to every module whatever it declared. What IS
       here is the one thing this app asks permission to do to its neighbours —
       put a path, a page, a byte range and a paragraph of somebody's document
       into the context every container on the canvas is told — and, beside
       that one place, which files of the paper are on screen. `state:keep`
       touches no neighbour: it is the open file and tab, handed back to this
       module alone so a paper opens where its reader left it. */
    expect(MANIFEST.declares.uses).toEqual(['passage:set', 'showing:set', 'state:keep'])
    expect(MANIFEST.declares.prompt).toBe(false)
  })

  test('it does not ask for the epic list, and the removal is deliberate', () => {
    /* `epics:read` was declared for a picker that is gone. A capability asked
       for and never used is a request somebody has to grant and re-evaluate for
       a program that will not call the method. */
    expect(MANIFEST.declares.uses).not.toContain('epics:read')
    /* And not the selection either, which is a different offer: refs, looked up
       in a tracker by whoever receives them. A byte range posted into that
       field would be handed to Journeys and to References as though it were an
       issue, and each would fail to find it silently. */
    expect(MANIFEST.declares.uses).not.toContain('selection:set')
  })

  test('it says it moves for the picked parts of the epic, and for a passage, and sets neither of them itself', () => {
    /* `parts`: the page narrows to the files and pages of the parts a person
       picked in the host's bar. `passage`: it always turned to one, and this
       manifest had no `reacts` to say so. Neither is a capability — picking a
       part is the host's own control, and reading a context needs no leave. */
    expect(MANIFEST.reacts).toEqual(['passage', 'parts'])
    expect(MANIFEST.declares.uses).not.toContain('parts:set')
  })

  test('the id is the one the registration file has to be named after', () => {
    expect(ID).toBe('kehikot.paper')
    expect(MANIFEST.id).toBe(ID)
  })

  test('a host running the protocol’s own schema over it accepts it', () => {
    /* The package is explicit that its schemas are a convenience and never the
       host's check — the host runs its own copy over what arrives on the wire.
       Running it here is the cheapest way to learn this file is wrong at the
       moment it is edited. */
    expect(() => manifestSchema.parse(MANIFEST)).not.toThrow()
  })
})
