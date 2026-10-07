/**
 * The starting points a new paper can be made from.
 *
 * ## Why there are templates at all, and why so few
 *
 * The preview compiles whatever the document declares. So "using another LaTeX
 * template" is not a feature of this module: a paper in `acmart`, in a
 * university's thesis class, in a journal's own `.cls` sitting beside
 * `main.tex`, already compiles and already previews, because the engine does
 * that and this module does not stand between them.
 *
 * What a template is FOR, then, is only the first minute — the moment an epic
 * has no paper and somebody wants one that is not an empty `article`. Two
 * roads, and both are just files being put in a folder:
 *
 *  - **A built-in**, below. Four of them, each a class every TeX distribution
 *    carries, each small enough to read in one screen. They are deliberately
 *    not a gallery: a module that shipped forty journal templates would be a
 *    module forty journals could silently outdate.
 *  - **A folder the person points at** (`startFrom` in `store.ts`). That is the
 *    real answer for a venue's template: download it, point here, and it is
 *    copied in as the paper.
 *
 * ## What is deliberately not here: conversion
 *
 * Nothing moves a paper from one template to another. A class is a set of
 * macros, two classes disagree about what `\author` takes, and a converter that
 * is right for the title block is wrong for the first paper that uses
 * `\affiliation`. Changing template is editing `\documentclass` and fixing what
 * the engine then says, with the PDF beside it — which is what the rest of
 * this module is for.
 *
 * ## Strings, not files on disk
 *
 * The built-ins are constants in this file rather than a `templates/` folder
 * read at run time. They are a few dozen lines each, a test can compile-check
 * their shape without touching the disk, and there is then no path joined onto
 * this module's own directory anywhere — which is the one thing the storage
 * rule in this workspace says a module must not grow.
 */

export interface TemplateFile {
  /** Relative to the paper's folder. Forward slashes, no `..`. */
  path: string
  text: string
}

export interface Template {
  id: string
  name: string
  /** One sentence for the picker: what it is for, and what class it uses. */
  about: string
  files(title: string): TemplateFile[]
}

