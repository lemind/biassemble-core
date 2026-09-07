// Shared by the prompt-variant experiments. Insert-before-one-anchor only: the replace-between-two-
// anchors form in eval-t27b-prompt-variants.ts deletes every section between them (D030 §3m).

/** Inserts `blocks` immediately before `anchor`. Throws rather than render an unspliced prompt. */
export function insertBeforeAnchor(rendered: string, anchor: string, blocks: string[]): string {
  if (blocks.length === 0) return rendered;
  const at = rendered.indexOf(anchor);
  if (at === -1) throw new Error(`Cannot splice — anchor "${anchor}" not found in the rendered prompt`);
  return `${rendered.slice(0, at)}${blocks.join("\n\n")}\n\n${rendered.slice(at)}`;
}
