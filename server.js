const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const nodePath = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 500;

// ── Fetchers ──────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const r = await axios.get(url, {
    timeout: 20000,
    headers: { 'User-Agent': UA },
    validateStatus: s => s < 400  // treat 404+ as failures
  });
  if (r.status >= 400) return null;
  return r.data;
}

async function fetchAsset(assetUrl) {
  try {
    const r = await axios.get(assetUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': UA },
      validateStatus: s => s < 400
    });
    if (r.status >= 400) return null;
    return { buffer: Buffer.from(r.data), type: r.headers['content-type'] || '' };
  } catch (e) {
    console.warn('Skip asset:', assetUrl.slice(0, 80), '-', e.message);
    return null;
  }
}

// Fetch and parse sitemap(s), returning all page URLs on the same domain
async function fetchSitemapUrls(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const found = new Set();

  async function parseSitemap(url) {
    try {
      const r = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': UA }, validateStatus: s => s < 400 });
      if (r.status >= 400) return;
      const xml = r.data;

      // Sitemap index - contains <sitemap><loc> entries pointing to child sitemaps
      const childSitemaps = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>(.*?)<\/loc>/gi)].map(m => m[1].trim());
      for (const child of childSitemaps) await parseSitemap(child);

      // Regular sitemap - contains <url><loc> entries
      const locs = [...xml.matchAll(/<url>[\s\S]*?<loc>(.*?)<\/loc>/gi)].map(m => m[1].trim());
      for (const loc of locs) {
        try {
          if (new URL(loc).origin === origin) found.add(loc);
        } catch {}
      }
    } catch (e) {
      console.log('No sitemap at', url, '-', e.message);
    }
  }

  // Try common sitemap locations
  await parseSitemap(`${origin}/sitemap.xml`);
  await parseSitemap(`${origin}/sitemap_index.xml`);

  console.log(`Sitemap: found ${found.size} URLs`);
  return found;
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function resolveUrl(base, rel) {
  try { return new URL(rel, base).href; } catch { return null; }
}

function normalizePageUrl(u) {
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch { return u; }
}

function isSameDomain(url, base) {
  try { return new URL(url).hostname === new URL(base).hostname; } catch { return false; }
}