/** A title that is safe inside `\title{…}`: no character that would end the group or start a command. */
export function titleFor(epic: string): string {
  const words = epic.replace(/[-_]+/g, ' ').replace(/[\\{}$&#^~%]/g, '').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Untitled'
}

const BIB = [
  '@book{lamport1994,',
  '  author    = {Leslie Lamport},',
  '  title     = {{\\LaTeX}: A Document Preparation System},',
  '  publisher = {Addison-Wesley},',
  '  year      = {1994},',
  '  edition   = {2},',
  '}',
  '',
].join('\n')

const article: Template = {
  id: 'article',
  name: 'Article',
  about: 'One file, the standard article class. The smallest thing that compiles.',
  files: (title) => [
    {
      path: 'main.tex',
      text: [
        '\\documentclass[11pt,a4paper]{article}',
        '',
        '\\usepackage{graphicx}',
        '\\usepackage{booktabs}',
        '',
        `\\title{${title}}`,
        '\\author{}',
        '\\date{\\today}',
        '',
        '\\begin{document}',
        '',
        '\\maketitle',
        '',
        '\\begin{abstract}',
        'What this paper claims, in a paragraph.',
        '\\end{abstract}',
        '',
        '\\section{Introduction}',
        '',
        'Start here.',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
    },
  ],
}

const parts: Template = {
  id: 'parts',
  name: 'Article in parts',
  about: 'An article whose sections are separate files pulled into main.tex, with a bibliography. For a paper several hands work on.',
  files: (title) => [
    {
      path: 'main.tex',
      text: [
        '\\documentclass[11pt,a4paper]{article}',
        '',
        '\\usepackage{graphicx}',
        '\\usepackage{booktabs}',
        '',
        `\\title{${title}}`,
        '\\author{}',
        '\\date{\\today}',
        '',
        '\\begin{document}',
        '',
        '\\maketitle',
        '',
        '\\begin{abstract}',
        'What this paper claims, in a paragraph.',
        '\\end{abstract}',
        '',
        '\\input{sections/introduction}',
        '\\input{sections/method}',
        '\\input{sections/results}',
        '\\input{sections/discussion}',
        '',
        '\\bibliographystyle{plain}',
        '\\bibliography{references}',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
    },
    { path: 'sections/introduction.tex', text: '\\section{Introduction}\n\nWhy this matters, and what is already known~\\cite{lamport1994}.\n' },
    { path: 'sections/method.tex', text: '\\section{Method}\n\nWhat was done.\n' },
    { path: 'sections/results.tex', text: '\\section{Results}\n\nWhat was found.\n' },
    { path: 'sections/discussion.tex', text: '\\section{Discussion}\n\nWhat it means, and what it does not.\n' },
    { path: 'references.bib', text: BIB },
  ],
}

const ieee: Template = {
  id: 'ieee',
  name: 'IEEE conference',
  about: 'Two columns in the IEEEtran class, as IEEE conferences ask for, with a bibliography.',
  files: (title) => [
    {
      path: 'main.tex',
      text: [
        '\\documentclass[conference]{IEEEtran}',
        '',
        '\\usepackage{graphicx}',
        '\\usepackage{booktabs}',
        '\\usepackage{cite}',
        '',
        `\\title{${title}}`,
        '',
        '\\author{\\IEEEauthorblockN{First Author}',
        '\\IEEEauthorblockA{Affiliation \\\\ City, Country \\\\ email@example.org}}',
        '',
        '\\begin{document}',
        '',
        '\\maketitle',
        '',
        '\\begin{abstract}',
        'What this paper claims, in a paragraph.',
        '\\end{abstract}',
        '',
        '\\begin{IEEEkeywords}',
        'first keyword, second keyword',
        '\\end{IEEEkeywords}',
        '',
        '\\section{Introduction}',
        '',
        'Start here~\\cite{lamport1994}.',
        '',
        '\\section{Conclusion}',
        '',
        'End here.',
        '',
        '\\bibliographystyle{IEEEtran}',
        '\\bibliography{references}',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
    },
    { path: 'references.bib', text: BIB },
  ],
}

const report: Template = {
  id: 'report',
  name: 'Report or thesis',
  about: 'Chapters in their own files in the report class, with a table of contents and a bibliography.',
  files: (title) => [
    {
      path: 'main.tex',
      text: [
        '\\documentclass[12pt,a4paper]{report}',
        '',
        '\\usepackage{graphicx}',
        '\\usepackage{booktabs}',
        '',
        `\\title{${title}}`,
        '\\author{}',
        '\\date{\\today}',
        '',
        '\\begin{document}',
        '',
        '\\maketitle',
        '',
        '\\begin{abstract}',
        'What this work claims, in a paragraph.',
        '\\end{abstract}',
        '',
        '\\tableofcontents',
        '',
        '\\include{chapters/introduction}',
        '\\include{chapters/background}',
        '\\include{chapters/conclusion}',
        '',
        '\\bibliographystyle{plain}',
        '\\bibliography{references}',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
    },
    { path: 'chapters/introduction.tex', text: '\\chapter{Introduction}\n\nWhat the question is.\n' },
    { path: 'chapters/background.tex', text: '\\chapter{Background}\n\nWhat is already known~\\cite{lamport1994}.\n' },
    { path: 'chapters/conclusion.tex', text: '\\chapter{Conclusion}\n\nWhat was learned.\n' },
    { path: 'references.bib', text: BIB },
  ],
}

export const TEMPLATES: readonly Template[] = [article, parts, ieee, report]

export function templateById(id: string): Template | null {
  return TEMPLATES.find((one) => one.id === id) ?? null
}

/** What the picker needs: no file contents, which it has no use for. */
export function templateList(): { id: string; name: string; about: string }[] {
  return TEMPLATES.map(({ id, name, about }) => ({ id, name, about }))
}
