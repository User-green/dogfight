/** querySelector that fails loudly instead of returning null: a missing element is a bug in index.html, not a case to handle. */
export function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
}