function shouldSkip(rel) {
  return !rel || /^(data:|#|javascript:|mailto:|tel:)/.test(rel.trim());
}

function urlToPagePath(pageUrl) {
  try {
    let pathname = new URL(pageUrl).pathname;
    if (pathname !== '/' && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    if (pathname === '' || pathname === '/') return 'index.html';
    pathname = pathname.replace(/^\//, '');
    return nodePath.extname(pathname) ? pathname : pathname + '/index.html';
  } catch { return 'index.html'; }
}

function urlToAssetPath(assetUrl) {
  try {
    const u = new URL(assetUrl);
    const raw = (u.pathname + (u.search ? u.search.replace(/[?&=]/g, '_') : ''))
      .replace(/^\//, '').replace(/\//g, '_');
    return 'assets/' + (raw || 'file');
  } catch { return 'assets/file_' + Date.now(); }
}

function relPath(fromFile, toFile) {
  const rel = nodePath.relative(nodePath.dirname(fromFile), toFile).replace(/\\/g, '/');
  return rel.startsWith('.') ? rel : './' + rel;
}

function extractCssRefs(css) {
  const urls = [];
  const re = /url\(\s*['"]?([^'"\)\s]+)['"]?\s*\)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    if (!m[1].startsWith('data:')) urls.push(m[1]);
  }
  return urls;
}

function parseSrcset(srcset) {
  if (!srcset) return [];
  return srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
}

// ── Export endpoint ───────────────────────────────────────────────────────────

app.post('/export', async (req, res) => {
  const { siteUrl } = req.body;
  if (!siteUrl) return res.status(400).json({ error: 'URL required' });

  try {
    const baseUrl = new URL(siteUrl).href;

    // Seed crawl queue from sitemap + start URL
    const sitemapUrls = await fetchSitemapUrls(baseUrl);
    const crawlQueue = [normalizePageUrl(siteUrl), ...sitemapUrls].map(normalizePageUrl);
    const visitedPages = new Set();
    // norm -> { localPath, $, assetUrls }
    const pages = new Map();

    // ── Crawl ───────────────────────────────────────────────────────────────
    while (crawlQueue.length > 0 && visitedPages.size < MAX_PAGES) {
      const pageUrl = crawlQueue.shift();
      const norm = normalizePageUrl(pageUrl);
      if (visitedPages.has(norm)) continue;
      visitedPages.add(norm);

      console.log(`[${visitedPages.size}/${crawlQueue.length + visitedPages.size}] ${pageUrl}`);

      const html = await fetchHtml(pageUrl);
      if (!html) { console.log('  -> skipped (4xx/error)'); continue; }

      const $ = cheerio.load(html);
      const assetUrls = new Set();

      const addAsset = (rel) => {
        if (shouldSkip(rel)) return;
        const abs = resolveUrl(pageUrl, rel);
        if (abs) assetUrls.add(abs);
      };

      // Standard asset tags
      $('link[href]').each((_, el) => addAsset($(el).attr('href')));
      $('script[src]').each((_, el) => addAsset($(el).attr('src')));
      $('img').each((_, el) => {
        addAsset($(el).attr('src'));
        addAsset($(el).attr('data-src'));
        parseSrcset($(el).attr('srcset')).forEach(addAsset);
        parseSrcset($(el).attr('data-srcset')).forEach(addAsset);
      });
      $('source').each((_, el) => {
        addAsset($(el).attr('src'));
        parseSrcset($(el).attr('srcset')).forEach(addAsset);
      });
      $('video').each((_, el) => { addAsset($(el).attr('src')); addAsset($(el).attr('poster')); });
      $('audio[src]').each((_, el) => addAsset($(el).attr('src')));

      // Inline style url() references
      $('[style]').each((_, el) => {
        extractCssRefs($(el).attr('style')).forEach(ref => addAsset(resolveUrl(pageUrl, ref)));
      });

      // <style> blocks
      $('style').each((_, el) => {
        extractCssRefs($(el).html() || '').forEach(ref => addAsset(resolveUrl(pageUrl, ref)));
      });

      // Internal links to crawl
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (shouldSkip(href)) return;
        const abs = resolveUrl(pageUrl, href);
        if (!abs || !isSameDomain(abs, baseUrl)) return;
        const normAbs = normalizePageUrl(abs);
        if (!visitedPages.has(normAbs)) crawlQueue.push(abs);
      });

      pages.set(norm, { localPath: urlToPagePath(pageUrl), $, assetUrls });
    }

    if (visitedPages.size >= MAX_PAGES) {
      console.log(`Hit page limit (${MAX_PAGES})`);
    }
    console.log(`Crawled ${pages.size} pages. Downloading assets...`);

    // ── Download assets ─────────────────────────────────────────────────────
    const assets = new Map(); // absUrl -> { local, buffer, isCss }
    const cssEntries = [];

    const allAssetUrls = new Set();
    for (const { assetUrls } of pages.values()) {
      for (const u of assetUrls) allAssetUrls.add(u);
    }

    for (const u of allAssetUrls) {
      if (assets.has(u)) continue;
      const r = await fetchAsset(u);
      if (!r) continue;
      const local = urlToAssetPath(u);
      const isCss = u.endsWith('.css') || r.type.includes('css');
      assets.set(u, { local, buffer: r.buffer, isCss });
      if (isCss) cssEntries.push({ url: u, text: r.buffer.toString('utf8') });
    }

    // Parse CSS for fonts, background images, etc.
    for (const { url: cssUrl, text } of cssEntries) {
      for (const ref of extractCssRefs(text)) {
        const abs = resolveUrl(cssUrl, ref);
        if (!abs || assets.has(abs)) continue;
        const r = await fetchAsset(abs);
        if (r) assets.set(abs, { local: urlToAssetPath(abs), buffer: r.buffer, isCss: false });
      }
    }

    // Rewrite url() inside CSS files
    const rewrittenCss = new Map();
    for (const { url: cssUrl, text } of cssEntries) {
      const cssLocal = assets.get(cssUrl)?.local;
      const rewritten = text.replace(
        /url\(\s*['"]?([^'"\)\s]+)['"]?\s*\)/g,
        (match, ref) => {
          if (ref.startsWith('data:')) return match;
          const abs = resolveUrl(cssUrl, ref);
          if (abs && assets.has(abs)) {
            const target = assets.get(abs).local;
            return `url('${cssLocal ? relPath(cssLocal, target) : './' + target.split('/').pop()}')`;
          }
          return match;
        }
      );
      rewrittenCss.set(cssUrl, rewritten);
    }

    // ── Rewrite HTML ────────────────────────────────────────────────────────
    const pagePathByNorm = new Map();
    for (const [norm, { localPath }] of pages) pagePathByNorm.set(norm, localPath);

    for (const [norm, { localPath, $ }] of pages) {
      const pageUrl = norm;

      const rewriteAttr = (el, attr) => {
        const val = $(el).attr(attr);
        if (!val || shouldSkip(val)) return;
        const abs = resolveUrl(pageUrl, val);
        if (abs && assets.has(abs)) $(el).attr(attr, relPath(localPath, assets.get(abs).local));
      };

      const rewriteSrcset = (el, attr) => {
        const srcset = $(el).attr(attr);
        if (!srcset) return;
        const rewritten = srcset.split(',').map(part => {
          const [url, ...rest] = part.trim().split(/\s+/);
          const abs = resolveUrl(pageUrl, url);
          const local = abs && assets.has(abs) ? relPath(localPath, assets.get(abs).local) : url;
          return [local, ...rest].join(' ');
        }).join(', ');
        $(el).attr(attr, rewritten);
      };

      $('link[href]').each((_, el) => rewriteAttr(el, 'href'));
      $('script[src]').each((_, el) => rewriteAttr(el, 'src'));
      $('img').each((_, el) => {
        rewriteAttr(el, 'src');
        rewriteAttr(el, 'data-src');
        rewriteSrcset(el, 'srcset');
        rewriteSrcset(el, 'data-srcset');
      });
      $('source').each((_, el) => { rewriteAttr(el, 'src'); rewriteSrcset(el, 'srcset'); });
      $('video').each((_, el) => { rewriteAttr(el, 'src'); rewriteAttr(el, 'poster'); });
      $('audio[src]').each((_, el) => rewriteAttr(el, 'src'));

      // Rewrite inline style url() references
      $('[style]').each((_, el) => {
        const style = $(el).attr('style');
        if (!style) return;
        const rewritten = style.replace(
          /url\(\s*['"]?([^'"\)\s]+)['"]?\s*\)/g,
          (match, ref) => {
            if (ref.startsWith('data:')) return match;
            const abs = resolveUrl(pageUrl, ref);
            if (abs && assets.has(abs)) return `url('${relPath(localPath, assets.get(abs).local)}')`;
            return match;
          }
        );
        $(el).attr('style', rewritten);
      });

      // Rewrite internal <a> links between pages
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (shouldSkip(href)) return;
        const abs = resolveUrl(pageUrl, href);
        if (!abs || !isSameDomain(abs, baseUrl)) return;
        const normTarget = normalizePageUrl(abs);
        if (pagePathByNorm.has(normTarget)) {
          $(el).attr('href', relPath(localPath, pagePathByNorm.get(normTarget)));
        }
      });
    }

    console.log(`Building ZIP: ${pages.size} pages, ${assets.size} assets`);

    // ── Stream ZIP ──────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'application/zip');
    const host = new URL(baseUrl).hostname.replace(/\./g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="${host}-export.zip"`);

    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.pipe(res);
    zip.on('error', err => console.error('ZIP error:', err));

    for (const [, { localPath, $ }] of pages) {
      zip.append($.html(), { name: localPath });
    }

    for (const [u, { local, buffer, isCss }] of assets) {
      const content = isCss && rewrittenCss.has(u) ? rewrittenCss.get(u) : buffer;
      zip.append(content, { name: local });
    }

    await zip.finalize();
    console.log('Export complete.');

  } catch (err) {
    console.error(err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Website Exporter at http://localhost:${PORT}`));
