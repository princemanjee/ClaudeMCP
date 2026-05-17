# Admin UI icons

Plan 12 ships icons as inline-SVG string constants in `../app.js` under the
`ICONS` object. The reasons for not shipping standalone `.svg` files here:

1. **No build step.** Vanilla browsers cannot `import` non-JS modules without a
   bundler. We could load each `.svg` via `fetch()`, but every icon becomes a
   second network round-trip on first render.
2. **No icon font.** A font shipped here would add a binary asset + a
   `@font-face` declaration; inline SVG is simpler and themes via
   `fill="currentColor"` for free.
3. **No external image requests.** The spec mandates "no external image
   requests beyond the Alpine.js CDN."

## Adding an icon

1. Find or hand-draw a 24×24 SVG.
2. Strip the `width` / `height` attributes; keep `viewBox="0 0 24 24"`.
3. Use `fill="currentColor"` or `stroke="currentColor"` so it picks up CSS color.
4. Paste the resulting markup as a new entry in `../app.js`'s `ICONS` object.
5. Reference it from a template via `x-html="ICONS.your_icon_name"`.

## Future evolution

If the icon set grows past ~30 entries, consider migrating to a separate
`icons.js` module imported by `app.js` (still a single script load, but
separated for readability).
