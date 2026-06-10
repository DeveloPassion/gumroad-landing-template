# Gumroad Landing Template — Knowii / DeveloPassion

Brand-aligned generator for **Gumroad custom HTML product landing pages**. Given a product
slug, it pulls that product's data from the store as the single source of truth and emits one
self-contained, sanitizer-safe HTML file ready to publish to Gumroad.

## Single source of truth

All product data — names, prices, sales copy (PAS, benefits, transformation, FAQ…),
testimonials, media, and bundle `includedProducts` — lives in
[`DeveloPassion/store-website`](https://github.com/DeveloPassion/store-website) under
`src/data/products/`. This template **reads from there at render time** (GitHub raw, public,
no auth). It never duplicates copy. Update the store, re-render, re-publish.

## Usage

```sh
node render.mjs <product-slug>
# e.g.
node render.mjs journaling-deep-dive
node render.mjs everything-knowledge-bundle --out dist/ekb.html --ref main
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--out <file>` | `dist/<slug>.html` | output path |
| `--ref <git-ref>` | `main` | store-website branch/tag to read |
| `--store <owner/repo>` | `DeveloPassion/store-website` | source repo |
| `--site <url>` | `https://store.dsebastien.net` | base for absolute link URLs |
| `--cover <url>` | (none) | the product's **own Gumroad cover** for the hero (`gumroad products view <id>` → `.product.covers[0].url`). Needed for a hero image — external/store image hosts are blocked live. |
| `--local <path>` | (none) | read product data from a local store-website checkout instead of GitHub raw (renders copy that isn't pushed yet) |
| `--media-map <file>` | (none) | JSON mapping store media URL basenames (e.g. `"osk-ai-base.webp"`) to the product's **own** Gumroad asset URLs — enables a real screenshot gallery (see below) |
| `--youtube <text>` | (none) | YouTube channel shown as **copyable text** in the gallery section (e.g. `youtube.com/@dsebastien`) — the sandbox can't link out, so discovery happens via text |
| `--videos <n>` | `3` | number of store videos listed as copyable `youtu.be/<id>` text in the gallery card |
| `--testimonials <n>` | `0` (all) | cap the testimonial masonry wall |
| `--early-shots <n>` | `2` | screenshots surfaced right below the hero/stats band (excluded from the later gallery) |

Conversion structure baked in: variant buy buttons in the hero, sticky buybar, and final CTA; a
"Choose your package" tier-comparison section (top tier badged "Best value"); CTA bands after the
PAS block and after the testimonial wall; and a click-to-zoom lightbox on all screenshots
(inline JS — survives the sanitizer).
| `--template <file>` | `./template.html` | brand shell |

No dependencies. Node ≥ 18 (global `fetch`).

> **Sandbox rules (verified live):** the page can't load external image hosts AND can't navigate
> to external links — `<a href>` to YouTube/store/anywhere is dead. The renderer therefore:
> **(1)** flattens all markdown links in copy to plain text, **(2)** emits no YouTube link-outs,
> **(3)** renders a screenshot gallery only from images mapped via `--media-map` to the product's
> own assets. To build that map, upload screenshots as product covers (max **8 covers** per
> product, JPEG/PNG/GIF only — no WebP):
>
> ```sh
> gumroad products covers add <id> --image ./screenshot.png --json --jq '.result.covers[-1].url'
> ```
>
> then map each store media basename to the returned `public-files.gumroad.com` URL.
>
> **More image slots beyond the 8-cover cap:** the live CSP allows `img-src` for the WHOLE
> `public-files.gumroad.com` host, so images uploaded through the **product description editor**
> (also hosted there) are equally usable in the map.
>
> **YouTube embeds do NOT work** even though `frame-src` allows youtube/youtube-nocookie: the
> page's `sandbox` lacks `allow-same-origin`, that restriction propagates into nested iframes,
> and the YouTube player JS crashes (`writeEmbed is not defined`). Verified live — videos must
> be plain-text pointers.

## Publishing to Gumroad

```sh
# preview runs Gumroad's server-side sanitizer WITHOUT writing — always check the report
gumroad products page preview <gumroad-product-id> dist/<slug>.html --json --no-input
# publish
gumroad products page publish <gumroad-product-id> dist/<slug>.html --json --no-input
# revert to Gumroad's default layout
gumroad products page clear   <gumroad-product-id> --yes
```

### Sanitizer contract (important)

Gumroad sanitizes custom HTML server-side and **may strip `<script>`** — including the Tailwind
Play CDN. The output therefore ships a **brand `<style>` fallback** (dark bg, brand colors, `.btn`,
`.card`) so the page stays legible and on-brand even if Tailwind is dropped. After `preview`,
inspect `.sanitization_report`; for full Tailwind fidelity when the CDN is stripped, compile the
classes to static CSS (`npx @tailwindcss/cli -i in.css -o out.css --minify`) and paste into the
`<style>` block, then re-preview. **No JS beyond the Tailwind runtime** is ever emitted.

### Live Gumroad attributes

CTAs use Gumroad's data attributes so name/price/checkout stay live:
`data-gumroad-field="name|price|description"`, `data-gumroad-action="buy"`. Buy CTAs are anchors so
production injects the checkout href.

## Brand

Tokens mirror `DeveloPassion/store-website` `src/styles/index.css` (dark theme): brand `#e5007d`,
brand-text `#ff1493`, bg `#37404c`, surface `#3f4957`, PAS accents red/amber/green, Noto Sans.

## Files

- `template.html` — brand shell (head, Tailwind config, `<style>` fallback, sticky buy bar, `PAGE_CONTENT` slot)
- `render.mjs` — fetch + bind + emit (section order mirrors the store product page)
- `dist/` — generated output (git-ignored)

## Used by

The `developassion-publish --target landing-page --publish` skill clones this repo at run time,
renders the requested product, then previews + publishes to Gumroad.
