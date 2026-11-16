#!/usr/bin/env node
// Deprecated entry point. The maintained documentation builder lives at
// docs-site/build.mjs; forwarding keeps `node website/docs/build.mjs` working
// without maintaining a second, stale copy of the build algorithm.
import '../../docs-site/build.mjs';
