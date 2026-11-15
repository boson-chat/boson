// Stands in for elkjs (and elkjs/lib/elk.bundled.js), which mermaid uses for
// its optional "elk" layouts. elkjs is EPL-2.0, which can't be combined with
// Boson's AGPL-3.0 code, so it is never bundled: vite.config.ts aliases it
// here (see ./no-elk.ts).
//
// In builds the no-elk plugin also unregisters mermaid's ELK layouts, so a
// diagram asking for `layout: elk` is drawn with the default dagre layout
// and this class is never reached. It is the backstop for the dev server
// (whose prebundled mermaid skips that plugin) or a mermaid release the
// plugin no longer matches: the diagram then fails to render with this
// error and the chat shows its source.
export const ELK_UNAVAILABLE =
  'The ELK diagram layout is not included in Boson (elkjs is EPL-2.0); use the default layout.';

export default class ELK {
  layout(): Promise<never> {
    return Promise.reject(new Error(ELK_UNAVAILABLE));
  }

  knownLayoutAlgorithms(): Promise<never> {
    return Promise.reject(new Error(ELK_UNAVAILABLE));
  }

  knownLayoutOptions(): Promise<never> {
    return Promise.reject(new Error(ELK_UNAVAILABLE));
  }

  knownLayoutCategories(): Promise<never> {
    return Promise.reject(new Error(ELK_UNAVAILABLE));
  }

  terminateWorker(): void {}
}
