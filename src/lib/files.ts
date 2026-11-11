/**
 * Every file of a paper: `main.tex`'s own, in the order it reaches them, then the files of the
 * paper's other builds (`others`, #71) — a submission's `main_tuni.tex` and what it loads. Spelled
 * once, for the server's checks and the page's lists alike.
 */
export function filesOf(paper: { files: readonly string[]; others?: readonly string[] }): string[] {
  return [...paper.files, ...(paper.others ?? [])]
}
