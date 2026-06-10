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
// Relative /product and /assets links are rewritten to absolute store URLs.
function md(s) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\((\/[^)]+|https?:\/\/[^)]+)\)/g, (_, txt, url) => {
    const abs = url.startsWith('/') ? `${SITE}${url}` : url;
    return `<a href="${abs}">${txt}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t;
}
const abs = (u) => (u && u.startsWith('/') ? `${SITE}${u}` : u);

// ---- section helpers ----
const section = (inner, cls = '') =>
  inner ? `<section class="px-5 py-16 ${cls}"><div class="max-w-3xl mx-auto">${inner}</div></section>` : '';
const h2 = (t) => `<h2 class="text-3xl font-extrabold tracking-tight text-center mb-8">${esc(t)}</h2>`;
const ul = (arr, cls = '') =>
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

function buildHero(p, sc, coverUrl) {
  const tagline = sc.tagline || p.name;
  const sub = sc.secondaryTagline || sc.description || p.shortDescription || '';
  // Only the product's own Gumroad cover (passed via --cover) — external hosts are blocked live.
  const img = coverUrl
    ? `<img src="${esc(coverUrl)}" alt="${esc(p.name)}" class="max-w-full rounded-2xl mt-10 mx-auto shadow-2xl">`
    : '';
  const badges = Array.isArray(sc.trustBadges) && sc.trustBadges.length
    ? `<div class="flex flex-wrap gap-3 justify-center mt-6">${sc.trustBadges
        .map((b) => `<span class="card !py-2 !px-4 text-sm text-white/80">${md(b)}</span>`)
        .join('')}</div>`
    : '';
  return `<section class="text-center px-5 pt-24 pb-16"><div class="max-w-3xl mx-auto">
    <h1 class="text-4xl md:text-6xl font-extrabold tracking-tight mb-4" data-gumroad-field="name">${esc(tagline)}</h1>
    <p class="text-lg md:text-xl text-white/70 max-w-2xl mx-auto mb-7">${md(sub)}</p>
    ${buyCtas(p)}
    ${badges}${img}
  </div></section>`;
}

function buildPAS(sc) {
  const block = (label, color, text, points) => {
    if (!text && !(points && points.length)) return '';
    return `<div class="card mb-4 border-l-4" style="border-left-color:${color}">
      <h3 class="text-xl font-bold mb-2">${esc(label)}</h3>
      ${text ? `<p class="text-white/80 mb-3">${md(text)}</p>` : ''}${ul(points)}
    </div>`;
  };
  const inner =
    block('The problem', '#ef4444', sc.problem, sc.problemPoints) +
    block('Why it hurts', '#f59e0b', sc.agitate, sc.agitatePoints) +
    block('The solution', '#10b981', sc.solution, sc.solutionPoints);
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
  const col = (label, v, color) => {
    if (!v) return '';
    const arr = Array.isArray(v) ? v : v.points;
    const title = (!Array.isArray(v) && v.title) || label;
    const desc =
      !Array.isArray(v) && v.description
        ? `<p class="text-white/80 mb-3">${md(v.description)}</p>`
        : '';
    return `<div class="card"><h3 class="text-xl font-bold mb-3" style="color:${color}">${esc(title)}</h3>${desc}${ul(arr)}</div>`;
  };
  return section(
    `${h2('Before & after')}<div class="grid md:grid-cols-2 gap-5">${col('Before', t.before, '#ef4444')}${col(
      'After',
      t.after,
      '#10b981'
    )}</div>`
  );
}

function buildAudience(sc) {
  const col = (label, arr, color) =>
    Array.isArray(arr) && arr.length
      ? `<div class="card"><h3 class="text-xl font-bold mb-3" style="color:${color}">${esc(label)}</h3>${ul(arr)}</div>`
      : '';
  const left = col('Perfect for you if…', sc.perfectFor || sc.targetAudience, '#10b981');
  const right = col('Not for you if…', sc.notForYou, '#ef4444');
  if (!left && !right) return '';
  return section(`${h2('Is this for you?')}<div class="grid md:grid-cols-2 gap-5">${left}${right}</div>`);
}

function buildMediaGallery(media) {
  // Store-website /assets images are external (blocked live), so only YouTube link-outs are emitted.
  const yts = (media || [])
    .filter((m) => m.youtubeId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!yts.length) return '';
  const ytHtml = yts
    .map(
      (m) =>
        `<a href="https://www.youtube.com/watch?v=${esc(m.youtubeId)}" class="card flex items-center justify-center text-center !text-white">▶ ${esc(
          m.title || 'Watch the video'
        )}</a>`
    )
    .join('');
  return section(`${h2('See it in action')}<div class="carousel">${ytHtml}</div>`);
}

function buildIncluded(p, children) {
  if (!children || !children.length) return '';
  const cards = children
    .map((c) => {
      if (!c) return '';
      const price = c.priceDisplay || (c.price != null ? `€${c.price}` : '');
      const href = c.dsebastienUrl || c.gumroadUrl || `${SITE}/product/${c.id}`;
      return `<div class="card"><h3 class="text-lg font-bold mb-1"><a href="${href}">${esc(c.name)}</a></h3>${
        price ? `<p class="text-brand-text font-bold">${esc(price)} value</p>` : ''
      }${c.shortDescription ? `<p class="text-white/70 mt-1">${md(c.shortDescription)}</p>` : ''}</div>`;
    })
    .join('');
  return section(`${h2("What's included")}<div class="carousel">${cards}</div>`);
}

function buildTestimonials(rows) {
  const t = (rows || []).filter((x) => x.quote);
  if (!t.length) return '';
  const cards = t
    .slice(0, 9)
    .map(
      (x) =>
        `<div class="card"><p class="text-white">“${esc(x.quote)}”</p><p class="text-white/60 mt-3">— ${esc(
          x.author
        )}${x.role ? `, ${esc(x.role)}` : ''}${x.company ? ` (${esc(x.company)})` : ''}</p></div>`
    )
    .join('');
  return section(`${h2('What people say')}<div class="carousel">${cards}</div>`);
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

  // resolve included products (bundles)
  let children = [];
  if (Array.isArray(product.includedProducts) && product.includedProducts.length) {
    children = await Promise.all(product.includedProducts.map((s) => getJson(`${s}.json`)));
  }

  // section order mirrors store-website product.tsx
  const content = [
    buildHero(product, sc, COVER),
    buildPAS(sc),
    buildStory(sc),
    sc.howItWorks ? buildList('How it works', sc.howItWorks) : '',
    buildList('Highlights', sc.highlights),
    buildList('What you get', sc.whatYouGet),
    sc.courseContent ? buildList("What's inside", sc.courseContent) : '',
    buildBenefits(sc),
    buildTransformation(sc),
    buildTimeline(sc),
    buildList('Common misconceptions', sc.misconceptionBusters),
    buildAudience(sc),
    sc.adhdBenefit ? section(`<div class="card"><p class="text-white/80">${md(sc.adhdBenefit)}</p></div>`) : '',
    buildMediaGallery(media),
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
