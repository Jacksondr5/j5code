# J5 Code marketing site

The public site for J5 Code at https://j5.codes. This directory replaces upstream's T3 Code
marketing site wholesale (see FORK.md, "Replaced wholesale"); only the fonts and harness marks
are upstream's.

- `vp run dev:marketing` serves it on port 4173.
- `vp run build:marketing` writes `dist/`.
- Deployed by Vercel from this directory; `vercel.ts` carries the install and build commands.

Status words on the site are deliberate: **Underway** means shipped, **Charted** means defined in
`docs/j5/product` and being built, **Horizon** means direction. The upstream pin and the size of
the integration inventory are read from `FORK.md` at build time.
