const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseUTCFromTitle(titleStr) {
  if (!titleStr) return null;
  const m = titleStr.match(/^(\d{2}:\d{2})\s*-\s*(.+)$/);
  let d;
  if (m) {
    const [, hm, rest] = m;
    d = new Date(`${rest} ${hm}`);
  } else {
    d = new Date(titleStr);
  }
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseUTCFromRelative(rel) {
  const now = Date.now();
  if (!rel) return null;
  if (/just now/i.test(rel)) return new Date(now).toISOString();
  const m = rel.match(/(\d+)\s*(?:min|mins|minute|minutes)\b/i);
  if (m) return new Date(now - parseInt(m[1],10)*60*1000).toISOString();
  const h = rel.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)\b/i);
  if (h) return new Date(now - parseInt(h[1],10)*3600*1000).toISOString();
  return null;
}

async function downloadBinary(urlStr) {
  const res = await fetch(urlStr, { headers: { Referer: 'https://www.tradingview.com/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

async function downloadImagesForMessage({ id, urls, imagesDir }) {
  const saved = [];
  let idx = 1;
  for (const u of urls) {
    try {
      const buf = await downloadBinary(u);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const extMatch = u.match(/\.(png|jpg|jpeg|gif|webp)(?:\?|$)/i);
      const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.jpg';
      const targetDir = imagesDir || path.join(process.cwd(), 'data', 'images');
      await fs.promises.mkdir(targetDir, { recursive: true });
      const out = path.join(targetDir, `${id}_${idx}${ext}`);
      await fs.promises.writeFile(out, buf);
      saved.push({ kind: 'attachment', original_url: u, local_path: out, sha256: sha });
      idx++;
    } catch (e) {
      // ignore
    }
  }
  return saved;
}

async function extractAllMessages(page) {
  const items = await page.evaluate(() => {
    function replaceEmojisInNode(el) {
      if (!el) return;
      el.querySelectorAll('.tv-emoji-wrapper').forEach((em) => {
        const t = em.getAttribute('title') || '';
        const span = document.createElement('span');
        span.textContent = t ? ` ${t} ` : '';
        em.replaceWith(span);
      });
      el.querySelectorAll('img[alt]').forEach((img) => {
        const alt = (img.getAttribute('alt') || '').trim();
        if (!alt) return;
        const span = document.createElement('span');
        span.textContent = ` ${alt} `;
        img.replaceWith(span);
      });
    }
    const container = document.querySelector('.ch-data') || document.body;
    const nodes = Array.from(container.querySelectorAll('.ch-item'));
    const out = [];
    for (const it of nodes) {
      const id = it.getAttribute('id') || '';
      const authorA = it.querySelector('.ch-item-author .ch-userlink');
      const username = authorA?.getAttribute('data-username') || (authorA?.textContent || '').trim() || null;
      const badgeA = it.querySelector('.ch-userlink__badge-wrapper a');
      const badge = badgeA?.getAttribute('aria-label') || null;
      const avatarImg = it.querySelector('.ch-item-userpic img');
      const avatar = avatarImg ? new URL(avatarImg.getAttribute('src') || '', location.origin).toString() : null;
      const userIdClass = Array.from(it.classList).find(c => c.startsWith('ch-item-user-')) || '';
      const numeric_user_id = userIdClass ? Number(userIdClass.replace('ch-item-user-','')) : null;
      const profile = authorA?.getAttribute('href') || null;
      const sym = (it.querySelector('.ch-item-symbol')?.textContent || '').replace(/,$/,'').trim() || null;
      const timeEl = it.querySelector('.ch-item-time time');
      const timeRel = timeEl ? (timeEl.textContent || '').trim() : null;
      const timeTitle = timeEl ? (timeEl.getAttribute('title') || null) : null;
      const parts = Array.from(it.querySelectorAll('.ch-item-text'));
      for (const part of parts) {
        // Collect all quote blocks in this part
        const qWraps = Array.from(part.querySelectorAll('.ch-item-quote'));
        const quotes = [];
        
        for (const qEl of qWraps) {
          const u = qEl.querySelector('a[data-username], a[href^="/u/"]');
          const qUser = u?.getAttribute('data-username') || (u?.textContent || '').replace(/^@/,'').trim() || null;
          const qc = qEl.cloneNode(true); replaceEmojisInNode(qc);
          qc.querySelectorAll('.ch-item-snapshot-link,.tv-widget-chart-like-button').forEach(n => n.remove());
          qc.querySelectorAll('br').forEach(br => { br.replaceWith(document.createTextNode('\n')); });
          let qt = (qc.textContent || '').replace(/\n{3,}/g,'\n\n').trim();
          if (qUser) {
            const re = new RegExp(`^@?${qUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*wrote:`, 'i');
            qt = qt.replace(re, '').trim();
          }
          const textParts = qt.split(/\n/).map(s => s.trim());
          // Capture images inside this quote block
          const qLinks = Array.from(qEl.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(Boolean)
            .map(h => new URL(h, location.origin).toString());
          const qPrev = Array.from(qEl.querySelectorAll('.ch-item-snapshot-preview img, .ch-item-chart-preview img'))
            .map(img => img.getAttribute('src')).filter(Boolean)
            .map(s => new URL(s, location.origin).toString());
          const qUrls = qLinks.concat(qPrev);
          const imgRe = /(\.(png|jpe?g|gif|webp)(\?|$))|\/x\//i;
          const qCand = qUrls.filter(u => imgRe.test(u)).filter(u => !/_thumb\./i.test(u));
          function qTokenOf(u){
            const m1 = u.match(/\/x\/([A-Za-z0-9]+)/i);
            if (m1) return m1[1];
            const m2 = u.match(/\/snapshots\/([a-z])\/([A-Za-z0-9]+)\.(png|webp)/i);
            if (m2) return m2[2];
            return u;
          }
          const byAny = new Map();
          for (const u2 of qCand.concat(qPrev)){
            const t = qTokenOf(u2);
            const prev = byAny.get(t);
            if (!prev || (/\/snapshots\//i.test(u2) && !/\/snapshots\//i.test(prev))) byAny.set(t, u2);
          }
          const quoteImages = Array.from(byAny.values());
          quotes.push({ user: qUser, text_parts: textParts, images: quoteImages, ideas: qPrev });
        }
        // Body media extraction (keep preview nodes)
        let text = '', images = [];
        const media = part.cloneNode(true); replaceEmojisInNode(media);
        // Exclude media inside quotes for body images
        const mq = media.querySelectorAll('.ch-item-quote'); mq.forEach(n => n.remove());
        const links = Array.from(media.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(Boolean);
        const abs = links.map(h => new URL(h, location.origin).toString());
        const previews = Array.from(media.querySelectorAll('.ch-item-snapshot-preview img, .ch-item-chart-preview img'))
          .map(img => img.getAttribute('src')).filter(Boolean)
          .map(s => new URL(s, location.origin).toString());
        const urls = abs.concat(previews);
        const imgRe = /(\.(png|jpe?g|gif|webp)(\?|$))|\/x\//i;
        const cand = urls.filter(u => imgRe.test(u)).filter(u => !/_thumb\./i.test(u));
        function tokenOf(u){
          const m1 = u.match(/\/x\/([A-Za-z0-9]+)/i);
          if (m1) return m1[1];
          const m2 = u.match(/\/snapshots\/([a-z])\/([A-Za-z0-9]+)\.(png|webp)/i);
          if (m2) return m2[2];
          return u; // fallback to full URL as key
        }
        const byToken = new Map();
        for (const u of cand){
          const t = tokenOf(u);
          const prev = byToken.get(t);
          if (!prev || (/\/snapshots\//i.test(u) && !/\/snapshots\//i.test(prev))) byToken.set(t, u);
        }
        images = Array.from(byToken.values());
        // Text from cleaned copy (remove UI wrappers/labels)
        const cp = part.cloneNode(true); replaceEmojisInNode(cp);
        const qws = cp.querySelectorAll('.ch-item-quote'); qws.forEach(n => n.remove());
        cp.querySelectorAll('.ch-item-snapshot-link,.tv-widget-chart-like-button,.ch-item-chart-link,.ch-item-chart-preview,.ch-item-preview-wrap').forEach(n => n.remove());
        cp.querySelectorAll('br').forEach(br => { br.replaceWith(document.createTextNode('\n')); });
        text = (cp.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
        // ideas attached at container level, assign to first part
        let ideas = [];
      const ideaA = it.querySelector('.ch-item-chart-link a[data-publication-type="idea"], .ch-item-chart-link a[data-publication-type="script"]');
        if (ideaA) {
          const idea_id = ideaA.getAttribute('data-id') || null;
          const idea_symbol = ideaA.getAttribute('data-symbol') || null;
          const rawUrl = ideaA.getAttribute('data-url') || ideaA.getAttribute('href') || '';
          const idea_url = new URL(rawUrl, location.origin).toString();
          const likesEl = it.querySelector('.js-chart-like .js-likes-counter');
          const like_count = likesEl ? (likesEl.textContent || '').trim() : null;
          const previewImg = it.querySelector('.ch-item-chart-preview img');
          const preview = previewImg ? (previewImg.getAttribute('src') || '') : null;
          ideas.push({ id: idea_id, symbol: idea_symbol, url: idea_url, likes: like_count, preview });
        }
        const msgId = part.getAttribute('id') || id;
        out.push({ id: msgId, username, numeric_user_id, badge, profile, avatar, symbol: sym, timeRel, timeTitle, text, quotes, images, ideas });
      }
    }
    return out;
  });
  // post-process times: base on parsed full Title minute + in-batch microsecond offset
  let lastMinuteBase = null; // ms at minute start
  let lastOffsetUs = -1;     // microseconds within minute
  const normalized = items.map(e => {
    function minuteBaseFromTitleOrRel(tt, tr) {
      try {
        const iso = parseUTCFromTitle(tt) || parseUTCFromRelative(tr) || null;
        if (iso) {
          const t = new Date(iso).getTime();
          return Math.floor(t / 60000) * 60000;
        }
      } catch {}
      const now = Date.now();
      return Math.floor(now / 60000) * 60000;
    }
    const base = minuteBaseFromTitleOrRel(e.timeTitle, e.timeRel);
    if (lastMinuteBase !== null && base === lastMinuteBase) {
      lastOffsetUs = Math.max(0, lastOffsetUs) + 1; // +1 microsecond
    } else {
      lastMinuteBase = base;
      lastOffsetUs = 0;
    }
    // Build ISO with microseconds: start from base ISO and replace ms with 6-digit micros
    const baseIso = new Date(base).toISOString(); // ...:00.000Z
    let us = String(lastOffsetUs);
    if (us.length < 6) us = ('000000'.slice(us.length)) + us;
    const utc = baseIso.replace(/\.\d{3}Z$/, `.${us}Z`);
    return {
      id: e.id,
      username: e.username,
      badge: e.badge,
      profile_url: e.profile,
      symbol: e.symbol,
      time_title: e.timeTitle,
      time_rel: e.timeRel,
      utc,
      text: e.text,
      quotes: e.quotes,
      images: e.images,
      ideas: e.ideas
    };
  });
  return normalized;
}

async function fetchIdeaDetails(input) {
  try {
    const s = String(input || '');
    const m = s.match(/\b([A-Za-z0-9]{8})\b/);
    if (!m) return null;
    const uuid = m[1];
    const apiUrl = `https://www.tradingview.com/api/v1/ideas/${uuid}/`;
    const res = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tradingview.com/' } });
    if (!res.ok) return null;
    const data = await res.json();
    const title = data?.name || null;
    const text = data?.description || null;
    const published_at_utc = data?.created_at ? new Date(data.created_at).toISOString() : null;
    const author_username = data?.user?.username || null;
    const author_user_id = data?.user?.id || null;
    const like_count = (typeof data?.like_score === 'number') ? data.like_score : (data?.likes_count || null);
    const preview_url = data?.image?.big || data?.image?.middle_webp || data?.image?.middle || null;
    const symbol = data?.symbol?.resolved_symbol || null;
    const url = data?.chart_url ? new URL(data.chart_url, 'https://www.tradingview.com').toString() : null;
    return { title, text, published_at_utc, author_username, author_user_id, like_count, preview_url, symbol, url, raw: data };
  } catch {
    return null;
  }
}

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--remote-debugging-port=9222',
      '--remote-debugging-address=0.0.0.0', // Listen on all interfaces for docker port mapping
    ]
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 1200 });
  console.log('[Browser] Chrome debug available at: chrome://inspect or http://localhost:9222');
  return { browser, page };
}

async function navigateRoom(page, roomUrl) {
  await page.goto(roomUrl, { waitUntil: 'networkidle2', timeout: 90000 }).catch(()=>{});
  await sleep(3000);
  try {
    const cands = await page.$x("//button[contains(., 'Accept all') or contains(., 'Accept All') or contains(., 'Accept cookies')]");
    if (cands && cands.length) { await cands[0].click(); await sleep(800); }
  } catch {}
}

module.exports = {
  launchBrowser,
  navigateRoom,
  extractAllMessages,
  downloadImagesForMessage,
  fetchIdeaDetails,
  parseUTCFromTitle,
  parseUTCFromRelative,
};
