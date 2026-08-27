# Bike Shack AI — Shopify Development Store Showcase

Public code showcase of a Shopify **development/demo store** built on the Dawn theme by
[Quantum Shop Studio LLC](https://quantumshopstudio.io) through an AI-assisted,
human-reviewed workflow — every change reviewed, tested, and approved before shipping.

**▶ [Watch the video walkthrough](https://www.loom.com/share/7721a1bc7511467d85f1dadb6e733d92)** ·
[Portfolio case study](https://quantumshopstudio.io/portfolio)

## Highlights

- **Scroll-driven helmet video** (`sections/section-scroll-driven-video.liquid`) — CSS
  sticky-pin architecture: the page pins while scroll position scrubs the video; timed
  tooltips fade in at configured moments. Includes a `prefers-reduced-motion` static
  fallback and keyboard operability via native scrolling.
- **Custom product grid** (`sections/section-modern-product-grid.liquid`) — sculpted
  L-shaped card outlines in pure CSS (clip-path + border-radius), hover second-image
  reveal, full integration with Dawn's native filtering and sorting.
- **Accessibility pass** — documented outcome: zero user-facing axe violations on the
  tested pages; development aligned with WCAG 2.1 AA standards.

Built additively — custom sections, snippets, and web components only; no core Dawn
files modified. This is a snapshot export of the development store's theme for code
review purposes; it is not a maintained standalone theme.

Base theme: [Dawn](https://github.com/Shopify/dawn) by Shopify. Shopify and Liquid are
trademarks of Shopify Inc.
