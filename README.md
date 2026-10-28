# Bike Shack AI — Shopify Development Store Showcase

Public code showcase of a Shopify **development/demo store** built on the Dawn theme by
[Quantum Shop Studio LLC](https://quantumshopstudio.io) through an AI-assisted,
human-reviewed workflow — every change reviewed, tested, and approved before shipping.

**▶ [Watch the video walkthrough](https://www.loom.com/share/7721a1bc7511467d85f1dadb6e733d92)** ·
[Portfolio case study](https://quantumshopstudio.io/portfolio)

## Highlights

- **Tearable gift card cover** (`sections/section-tearable-cover.liquid`,
  `assets/tearable-cover.js`): a full-screen cloth over Shopify's native gift card page
  that visitors tear apart with mouse or touch. Verlet cloth physics rendered with
  three.js (Lambert lighting, a folded reverse side, shadows), plus wind, cursor ripples
  and an auto-clear once most of the cloth is gone. Accessible by design: a labelled
  dialog, an inert page behind it, a Reveal button and Escape, and focus handling,
  tested with a screen reader. There's a static fallback for reduced motion, no WebGL2
  or slow devices. Gift card data always comes from Shopify; three.js loads only when
  the cloth actually runs.
- **Scroll-driven helmet video** (`sections/section-scroll-driven-video.liquid`) — CSS
  sticky-pin architecture: the page pins while scroll position scrubs the video; timed
  tooltips fade in at configured moments. Includes a `prefers-reduced-motion` static
  fallback and keyboard operability via native scrolling.
- **Custom product grid** (`sections/section-modern-product-grid.liquid`) — sculpted
  L-shaped card outlines in pure CSS (clip-path + border-radius), hover second-image
  reveal, full integration with Dawn's native filtering and sorting.
- **Accessibility pass** — documented outcome: zero user-facing axe violations on the
  tested pages; development aligned with WCAG 2.1 AA standards.

Built mostly additively: custom sections, snippets and web components, plus a few
small, documented edits to Dawn files where a feature required them (the gift card
template, and the footer, newsletter, rich-text and multicolumn sections for the
accessibility pass). This is a snapshot export of the development store's theme for
code review purposes; it is not a maintained standalone theme.

Base theme: [Dawn](https://github.com/Shopify/dawn) by Shopify. Shopify and Liquid are
trademarks of Shopify Inc. Includes [three.js](https://threejs.org) r186.1 (MIT
License), vendored unmodified in `assets/three.module.js` and `assets/three.core.js`.
