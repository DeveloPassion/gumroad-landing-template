#!/usr/bin/env node
/**
 * Gumroad landing-page renderer for DeveloPassion / Knowii products.
 *
 * Single source of truth: DeveloPassion/store-website (PUBLIC) — product data,
 * sales copy, testimonials, FAQ, media, and included-product lists all live there
 * under src/data/products/. This script fetches that data from GitHub raw, binds it
 * into template.html, and emits ONE self-contained, sanitizer-safe HTML file ready
 * for `gumroad products page publish`.
 *
 * Usage:
 *   node render.mjs <product-slug> [options]
 *   node render.mjs journaling-deep-dive --out dist/journaling-deep-dive.html
 *
 * Options:
 *   --out <file>     output path (default: dist/<slug>.html)
 *   --ref <git-ref>  store-website ref to read from (default: main)
 *   --store <owner/repo>  store repo (default: DeveloPassion/store-website)
 *   --local <path>   read product data from a local store-website checkout instead of
 *                    GitHub raw (path to the repo root; reads <path>/src/data/products).
 *                    Useful to render copy that isn't pushed yet.
 *   --site <url>     store site for absolute asset/link URLs (default: https://store.dsebastien.net)
 *   --media-map <file>  JSON object mapping store media URL basenames (e.g. "osk-ai-base.webp")
 *                    to the product's OWN Gumroad asset URLs (upload screenshots with
 *                    `gumroad products covers add <id> --image <png>` → .result.covers[-1].url).
 *                    Only mapped images are rendered — external image hosts are blocked live.
 *   --template <file>  template shell (default: ./template.html next to this script)
 *
 * No dependencies. Node >= 18 (global fetch). Never emits JS beyond the Tailwind runtime.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ---- args ----
const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
if (!slug) {
  console.error('Usage: node render.mjs <product-slug> [--out f] [--ref main] [--store o/r] [--site url]');
  process.exit(1);
}
const REF = opt('ref', 'main');
const STORE = opt('store', 'DeveloPassion/store-website');
const SITE = opt('site', 'https://store.dsebastien.net').replace(/\/$/, '');
const OUT = opt('out', `dist/${slug}.html`);
const TEMPLATE = opt('template', join(__dir, 'template.html'));
// The live Gumroad page is sandboxed: external image hosts are blocked. Pass the product's OWN
// Gumroad cover URL (from `gumroad products view <id>` → .product.covers[0].url, on
// public-files.gumroad.com) via --cover so the hero image actually loads. Store-website
// /assets images are external and are therefore omitted from the output.
const COVER = opt('cover', '');
const LOCAL = opt('local', '');
const MEDIA_MAP_FILE = opt('media-map', '');
// Sandbox blocks outbound links, so the channel is surfaced as copyable TEXT, not an anchor.
const YOUTUBE = opt('youtube', '');
// ⚠ YouTube embeds do NOT work despite frame-src allowing youtube-nocookie: the page's
// sandbox lacks allow-same-origin, that restriction propagates into nested iframes, and the
// YouTube player JS crashes (writeEmbed undefined, cache SecurityError). Verified live.
// Videos are therefore surfaced as a copyable-text list. Number of videos to list:
const LIST_VIDEOS = parseInt(opt('videos', '3'), 10) || 0;
// Max testimonials to render (0 = all). Social proof at full strength by default.
const TESTIMONIALS = parseInt(opt('testimonials', '0'), 10) || 0;
const RAW = `https://raw.githubusercontent.com/${STORE}/${REF}/src/data/products`;

// ---- fetch helpers ----
async function getJson(file) {
  if (LOCAL) {
    try {
      return JSON.parse(await readFile(join(LOCAL, 'src/data/products', file), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  const url = `${RAW}/${file}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetch ${url} -> ${res.status}`);
  return res.json();
}

// ---- store template tokens ----
// Store copy embeds runtime tokens like ${stats.userCount}, ${computed.averageRating|round:1},
// ${product.variants.0.price|currency}. The store site resolves them at render time; we must
// do the same or they leak verbatim onto the Gumroad page. Unresolvable tokens are left as-is
// (visible in review) rather than silently dropped.
function interpolate(value, ctx) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}|]+)(?:\|([^}]+))?\}/g, (m, path, filter) => {
      const v = path
        .trim()
        .split('.')
        .reduce((o, k) => (o == null ? undefined : o[k]), ctx);
      if (v == null) return m;
      let out = v;
      if (filter) {
        const [fname, farg] = filter.split(':');
        if (fname === 'currency') out = `€${Number(v).toFixed(2)}`;
        else if (fname === 'round') out = Number(v).toFixed(Number(farg ?? 0));
      }
      return String(out);
    });
  }
  if (Array.isArray(value)) return value.map((x) => interpolate(x, ctx));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, interpolate(x, ctx)]));
  return value;
}

// ---- text / markdown ----
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Minimal inline markdown used in the store copy: **bold**, *italic*, `code`, [text](url).
// The Gumroad sandbox blocks ALL external link navigation, so [text](url) is flattened to
// its label — a dead <a> is worse than plain text.
function md(s) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\((?:\/[^)]+|https?:\/\/[^)]+)\)/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t;
}

// ---- section helpers ----
const section = (inner, cls = '') =>
  inner ? `<section class="px-5 py-16 ${cls}"><div class="max-w-3xl mx-auto">${inner}</div></section>` : '';
const h2 = (t) => `<h2 class="text-3xl font-extrabold tracking-tight text-center mb-8">${esc(t)}</h2>`;
const ul = (arr, cls = 'checks') =>
  Array.isArray(arr) && arr.length
    ? `<ul class="space-y-2 ${cls}">${arr.map((x) => `<li class="text-white/80">${md(x)}</li>`).join('')}</ul>`
    : '';
const cards3 = (items, render) =>
  `<div class="grid md:grid-cols-3 gap-5">${items.map(render).join('')}</div>`;

// ---- builders (each returns '' when its data is absent) ----
// One buy CTA per store variant (checkout opens pre-selected via data-gumroad-option),
// falling back to a single generic buy button when the product has no variants.
function buyCtas(p, label = 'Get it now') {
  const variants = Array.isArray(p.variants) ? p.variants.filter((v) => v && v.name) : [];
  if (variants.length > 1) {
    return `<div class="flex flex-wrap gap-4 justify-center">${variants
      .map((v) => {
        const vp = v.priceDisplay || (v.price != null ? `€${v.price}` : '');
        return `<a class="btn" data-gumroad-action="buy" data-gumroad-option="${esc(v.name)}">${esc(v.name)}${
          vp ? ` &mdash; ${esc(vp)}` : ''
        }</a>`;
      })
      .join('')}</div>`;
  }
  const price = p.priceDisplay || (p.price != null ? `€${p.price}` : '');
  return `<a class="btn" data-gumroad-action="buy">${esc(label)} &mdash; <span data-gumroad-field="price">${esc(price)}</span></a>`;
}

function stars(avg) {
  if (typeof avg !== 'number') return '';
  return '★★★★★'.slice(0, Math.round(avg)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(avg));
}

function buildHero(p, sc, coverUrl, ctx = {}) {
  const tagline = sc.tagline || p.name;
  const sub = sc.secondaryTagline || sc.description || p.shortDescription || '';
  // Only the product's own Gumroad cover (passed via --cover) — external hosts are blocked live.
  const img = coverUrl
    ? `<img src="${esc(coverUrl)}" alt="${esc(p.name)}" class="max-w-full rounded-2xl mt-12 mx-auto shadow-2xl" style="box-shadow:0 24px 80px rgba(229,0,125,.25)">`
    : '';
  const badges = Array.isArray(sc.trustBadges) && sc.trustBadges.length
    ? `<div class="flex flex-wrap gap-3 justify-center mt-7">${sc.trustBadges
        .map((b) => `<span class="pill">${md(b)}</span>`)
        .join('')}</div>`
    : '';
  const avg = ctx.computed && ctx.computed.averageRating;
  const proofBits = [
    avg ? `<span class="text-amber-400">${stars(avg)}</span> ${avg.toFixed(1)}/5 (${ctx.computed.ratingCount} ratings)` : '',
    ctx.stats && ctx.stats.userCount ? `${esc(ctx.stats.userCount)} users` : '',
  ].filter(Boolean);
  const proof = proofBits.length
    ? `<p class="text-white/70 text-sm mt-5">${proofBits.join(' &nbsp;·&nbsp; ')}</p>`
    : '';
  return `<section class="hero-bg text-center px-5 pt-24 pb-16"><div class="max-w-3xl mx-auto">
    <span class="kicker">${esc(p.name)}</span>
    <h1 class="text-4xl md:text-6xl font-extrabold tracking-tight mb-4" data-gumroad-field="name">${esc(tagline)}</h1>
    <p class="text-lg md:text-xl text-white/70 max-w-2xl mx-auto mb-8">${md(sub)}</p>
    ${buyCtas(p)}
    ${proof}${badges}${img}
  </div></section>`;
}

function buildStatsBand(ctx) {
  const cells = [];
  if (ctx.stats && ctx.stats.userCount)
    cells.push(`<div class="card text-center"><div class="statnum">${esc(ctx.stats.userCount)}</div><div class="text-white/70 mt-1">happy users</div></div>`);
  if (ctx.computed && ctx.computed.averageRating)
    cells.push(`<div class="card text-center"><div class="statnum">${ctx.computed.averageRating.toFixed(1)}/5</div><div class="text-white/70 mt-1">average rating <span class="text-amber-400">${stars(ctx.computed.averageRating)}</span></div></div>`);
  if (ctx.stats && ctx.stats.timeSaved) {
    // lead with the first numeric chunk ("100+"), keep the rest as the label — no emoji
    // (emoji glyphs are font-dependent and can render as tofu boxes)
    const mTime = String(ctx.stats.timeSaved).match(/^([\d,.]+\+?)\s*(.*)$/);
    const num = mTime ? mTime[1] : '—';
    const rest = mTime ? mTime[2] : String(ctx.stats.timeSaved);
    cells.push(`<div class="card text-center"><div class="statnum">${esc(num)}</div><div class="text-white/70 mt-1">${esc(rest)} saved</div></div>`);
  }
  if (!cells.length) return '';
  return `<section class="px-5 py-10"><div class="max-w-3xl mx-auto"><div class="grid md:grid-cols-${Math.min(cells.length, 3)} gap-5">${cells.join('')}</div></div></section>`;
}

function buildContents(p) {
  if (!Array.isArray(p.contents) || !p.contents.length) return '';
  const half = Math.ceil(p.contents.length / 2);
  const col = (items) => `<div class="card">${ul(items)}</div>`;
  return section(
    `${h2("What's inside")}<div class="grid md:grid-cols-2 gap-5">${col(p.contents.slice(0, half))}${col(
      p.contents.slice(half)
    )}</div>`
  );
}

function buildMethodology(sc) {
  const m = sc.storytelling && sc.storytelling.methodology;
  if (!m || !Array.isArray(m.steps) || !m.steps.length) return '';
  const cards = m.steps
    .map(
      (s) =>
        `<div class="card">${s.icon ? `<div class="text-3xl mb-2">${esc(s.icon)}</div>` : ''}<h3 class="text-lg font-bold mb-2">${esc(
          s.title
        )}</h3><p class="text-white/75 text-sm">${md(s.description)}</p></div>`
    )
    .join('');
  const extras = [m.philosophy, m.differentiation]
    .filter(Boolean)
    .map((t) => `<p class="text-white/80 mt-6 max-w-2xl mx-auto text-center">${md(t)}</p>`)
    .join('');
  return section(`${h2(m.title || 'The philosophy')}<div class="grid md:grid-cols-3 gap-5">${cards}</div>${extras}`);
}

function buildVision(sc) {
  const v = sc.storytelling && sc.storytelling.vision;
  if (!v || !Array.isArray(v.values) || !v.values.length) return '';
  const cards = v.values
    .map(
      (x) =>
        `<div class="card">${x.icon ? `<div class="text-3xl mb-2">${esc(x.icon)}</div>` : ''}<h3 class="text-lg font-bold mb-2">${esc(
          x.title
        )}</h3><p class="text-white/75 text-sm">${md(x.description)}</p></div>`
    )
    .join('');
  const mission = v.mission ? `<p class="text-white/80 mb-8 max-w-2xl mx-auto text-center">${md(v.mission)}</p>` : '';
  return section(`${h2(v.title || 'Where this takes you')}${mission}<div class="grid md:grid-cols-2 gap-5">${cards}</div>`);
}

function buildPAS(sc) {
  const block = (label, color, text, points, marker) => {
    if (!text && !(points && points.length)) return '';
    return `<div class="card mb-4 border-l-4" style="border-left-color:${color}">
      <h3 class="text-xl font-bold mb-2">${esc(label)}</h3>
      ${text ? `<p class="text-white/80 mb-3">${md(text)}</p>` : ''}${ul(points, marker)}
    </div>`;
  };
  const inner =
    block('The problem', '#ef4444', sc.problem, sc.problemPoints, 'crosses') +
    block('Why it hurts', '#f59e0b', sc.agitate, sc.agitatePoints, 'warns') +
    block('The solution', '#10b981', sc.solution, sc.solutionPoints, 'checks');
  return inner.trim() ? section(inner) : '';
}

function buildStory(sc) {
  const st = sc.credibilityStory || sc.storytelling;
  if (!st) return '';
  if (typeof st === 'string')
    return section(`<div class="card"><p class="text-white/80">${md(st)}</p></div>`);
  // store-website storytelling object: render the narrative blocks that carry prose
  const blocks = [st.originStory, st.creatorJourney]
    .filter((b) => b && b.story)
    .map(
      (b) =>
        `<div class="card mb-4">${
          b.title ? `<h3 class="text-xl font-bold mb-1">${esc(b.title)}</h3>` : ''
        }${b.subtitle ? `<p class="text-brand-text font-bold mb-3">${esc(b.subtitle)}</p>` : ''}<p class="text-white/80">${md(
          b.story
        )}</p></div>`
    )
    .join('');
  return blocks ? section(blocks) : '';
}

function buildList(title, arr, opts = {}) {
  if (!Array.isArray(arr) || !arr.length) return '';
  const items = arr
    .map((x) =>
      typeof x === 'object'
        ? `<li class="text-white/80"><strong>${md(x.item || x.title || x.myth || '')}</strong>${
            x.description || x.truth ? ` — ${md(x.description || x.truth)}` : ''
          }</li>`
        : `<li class="text-white/80">${md(x)}</li>`
    )
    .join('');
  return section(`${h2(title)}<ul class="space-y-2 max-w-2xl mx-auto">${items}</ul>`, opts.cls);
}

function buildBenefits(sc) {
  const b = sc.benefits;
  if (!b || typeof b !== 'object') return '';
  const cols = [
    ['Right away', b.immediate],
    ['As you go', b.systematic],
    ['Long term', b.longTerm],
  ].filter(([, v]) => Array.isArray(v) && v.length);
  if (!cols.length) return '';
  const inner = cards3(cols, ([label, items]) =>
    `<div class="card"><h3 class="text-xl font-bold mb-3 text-brand-text">${esc(label)}</h3>${ul(items)}</div>`
  );
  return section(`${h2('What you gain')}${inner}`);
}

function buildTransformation(sc) {
  // supports both the flat shape ({before: [...], after: [...]}) and the store-website
  // storytelling.transformationArc shape ({before: {title, description, points}, after: {...}})
  const t = sc.transformation || (sc.storytelling && sc.storytelling.transformationArc);
  if (!t || (!t.before && !t.after)) return '';
  const col = (label, v, color, marker) => {
    if (!v) return '';
    const arr = Array.isArray(v) ? v : v.points;
    const title = (!Array.isArray(v) && v.title) || label;
    const desc =
      !Array.isArray(v) && v.description
        ? `<p class="text-white/80 mb-3">${md(v.description)}</p>`
        : '';
    return `<div class="card"><h3 class="text-xl font-bold mb-3" style="color:${color}">${esc(title)}</h3>${desc}${ul(arr, marker)}</div>`;
  };
  return section(
    `${h2('Before & after')}<div class="grid md:grid-cols-2 gap-5">${col('Before', t.before, '#ef4444', 'crosses')}${col(
      'After',
      t.after,
      '#10b981',
      'checks'
    )}</div>`
  );
}

function buildAudience(sc) {
  const col = (label, arr, color, marker) =>
    Array.isArray(arr) && arr.length
      ? `<div class="card"><h3 class="text-xl font-bold mb-3" style="color:${color}">${esc(label)}</h3>${ul(arr, marker)}</div>`
      : '';
  const left = col('Perfect for you if…', sc.perfectFor || sc.targetAudience, '#10b981', 'checks');
  const right = col('Not for you if…', sc.notForYou, '#ef4444', 'crosses');
  if (!left && !right) return '';
  return section(`${h2('Is this for you?')}<div class="grid md:grid-cols-2 gap-5">${left}${right}</div>`);
}

function buildMediaGallery(media, mediaMap = {}) {
  // Verified live CSP: img-src allows ALL of public-files.gumroad.com, frame-src allows
  // YouTube embeds — but <a> navigation to external sites is still blocked. So:
  // - first EMBED_VIDEOS youtube entries become real embedded players
  // - images mapped (by URL basename) to product-hosted Gumroad URLs render in a grid
  // - the channel is surfaced as copyable text (links would be dead)
  const vidItems = (media || [])
    .filter((m) => m.youtubeId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .slice(0, LIST_VIDEOS)
    .map(
      (m) =>
        `<li class="text-white/80">▶ <strong>${esc(m.title || 'Video')}</strong><br>
         <code class="text-brand-text font-bold">youtu.be/${esc(m.youtubeId)}</code></li>`
    )
    .join('');
  const imgs = (media || [])
    .filter((m) => m.type === 'image' && m.url)
    .map((m) => ({ m, gum: mediaMap[m.url.split('/').pop()] }))
    .filter((x) => x.gum)
    .sort((a, b) => (a.m.order ?? 0) - (b.m.order ?? 0));
  const shots = imgs.length
    ? `<div class="shots">${imgs
        .map(
          ({ m, gum }) =>
            `<figure><img src="${esc(gum)}" alt="${esc(m.altText || m.title || '')}" loading="lazy">${
              m.title
                ? `<figcaption class="text-white/70 text-sm mt-2 text-center">${esc(m.title)}</figcaption>`
                : ''
            }</figure>`
        )
        .join('')}</div>`
    : '';
  const yt =
    vidItems || YOUTUBE
      ? `<div class="card mt-6 text-center">
       <p class="text-white/90 font-bold mb-3">▶ Watch the video walkthroughs</p>
       ${vidItems ? `<ul class="space-y-3 mb-4" style="list-style:none;padding:0">${vidItems}</ul>` : ''}
       ${YOUTUBE ? `<p class="text-white/75">Many more on my channel: <code class="text-brand-text font-bold">${esc(YOUTUBE)}</code></p>` : ''}
       <p class="text-white/50 text-sm mt-2">(type the address in your browser — this page can't link out)</p></div>`
      : '';
  if (!shots && !yt) return '';
  return section(`${h2('See it in action')}${shots}${yt}`);
}

function buildIncluded(p, children) {
  if (!children || !children.length) return '';
  const cards = children
    .map((c) => {
      if (!c) return '';
      const price = c.priceDisplay || (c.price != null ? `€${c.price}` : '');
      // plain text, no anchor — the sandbox blocks external navigation
      return `<div class="card"><h3 class="text-lg font-bold mb-1">${esc(c.name)}</h3>${
        price ? `<p class="text-brand-text font-bold">${esc(price)} value</p>` : ''
      }${c.shortDescription ? `<p class="text-white/70 mt-1">${md(c.shortDescription)}</p>` : ''}</div>`;
    })
    .join('');
  return section(`${h2("What's included")}<div class="carousel">${cards}</div>`);
}

function buildTestimonials(rows) {
  // ALL testimonials in a masonry column layout (social proof is the point — don't truncate
  // unless --testimonials caps it), stars on every card, featured ones get a brand border.
  let t = (rows || []).filter((x) => x.quote);
  if (!t.length) return '';
  if (TESTIMONIALS > 0) t = t.slice(0, TESTIMONIALS);
  const cards = t
    .map(
      (x) =>
        `<div class="card t-card${x.featured ? ' t-featured' : ''}">
          <p class="text-amber-400 tracking-widest mb-2">★★★★★</p>
          <p class="text-white">“${esc(x.quote)}”</p>
          <p class="text-white/60 mt-3">— ${esc(x.author)}${x.role ? `, ${esc(x.role)}` : ''}${
            x.company ? ` (${esc(x.company)})` : ''
          }</p></div>`
    )
    .join('');
  // wider container than section() — three masonry columns need the room
  return `<section class="px-5 py-16"><div class="max-w-5xl mx-auto">${h2(
    'What people say'
  )}<div class="t-cols">${cards}</div></div></section>`;
}

function buildFaq(rows) {
  const f = (rows || []).filter((x) => x.question);
  if (!f.length) return '';
  const items = f
    .map(
      (x) =>
        `<details class="card mb-3"><summary class="font-bold cursor-pointer">${esc(
          x.question
        )}</summary><p class="text-white/80 mt-3">${md(x.answer)}</p></details>`
    )
    .join('');
  return section(`${h2('Questions')}${items}`);
}

function buildTimeline(sc) {
  // flat array of strings/objects, or the store-website shape {title, milestones: [...]}
  const t = sc.timeline;
  if (!t) return '';
  if (Array.isArray(t)) return buildList('Your timeline', t);
  if (!Array.isArray(t.milestones) || !t.milestones.length) return '';
  const items = t.milestones
    .map(
      (m) =>
        `<div class="card mb-4"><h3 class="text-xl font-bold mb-1">${esc(
          [m.timeframe, m.title].filter(Boolean).join(' — ')
        )}</h3>${m.description ? `<p class="text-white/80 mb-2">${md(m.description)}</p>` : ''}${ul(m.highlights)}</div>`
    )
    .join('');
  return section(`${h2(t.title || 'Your timeline')}${items}`);
}

function buildFinalCta(p, sc) {
  const headline = sc.tagline || p.name;
  const guarantees =
    Array.isArray(sc.guarantees) && sc.guarantees.length
      ? `<div class="max-w-xl mx-auto mb-7">${ul(sc.guarantees, 'text-left')}</div>`
      : '';
  return `<section class="px-5 py-16 text-center"><div class="max-w-3xl mx-auto">
    ${h2(`Ready? ${esc(headline)}`)}${guarantees}
    ${buyCtas(p)}
  </div></section>`;
}

// ---- main ----
async function main() {
  const product = await getJson(`${slug}.json`);
  if (!product) throw new Error(`Product "${slug}" not found in ${LOCAL || `${STORE}@${REF}`}`);
  const copyId = product.activeSalesCopyId || 'default';
  const [salesRaw, testRaw, faqRaw, mediaRaw, statsRaw] = await Promise.all([
    getJson(`${slug}-sales-copy-${copyId}.json`),
    getJson(`${slug}-testimonials.json`),
    getJson(`${slug}-faq.json`),
    getJson(`${slug}-media.json`),
    getJson(`${slug}-stats.json`),
  ]);

  // token context: stats.*, product.*, computed.averageRating (mean across all rating sources)
  const stats = (statsRaw && statsRaw.data) || {};
  const allRatings = Object.values(stats.ratings || {})
    .flat()
    .map((r) => r && r.rating)
    .filter((r) => typeof r === 'number');
  const computed = {
    averageRating: allRatings.length
      ? allRatings.reduce((a, b) => a + b, 0) / allRatings.length
      : undefined,
    ratingCount: allRatings.length || undefined,
  };
  const ctx = { stats, product, computed };

  const sc = interpolate((salesRaw && salesRaw.salesCopy) || {}, ctx);
  const testimonials = interpolate((testRaw && testRaw.data) || [], ctx);
  const faq = interpolate((faqRaw && faqRaw.data) || [], ctx);
  const media = (mediaRaw && mediaRaw.data) || [];
  const mediaMap = MEDIA_MAP_FILE ? JSON.parse(await readFile(MEDIA_MAP_FILE, 'utf8')) : {};

  // resolve included products (bundles)
  let children = [];
  if (Array.isArray(product.includedProducts) && product.includedProducts.length) {
    children = await Promise.all(product.includedProducts.map((s) => getJson(`${s}.json`)));
  }

  // section order mirrors store-website product.tsx
  const content = [
    buildHero(product, sc, COVER, ctx),
    buildStatsBand(ctx),
    buildPAS(sc),
    buildContents(product),
    buildStory(sc),
    sc.howItWorks && Array.isArray(sc.howItWorks) ? buildList('How it works', sc.howItWorks) : '',
    buildList('Highlights', sc.highlights),
    buildList('What you get', sc.whatYouGet),
    sc.courseContent ? buildList("Course content", sc.courseContent) : '',
    buildBenefits(sc),
    buildTransformation(sc),
    buildMethodology(sc),
    buildTimeline(sc),
    buildList('Common misconceptions', sc.misconceptionBusters),
    buildAudience(sc),
    sc.adhdBenefit ? section(`<div class="card"><p class="text-white/80">${md(sc.adhdBenefit)}</p></div>`) : '',
    buildMediaGallery(media, mediaMap),
    buildVision(sc),
    buildIncluded(product, children),
    buildTestimonials(testimonials),
    buildFaq(faq),
    buildFinalCta(product, sc),
  ]
    .filter(Boolean)
    .join('\n');

  const price = product.priceDisplay || (product.price != null ? `€${product.price}` : '');
  let html = await readFile(TEMPLATE, 'utf8');
  html = html
    .replace('{{BUY_NAME}}', esc(product.name))
    .replace('{{BUY_PRICE}}', esc(price))
    .replace('{{BUY_CTA}}', 'Buy now')
    .replace('<!--PAGE_CONTENT-->', content);

  await mkdir(dirname(resolve(OUT)), { recursive: true });
  await writeFile(OUT, html, 'utf8');
  console.log(`Wrote ${OUT} (${html.length} bytes) for ${slug} from ${STORE}@${REF}`);
}

main().catch((e) => {
  console.error('render failed:', e.message);
  process.exit(1);
});
