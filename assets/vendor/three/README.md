# three.js r165 (vendored)

Rendering library for `/system-3d.html`, the 3D model of Chicago's sewage system.

- Upstream: https://github.com/mrdoob/three.js — release **r165**
- Licence: MIT (see `LICENSE` in this directory)
- Files: `three.module.js` (the full ES-module build, self-contained), plus the
  `examples/jsm` addons the page uses, under `addons/`:
  `controls/OrbitControls.js` and `renderers/CSS2DRenderer.js`.

Vendored rather than loaded from a CDN so the page keeps working offline, in a
`file://` checkout, and if a CDN changes or disappears. The addons import the
bare specifier `three`, which `system-3d.html` resolves with an import map.

To update: fetch the same paths from `https://unpkg.com/three@<version>/` and
bump the version here and in the page's import map comment.
