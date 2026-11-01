# Project website

The project landing page is a standalone static site. It is separate from the
local application in `public/`. No install or build step is required.

## Preview

From the repository root:

```sh
python3 -m http.server 4173 --directory website --bind 127.0.0.1
```

Open `http://127.0.0.1:4173`. To check project-site paths, serve the repository
root and open `/website/` instead. All site assets and legal-page links use
relative paths, including under a GitHub Pages repository prefix.

## GitHub Pages

In the repository's **Settings → Pages → Build and deployment**, select
**GitHub Actions**. The `Deploy website to GitHub Pages` workflow publishes only
`website/` when changes to that directory or the workflow reach `main`.
It can also be started manually. Pull requests validate and package the site
without publishing it. The deployment job reports the actual live URL.

The expected default project URL is `https://pstarh.github.io/unprompted/`.
Changing the Pages settings or adding a custom domain can change that URL.
See [GitHub's custom workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Content and motion

- `index.html` contains the landing-page content and accessible interactive examples.
- `main.js` controls tabs, connection descriptions, copying commands and
  smooth anchor navigation with a ScrollTo fallback. Navigation scrolls can be
  interrupted by user input.
- `copy.js` and `i18n.js` provide one top-level English/Chinese control for the
  complete landing page and its interactive components. Language is kept only
  for the current page. English defaults remain readable without JavaScript.
- `experience.js` provides Lenis smooth wheel scrolling and a desktop result
  showcase with three ScrollTrigger stops. Touch scrolling remains native.
  Small screens and reduced-motion users keep manual result controls, and
  reduced motion disables inertia and pinning.
- `story.js` controls the spider's continuous ScrollTrigger journey along a
  visible silk rail, tied to actual component corners. It holds at the connector
  hub as the source web is woven, collects context at the evidence frame, and
  delivers the review task at the scenario result. Anchors are measured again on
  resize, including the pinned showcase's scroll distance.
- `styles.css` contains responsive layouts and reduced-motion behavior.
- `privacy.html` and `terms.html` describe the current static website and local
  application. Update them if hosting, data handling or the product model changes.
- `assets/unprompted-spider.webp` is the supplied transparent mascot. It is a
  single raster image: movement is position, scale and rotation, with no skeletal
  limb animation. Product previews are native HTML/CSS components with shared
  English and Chinese content in `components.js`, not screenshot images.
  They are pre-rendered in English for JavaScript-disabled readers and enhanced
  with language switching, editable replies, local demo approval, expandable
  evidence and downloadable text briefs. No external action is sent.
  Brand icons retain their original colors: official Google artwork for Gmail
  and Drive, SVGL artwork for Slack and Outlook, and Simple Icons for GitHub and
  Notion. See the third-party notices for provenance and licenses.
- `assets/illustrations/context-loom.webp` is a generated conceptual illustration
  showing context becoming a result. It is constrained to a supporting column.
  The attention section uses a distinct native SVG focus diagram rather than
  repeating a second generated scene. Text stays in HTML.
- GSAP, ScrollTrigger and ScrollToPlugin 3.14.2 are self-hosted in `assets/vendor/`. Their original
  notices are retained. They use the [GSAP Standard License](https://gsap.com/standard-license/),
  rather than the project's Apache license. See [third-party notices](assets/vendor/NOTICE.md).

There are no analytics, forms, external fonts, application API requests or
browser storage. Reduced motion shows a static mascot, and the footer provides
a session-only animation pause. Content and navigation remain usable with
JavaScript disabled.

The installation CTA runs the real local application with `npm start`, then
directs users to configure a model and a source. Interactive component examples
on the landing page remain isolated demonstrations.

Default sections are sized to fit laptop and mobile viewports. Result previews
keep their title and action footer visible while long body content scrolls
within the component. Explicitly expanding details can increase section height.

The header keeps language selection beside the brand, Docs and Get started as
the navigation links, and the GitHub button at the far right. Its star count
comes from `repo-stats.json`, refreshed from GitHub by
`node website/update-repo-stats.mjs` during Pages builds. The browser loads that
same-origin snapshot, so no GitHub API call or token is sent from a visitor's
browser. If GitHub is unavailable during a build, the last verified count stays.
