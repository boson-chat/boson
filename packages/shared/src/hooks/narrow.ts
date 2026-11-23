// A phone, or any window too narrow for the side-by-side layout (server
// rail, channels, chat and members): the chat layout shows one pane at a
// time below this width. Tablets and desktop windows keep the full layout.
// A phone turned on its side is wider than that but much shorter: it keeps
// the phone layout too (a touch screen under 500px tall). Keep in step with
// the CSS @media queries that use the same breakpoint.
export const NARROW_QUERY = '(max-width: 700px), (max-height: 500px) and (pointer: coarse)';
