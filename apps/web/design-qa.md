# Goah website design QA

- Selected logo reference: `/var/folders/gq/tm7_y1js0nd03vjg61sb_66c0000gn/T/codex-clipboard-fe4a69b8-e3ad-4d5f-82fc-84c3d417375a.png`
- Implementation: `http://127.0.0.1:3210/`
- Desktop screenshot: `/tmp/goah-bubble-desktop-final.png`
- Mobile screenshot: `/tmp/goah-bubble-mobile-final.png`
- Focused logo comparison: `/tmp/goah-logo-reference-comparison.png`
- Desktop verification viewport: 1440 × 900 CSS px
- Mobile verification viewport: 390 × 844 CSS px
- State: initial hero, light theme, fluid bubble and grain animation active

## Visual target and adaptation

The selected cobalt orbital mark is used directly as the brand asset; it is not redrawn or approximated. The earlier particle ring is replaced with the two supplied visual languages: a slow fluid bubble field provides motion, while a restrained noisy gradient supplies surface texture. The hero keeps product explanation and actions to the left on desktop, then stacks copy above the visual core on mobile.

## Focused comparison evidence

- The supplied alpha PNG is copied unchanged to `public/goah-orbital-mark.png`.
- Shape, stroke proportions, central dot, cobalt color, and transparency match the selected reference.
- The hero mark is centered inside the circular fluid core without a rectangular image background.
- Header and footer use the same source asset at compact sizes.
- Desktop reading order is headline → explanation → actions → motion component.
- Mobile reading order is preserved in the DOM and the complete component remains visible in the first viewport.
- Hero display type now tops out at 76px rather than 96px; each sentence remains one line whenever the available width permits.
- Section display sizes and tracking were reduced to the same restrained type scale.

## Responsive evidence

- Desktop uses an asymmetric two-column hero. The fluid core sits at 72% of the hero width so it supports rather than obscures the copy.
- Mobile keeps the 390 × 844 first viewport self-contained: header, headline, explanation, both actions, and the orbital component are visible before the next section.
- No horizontal overflow was observed at either viewport.
- The logo is centered by the core's own layout grid and optically corrected for the PNG's asymmetric transparent padding.

## Interaction and technical checks

- Primary action resolves to `#start`.
- GitHub action resolves to `https://github.com/billc8128/opengoah`.
- Browser console has no application warnings or errors.
- Production build and TypeScript checks pass.
- Impeccable layout detector reports no findings.
- `prefers-reduced-motion` retains the textured composition while stopping spatial loops and noise refresh.
- Motion pauses when the visual core leaves the viewport or the document becomes hidden.
- A 1.6-second frame comparison found 144,383 changed pixels, all bounded to the visual core region; surrounding copy and layout remained unchanged.

## Follow-up polish

- P3: the live grain texture is randomized, so screenshots do not reproduce identical noise pixels. Palette, core geometry, logo position, and motion bounds remain stable.

final result: passed
