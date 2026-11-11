import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import * as manifest from '../manifest.ts'

/* Modules do not name each other: text an agent or a person reads says what the other thing does.
   "Inbox" is a host term and may stay. */
const OTHERS = ['Journeys', 'References', 'Checklist', 'Paper', 'Slides', 'Citations', 'Notes', 'Learning', 'Source', 'Diff', 'Review', 'Explorer', 'Terminal', 'History', 'Orchestrator', 'Browser', 'Editor', 'Factory', 'Kanban', 'Monitor', 'Queue', 'Worktrees', 'Flows', 'Screenplay', 'Codex', 'Antigravity', 'OpenCode', 'Vibe'].filter((n) => n !== 'Paper')
const ROOT = join(import.meta.dir, '..')
const names = new RegExp(`\\b(${OTHERS.join('|')})\\b|kehikot\\.(${OTHERS.map((n) => n.toLowerCase()).join('|')})\\b|mcp__(${OTHERS.map((n) => n.toLowerCase()).join('|')})__`)
const ids = new RegExp(`kehikot\\.(${OTHERS.map((n) => n.toLowerCase()).join('|')})\\b`)

/* Lines where a capitalised everyday word is only a word, not a module. */
const PLAIN: string[] = ["View holds Source or PDF"]
const found = (text: string): string[] => text.split('\n').filter((line) => names.test(line) && !PLAIN.some((one) => line.includes(one)))
const read = (path: string): string => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : '')

describe('no module names another', () => {
  test('the manifest, its help and what agents are told', () => {
    /* Everything the manifest module exports: the manifest itself, its help, what agents are told. */
    expect(found(JSON.stringify({ ...manifest }, null, 1))).toEqual([])
  })

  test('the skills', () => {
    const dir = join(ROOT, 'plugin', 'skills')
    const skills = existsSync(dir) ? readdirSync(dir).map((one) => read(`plugin/skills/${one}/SKILL.md`)) : []
    /* allowed-tools names tools, which is functional; the prose is what is read. */
    for (const text of skills) expect(found(text.split('\n').filter((line) => !line.startsWith('allowed-tools')).join('\n'))).toEqual([])
  })

  test('the descriptions an agent reads in the code', () => {
    for (const file of ["doors.ts"]) {
      let inBlock = false
      const lines = read(file).split('\n').filter((line) => {
        const was = inBlock
        if (!inBlock && /^\s*\/\*/.test(line)) inBlock = true
        if (inBlock && line.includes('*/')) inBlock = false
        return !was && !/^\s*(\/\*|\*|\/\/)/.test(line) && !/^\s*import /.test(line)
      })
      expect(lines.filter((line) => ids.test(line))).toEqual([])
    }
  })
})

/* No other module's id, data folder or tool name anywhere in the code this module runs. Its own
   id and folder are fine; so is everything a protocol service descriptor hands it at run time. */
describe('no other module is spelled in the code', () => {
  const SELF = 'paper'
  const MODULES = [
    'paper', 'review', 'checklist', 'factory', 'flows', 'screenplay', 'journeys', 'references', 'atlas', 'citations',
    'notes', 'learning', 'source', 'diff', 'explorer', 'terminal', 'claude', 'codex', 'vibe', 'opencode', 'antigravity',
    'tests', 'history', 'orchestrator', 'notifications', 'queue', 'browser', 'slides', 'diagrams', 'editor', 'kanban', 'monitor', 'worktrees',
  ].filter((one) => one !== SELF)
  /* Tools other modules have on their doors. */
  const TOOLS = ['show_flow', 'read_flow', 'list_flows', 'write_screenplay', 'read_screenplay', 'show_question', 'list_quizzes', 'check_item', 'list_checklists', 'read_notes', 'list_slides', 'show_slide']
  const NAMES = ['Journeys', 'Slides', 'Learning', 'Screenplay', 'Flows', 'Browser', 'Checklist', 'Citations', 'Explorer', 'Orchestrator', 'Factory', 'Kanban', 'Codex', 'Antigravity', 'OpenCode', 'Vibe']
  const BANNED: { what: string; pattern: RegExp }[] = [
    ...MODULES.map((one) => ({ what: `kehikot.${one}`, pattern: new RegExp(`\\b(?:kehikot|roadmap)\\.${one}\\b`) })),
    ...MODULES.map((one) => ({ what: `.kehikot/${one}`, pattern: new RegExp(`\\.kehikot/${one}\\b`) })),
    ...TOOLS.map((one) => ({ what: one, pattern: new RegExp(`\\b${one}\\b`) })),
    /* Other modules' names that are never an everyday word here, in comments as well. */
    ...NAMES.map((one) => ({ what: one, pattern: new RegExp(`\\b${one}\\b`) })),
  ]
  const SKIP = new Set(['node_modules', 'dist', 'test', 'notes', 'docs', '.git', 'latex', 'compile'])
  const CODE = /\.(ts|tsx|js|mjs|json|html|sh)$/
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((one) => {
      if (SKIP.has(one.name) || one.name.startsWith('.')) return []
      const path = join(dir, one.name)
      if (one.isDirectory()) return walk(path)
      return CODE.test(one.name) && one.name !== 'bun.lock' ? [path] : []
    })

  test('code, manifest and skills', () => {
    const skills = existsSync(join(ROOT, 'plugin', 'skills')) ? readdirSync(join(ROOT, 'plugin', 'skills')).map((one) => join(ROOT, 'plugin', 'skills', one, 'SKILL.md')).filter(existsSync) : []
    const hits: string[] = []
    for (const file of [...walk(ROOT), ...skills]) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const { what, pattern } of BANNED) if (pattern.test(line)) hits.push(`${file.slice(ROOT.length + 1)}:${i + 1} names ${what}`)
      })
    }
    expect(hits).toEqual([])
  })
})
