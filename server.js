const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchAsset(assetUrl) {
  try {
    const r = await axios.get(assetUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': UA }
    });
    return { buffer: Buffer.from(r.data), type: r.headers['content-type'] || '' };
  } catch (e) {
    console.warn('Skip:', assetUrl.slice(0, 80), '-', e.message);
    return null;
  }
}

function resolveUrl(base, rel) {
  try { return new URL(rel, base).href; } catch { return null; }
}

// Flatten a URL into a safe assets/ filename
function toLocalPath(assetUrl) {
  try {
    const u = new URL(assetUrl);
    const raw = (u.pathname + (u.search ? u.search.replace(/[?&=]/g, '_') : ''))
      .replace(/^\//, '')
      .replace(/\//g, '_');
    return 'assets/' + (raw || 'file');
  } catch {
    return 'assets/file_' + Date.now();
  }
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

function shouldSkip(rel) {
  return !rel || /^(data:|#|javascript:|mailto:)/.test(rel.trim());
}

app.post('/export', async (req, res) => {
  const { siteUrl } = req.body;
  if (!siteUrl) return res.status(400).json({ error: 'URL required' });

  try {
    const base = new URL(siteUrl).href;

    // Fetch HTML
    const htmlRes = await axios.get(siteUrl, {
      timeout: 20000,
      headers: { 'User-Agent': UA }
    });
    const $ = cheerio.load(htmlRes.data);

    // Collect URLs to download
    const queue = new Set();
    const add = (rel) => {
      if (shouldSkip(rel)) return;
      const abs = resolveUrl(base, rel);
      if (abs) queue.add(abs);
    };

    $('link[href]').each((_, el) => add($(el).attr('href')));
    $('script[src]').each((_, el) => add($(el).attr('src')));
    $('img').each((_, el) => {
      add($(el).attr('src'));
      add($(el).attr('data-src'));
    });
    $('source').each((_, el) => {
      add($(el).attr('src'));
      const srcset = $(el).attr('srcset');
      if (srcset) srcset.split(',').forEach(s => add(s.trim().split(/\s+/)[0]));
    });
    $('video[src]').each((_, el) => add($(el).attr('src')));
    $('audio[src]').each((_, el) => add($(el).attr('src')));

    // Download first pass
    const assets = new Map(); // absUrl -> { local, buffer, isCss }
    const cssEntries = []; // { url, text } to parse for more refs

    for (const u of queue) {
      const r = await fetchAsset(u);
      if (!r) continue;
      const local = toLocalPath(u);
      const isCss = u.endsWith('.css') || r.type.includes('css');
      assets.set(u, { local, buffer: r.buffer, isCss });
      if (isCss) cssEntries.push({ url: u, text: r.buffer.toString('utf8') });
    }

    // Parse CSS for fonts / background images, download those too
    for (const { url: cssUrl, text } of cssEntries) {
      for (const ref of extractCssRefs(text)) {
        const abs = resolveUrl(cssUrl, ref);
        if (!abs || assets.has(abs)) continue;
        const r = await fetchAsset(abs);
        if (r) {
          assets.set(abs, { local: toLocalPath(abs), buffer: r.buffer, isCss: false });
        }
      }
    }

    // Rewrite CSS url() to use flat local filenames (all assets are siblings in assets/)
    const rewrittenCss = new Map();
    for (const { url: cssUrl, text } of cssEntries) {
      const rewritten = text.replace(
        /url\(\s*['"]?([^'"\)\s]+)['"]?\s*\)/g,
        (match, ref) => {
          if (ref.startsWith('data:')) return match;
          const abs = resolveUrl(cssUrl, ref);
          if (abs && assets.has(abs)) {
            const filename = assets.get(abs).local.split('/').pop();
            return `url('./${filename}')`;
          }
          return match;
        }
      );
      rewrittenCss.set(cssUrl, rewritten);
    }

    // Rewrite HTML attribute references
    const rewriteAttr = (el, attr) => {
      const val = $(el).attr(attr);
      if (!val || shouldSkip(val)) return;
      const abs = resolveUrl(base, val);
      if (abs && assets.has(abs)) $(el).attr(attr, assets.get(abs).local);
    };

    $('link[href]').each((_, el) => rewriteAttr(el, 'href'));
    $('script[src]').each((_, el) => rewriteAttr(el, 'src'));
    $('img').each((_, el) => { rewriteAttr(el, 'src'); rewriteAttr(el, 'data-src'); });
    $('source').each((_, el) => rewriteAttr(el, 'src'));
    $('video[src]').each((_, el) => rewriteAttr(el, 'src'));
    $('audio[src]').each((_, el) => rewriteAttr(el, 'src'));

    // Stream ZIP response
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="framer-export.zip"');

    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.pipe(res);
    zip.on('error', err => { console.error('ZIP error:', err); });

    zip.append($.html(), { name: 'index.html' });

    for (const [u, { local, buffer, isCss }] of assets) {
      const content = isCss && rewrittenCss.has(u) ? rewrittenCss.get(u) : buffer;
      zip.append(content, { name: local });
    }

    await zip.finalize();
    console.log(`Exported ${assets.size} assets from ${siteUrl}`);

  } catch (err) {
    console.error(err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Framer Exporter running at http://localhost:${PORT}`));
