import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answerAt as answer } from '../doors.ts'
import { forgetAllProposals } from '../proposals.ts'
import { hashesOf, readPaper } from '../store.ts'

/**
 * #71: a paper built two ways from one folder. `main.tex` is the preview this module reads and
 * compiles; `main_tuni.tex` is the submission, made with a template that loads the abstracts by
 * name (`\abstract{abstract_en}`) and `\input`s a file of its own. Those files take suggestions like
 * any file of the paper, and nothing outside the folder does.
 */

let root = ''
let project = ''
let paper = ''

const MAIN = ['\\documentclass{article}', '\\begin{document}', '\\include{chapters/one}', '\\end{document}', ''].join('\n')
const TUNI = [
  '\\documentclass{tuni}',
  '% \\input{commented_out}',
  '\\thesistype{Master of Science thesis}',
  '\\abstract{abstract_en}',
  '\\otherabstract{abstract_fi.tex}',
  '\\begin{document}',
  '\\input{front/keywords}',
  '\\include{chapters/one}',
  '\\end{document}',
  '',
].join('\n')

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-builds-')))
  project = join(root, 'work')
  paper = join(project, '.kehikot', 'paper', 'thesis')
  mkdirSync(join(paper, 'chapters'), { recursive: true })
  mkdirSync(join(paper, 'front'), { recursive: true })
  writeFileSync(join(paper, 'main.tex'), MAIN)
  writeFileSync(join(paper, 'main_tuni.tex'), TUNI)
  writeFileSync(join(paper, 'chapters', 'one.tex'), 'The first chapter.\n')
  writeFileSync(join(paper, 'abstract_en.tex'), 'The abstract in English, weeks behind.\n')
  writeFileSync(join(paper, 'abstract_fi.tex'), 'Tiivistelmä suomeksi.\n')
  writeFileSync(join(paper, 'front', 'keywords.tex'), 'Keywords: one, two.\n')
  writeFileSync(join(paper, 'commented_out.tex'), 'Named only in a comment.\n')
  writeFileSync(join(paper, 'scratch.tex'), 'Lying around, named by nothing.\n')
  writeFileSync(join(root, 'outside.tex'), 'Outside the paper.\n')
  forgetAllProposals()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  forgetAllProposals()
})

function tool(name: string, args: Record<string, unknown>): string {
  const reply = answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  return (reply?.body as { result?: { content?: { text?: string }[] } })?.result?.content?.[0]?.text ?? ''
}
const suggest = (file: string, find: string, replace: string) =>
  tool('propose_edit', { project, epic: 'thesis', file, find, replace, why: 'Keep the builds in step.' })
const idOf = (said: string) => said.replace(/^Filed as (\S+)\..*$/s, '$1')
const decide = (id: string, decision: string) =>
  answer('POST', '/api/proposal', new URLSearchParams({ epic: 'thesis', project }), { id, decision }, TICKET)

describe('the files of another build', () => {
  test('another root and every file it names are files of the paper, outside the reading view', () => {
    const read = readPaper('thesis', project)!
    expect(read.files).toEqual(['main.tex', 'chapters/one.tex'])
    expect(read.others).toEqual(['abstract_en.tex', 'abstract_fi.tex', 'front/keywords.tex', 'main_tuni.tex'])
    expect(Object.keys(hashesOf('thesis', project)!).sort()).toEqual(
      ['abstract_en.tex', 'abstract_fi.tex', 'chapters/one.tex', 'front/keywords.tex', 'main.tex', 'main_tuni.tex'],
    )
  })

  test('a suggestion on the submission root, or on an abstract it loads, is filed and accepted', () => {
    const onRoot = suggest('main_tuni.tex', 'Master of Science thesis', 'Master’s thesis')
    expect(onRoot).toStartWith('Filed as ')
    const onAbstract = suggest('abstract_en.tex', 'weeks behind', 'up to date')
    expect(onAbstract).toStartWith('Filed as ')
    expect(decide(idOf(onAbstract), 'accept')?.status).toBe(200)
    expect(readFileSync(join(paper, 'abstract_en.tex'), 'utf8')).toBe('The abstract in English, up to date.\n')
    expect(decide(idOf(onRoot), 'accept')?.status).toBe(200)
    expect(readFileSync(join(paper, 'main_tuni.tex'), 'utf8')).toContain('\\thesistype{Master’s thesis}')
  })

  test('a file no root names, one named only in a comment, and a path out of the folder are refused', () => {
    expect(suggest('scratch.tex', 'Lying around', 'Lying')).toContain('does not name a file called "scratch.tex"')
    expect(suggest('commented_out.tex', 'Named only', 'Named')).toContain('does not name a file')
    expect(suggest('../../../../outside.tex', 'Outside', 'Inside')).toContain('does not name a file')
  })

  test('a symbolic link in the folder is not followed out of it', () => {
    symlinkSync(join(root, 'outside.tex'), join(paper, 'linked.tex'))
    writeFileSync(join(paper, 'main_tuni.tex'), TUNI.replace('\\input{front/keywords}', '\\input{front/keywords}\\input{linked}'))
    expect(readPaper('thesis', project)!.others).not.toContain('linked.tex')
    expect(suggest('linked.tex', 'Outside', 'Inside')).toContain('does not name a file')
  })
})
