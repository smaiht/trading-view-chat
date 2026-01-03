#!/usr/bin/env node
const { DB } = require('../src/db');
const { createClient } = require('redis');
const cfg = require('../src/config');
const core = require('../src/core');

function parseArgs() {
  const args = process.argv.slice(2);
  const roomIdx = Math.max(args.indexOf('--room'), args.indexOf('-r'));
  const noImg = args.includes('--no-save-images');
  const noIdeas = args.includes('--no-save-ideas');
  return {
    room: roomIdx !== -1 ? args[roomIdx + 1] : (process.env.ROOM_URL || cfg.roomUrl),
    saveImages: noImg ? false : cfg.saveImages,
    saveIdeas: noIdeas ? false : cfg.saveIdeas,
  };
}

(async () => {
  const opts = parseArgs();
  const db = new DB({ connectionString: cfg.databaseUrl });

  // Initialize Redis publisher (for frontend fan-out via Redis)
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisUrl = process.env.REDIS_URL || `redis://${redisHost}:6379`;
  const redisChannel = process.env.CHAT_REDIS_CHANNEL || 'chat:messages';
  const redis = createClient({ url: redisUrl });
  try { await redis.connect(); } catch {}

  const { browser, page } = await core.launchBrowser();

  // Log browser console errors to detect page issues
  page.on('console', msg => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      console.log(`[Browser:${type}] ${msg.text()}`);
    }
  });

  // Log page errors (uncaught exceptions)
  page.on('pageerror', err => {
    console.error('[Browser:pageerror]', err.message);
  });

  await core.navigateRoom(page, opts.room);

  // Periodic keepalive: scroll to bottom to encourage chat to render new items
  // TradingView can lazy-render chat items unless viewport is near the end.
  let messagesSinceLastKeepAlive = 0;

  const keepAlive = setInterval(async () => {
    try {
      await page.evaluate(() => {
        try { window.scrollTo(0, document.body.scrollHeight); } catch {}
      });

      // Heartbeat log every 30s to confirm process is alive
      console.log(`[Heartbeat] Alive. Messages processed since last check: ${messagesSinceLastKeepAlive}`);
      messagesSinceLastKeepAlive = 0;
    } catch (err) {
      console.error('[Keepalive] Error during scroll:', err.message);
    }
  }, 30000);

  // Self-health check: verify we're actually receiving messages
  // If DB shows no recent messages, the page is probably stuck → restart via process.exit()
  const HEALTH_CHECK_INTERVAL_MS = 3 * 60 * 1000; // Check every 3 minutes
  const STALE_THRESHOLD_MS = 5 * 60 * 1000;       // Alert if no messages for 5 minutes

  const healthCheck = setInterval(async () => {
    try {
      // Check 1: Page responsiveness (can we evaluate JS?)
      let pageAlive = false;
      try {
        await page.evaluate(() => true); // Simple ping
        pageAlive = true;
      } catch (err) {
        console.error('[HealthCheck] Page not responding:', err.message);
      }

      // Check 2: MutationObserver installed?
      let observerInstalled = false;
      try {
        observerInstalled = await page.evaluate(() => window.___tvObserverInstalled === true);
      } catch {}

      // Check 3: Database freshness
      const result = await db.pool.query(`
        SELECT EXTRACT(EPOCH FROM (NOW() - MAX(COALESCE(utc, created_at)))) * 1000 as age_ms
        FROM tv_messages
      `);
      const ageMs = result.rows[0]?.age_ms;

      if (ageMs !== null && !isNaN(ageMs)) {
        const ageMinutes = Math.floor(ageMs / 60000);
        console.log(`[HealthCheck] DB age: ${ageMinutes}m, Page alive: ${pageAlive}, Observer: ${observerInstalled}`);

        if (ageMs > STALE_THRESHOLD_MS) {
          console.error(`[HealthCheck] CRITICAL: No messages for ${ageMinutes} minutes (threshold: ${STALE_THRESHOLD_MS/60000}m)`);
          console.error(`[HealthCheck] Diagnostics: page_alive=${pageAlive}, observer=${observerInstalled}`);
          console.error('[HealthCheck] Page appears stuck. Exiting to trigger container restart...');

          // Cleanup before exit
          try { clearInterval(keepAlive); } catch {}
          try { clearInterval(healthCheck); } catch {}
          try { clearInterval(ensureObserver); } catch {}
          try { await browser.close(); } catch {}
          try { await db.pool.end(); } catch {}
          try { await redis.quit(); } catch {}

          process.exit(1); // Docker restart: unless-stopped will restart us
        }
      }
    } catch (err) {
      console.error('[HealthCheck] Error during check:', err.message);
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // No in-memory reply resolution beyond minimal recent cache for logs
  const recentCache = [];
  function pushCache(m) { recentCache.push(m); if (recentCache.length > 200) recentCache.shift(); }

  // Seed cache (small)
  try {
    const seed = await core.extractAllMessages(page);
    seed.slice(-50).forEach(pushCache);
  } catch (e) {
    try { await core.navigateRoom(page, opts.room); } catch {}
  }
  // Initialize last minute base (ms) + offset (microseconds) from DB for stable ordering across restarts
  let lastMinuteBaseGlobal = null; // number: start of minute in ms
  let lastOffsetGlobal = -1;       // microseconds within that minute
  try {
    const lastEpoch = await db.getLastMessageEpoch(opts.room); // seconds (float) including microseconds
    if (lastEpoch != null && !Number.isNaN(lastEpoch)) {
      const tsMs = lastEpoch * 1000;
      lastMinuteBaseGlobal = Math.floor(tsMs / 60000) * 60000;
      // microseconds within that minute
      lastOffsetGlobal = Math.max(0, Math.round((tsMs - lastMinuteBaseGlobal) * 1000));
    }
  } catch {}

  // Observe DOM for new messages
  await page.exposeFunction('___emitNewMessages', async (events) => {
    try {
      let lastMinuteBase = lastMinuteBaseGlobal; // ms at minute start
      let lastOffset = lastOffsetGlobal;        // microseconds within minute
      // Build ISO string with 6-digit microseconds from minute base + micro offset
      function fmtUtcWithMicros(baseMs, microOffset) {
        const baseIso = new Date(baseMs).toISOString(); // e.g., 2025-10-20T11:35:00.000Z
        let us = String(Math.max(0, microOffset | 0));
        if (us.length < 6) us = ('000000'.slice(us.length)) + us;
        // Replace the millisecond part .000Z with .<micros>Z
        return baseIso.replace(/\.\d{3}Z$/, `.${us}Z`);
      }
      // Unified: base by parsed full time_title (absolute minute); if same minute => offset+1ms; else offset=0
      const normalized = events.map(e => {
        function parseBaseMinuteFromTitle(titleStr) {
          try {
            const iso = core.parseUTCFromTitle(titleStr);
            if (iso) {
              const t = new Date(iso).getTime();
              return Math.floor(t / 60000) * 60000;
            }
          } catch {}
          const now = Date.now();
          return Math.floor(now / 60000) * 60000;
        }
        const base = parseBaseMinuteFromTitle(e.time);
        if (lastMinuteBase !== null && base === lastMinuteBase) {
          lastOffset = Math.max(0, lastOffset) + 1; // +1 microsecond
        } else {
          lastOffset = 0;
          lastMinuteBase = base;
        }
        const utcStr = fmtUtcWithMicros(base, lastOffset);
        const UTC_DEBUG = false; // enable for local troubleshooting only
        if (UTC_DEBUG) {
          try { console.log(`[UTC][STREAM] id=${e.id} title="${e.time}" base=${new Date(base).toISOString()} offset_us=${lastOffset} utc=${utcStr}`); } catch {}
        }
        const utc = utcStr;
        // Structured quotes only
        return {
          id: e.id,
          username: e.user,
          numeric_user_id: e.numeric_user_id || null,
          badge: e.badge,
          profile_url: null,
          avatar_url: e.avatar || null,
          symbol: e.symbol,
          time_title: e.time,
          utc,
          text: e.text,
          quotes: Array.isArray(e.quotes) ? e.quotes : [],
          images: e.images || [],
          ideas: e.ideas || []
        };
      });
      lastMinuteBaseGlobal = lastMinuteBase;
      lastOffsetGlobal = lastOffset;

      // Always resolve reply_to_id via DB based on quoted content
      async function escLike(s){
        if (!s) return '';
        return String(s).replace(/[\\%_]/g, ch => `\\${ch}`);
      }
      function tokenOf(u){
        const s = String(u||'');
        const m1 = s.match(/\/x\/([A-Za-z0-9]+)/i); if (m1) return m1[1];
        const m2 = s.match(/\/snapshots\/([a-z])\/([A-Za-z0-9]+)\.(png|webp)/i); if (m2) return m2[2];
        return null;
      }
      async function findParentsForQuotes(m){
        if (!Array.isArray(m.quotes) || !m.quotes.length) return { primary: null, quotes: [] };
        const parents = [];
        let primary = null;
        for (const q of m.quotes) {
          const qUser = q && q.user ? String(q.user) : null;
          let found = null;
          if (qUser) {
            const parts = Array.isArray(q.text_parts) ? q.text_parts.filter(Boolean) : [];
            const fullText = parts.join('\n');
            // 1) Try concatenated segments first (handles single message broken into lines)
            if (!found && parts.length) {
              const concat = (parts.length ? parts.join('') : fullText.replace(/[\s\u00A0]+/g, '')).slice(0, 400);
              try {
                const resC = await db.pool.query(
                  `SELECT id FROM tv_messages
                     WHERE username=$1 AND replace(replace(replace(replace(content, E'\r',''), E'\n',''), ' ', ''), E'\t','') ILIKE $2 ESCAPE '\\'
                   ORDER BY COALESCE(utc, created_at) DESC NULLS LAST LIMIT 1`,
                  [qUser, `%${await escLike(concat)}%`]
                );
                if (resC.rows.length) found = resC.rows[0].id;
              } catch {}
            }
            // 2) Try full text as-is (with preserved newlines)
            if (!found && fullText) {
              try {
                const res = await db.pool.query(
                  `SELECT id FROM tv_messages
                     WHERE username=$1 AND content ILIKE $2 ESCAPE '\\'
                   ORDER BY COALESCE(utc, created_at) DESC NULLS LAST LIMIT 1`,
                  [qUser, `%${await escLike(fullText.slice(0, 400))}%`]
                );
                if (res.rows.length) found = res.rows[0].id;
              } catch {}
            }
            // 3) Try per-part text matching (no length filter)
            if (!found && parts.length) {
              for (const p of parts) {
                if (!p) continue;
                try {
                  const resP = await db.pool.query(
                    `SELECT id FROM tv_messages
                       WHERE username=$1 AND content ILIKE $2 ESCAPE '\\'
                     ORDER BY COALESCE(utc, created_at) DESC NULLS LAST LIMIT 1`,
                    [qUser, `%${await escLike(String(p).slice(0, 400))}%`]
                  );
                  if (resP.rows.length) { found = resP.rows[0].id; break; }
                } catch {}
              }
            }
            // 4) Fallback: image/idea token matching on this quote's media
            if (!found) {
              const qImgs = Array.isArray(q.images) ? q.images : [];
              const qIdeas = Array.isArray(q.ideas) ? q.ideas : [];
              const tokens = Array.from(new Set([...qImgs, ...qIdeas].map(tokenOf).filter(Boolean)));
              for (const t of tokens) {
                try {
                  const like = `%${t}%`;
                  const resI = await db.pool.query(
                  `SELECT i.message_id
                       FROM tv_images i JOIN tv_messages pm ON pm.id=i.message_id
                      WHERE pm.username=$1 AND (i.original_url ILIKE $2 OR i.local_path ILIKE $2)
                   ORDER BY COALESCE(pm.utc, pm.created_at) DESC NULLS LAST LIMIT 1`,
                    [qUser, like]
                  );
                  if (resI.rows.length) { found = resI.rows[0].message_id; break; }
                } catch {}
                try {
                  const resD = await db.pool.query(
                    `SELECT m.id
                       FROM tv_ideas d JOIN tv_messages m ON m.idea_id=d.idea_id
                      WHERE m.username=$1 AND d.preview_url ILIKE $2
                   ORDER BY COALESCE(m.utc, m.created_at) DESC NULLS LAST LIMIT 1`,
                    [qUser, `%${t}%`]
                  );
                  if (resD.rows.length) { found = resD.rows[0].id; break; }
                } catch {}
              }
            }
          }
          parents.push(found);
          if (!primary && found) primary = found;
        }
        return { primary, quotes: parents };
      }

      for (const m of normalized) {
        try {
          const r = await findParentsForQuotes(m);
          if (Array.isArray(m.quotes) && Array.isArray(r.quotes)) {
            for (let i=0;i<m.quotes.length;i++) {
              if (r.quotes[i]) m.quotes[i].msg_id = r.quotes[i];
            }
          }
        } catch {}
      }

      for (const m of normalized) {
        await db.upsertUser({ username: m.username, numeric_user_id: m.numeric_user_id, profile_url: m.profile_url || null, avatar_url: m.avatar_url || null, badge: m.badge });
        let idea_id = null;
        if (m.ideas && m.ideas.length && opts.saveIdeas) {
          const idea = m.ideas[0];
          idea_id = idea.id;
          const enrich = await core.fetchIdeaDetails(idea.url || idea.id).catch(()=>null);
          await db.upsertIdea({
            idea_id: idea.id,
            symbol: idea.symbol || enrich?.symbol || null,
            url: idea.url || enrich?.url || null,
            author_username: enrich?.author_username || null,
            author_user_id: enrich?.author_user_id || null,
            title: enrich?.title || null,
            published_at_utc: enrich?.published_at_utc || null,
            like_count: (idea.likes ? parseInt(idea.likes,10) : null) ?? enrich?.like_count ?? null,
            preview_url: idea.preview || enrich?.preview_url || null,
            preview_local_path: null,
            text: enrich?.text || null,
            raw: enrich?.raw || null,
          });
        }
        await db.upsertMessage({ id: m.id, room: opts.room, username: m.username, badge: m.badge, symbol: m.symbol, utc: m.utc, time_title: m.time_title, content: m.text, idea_id, raw: { images: m.images, ideas: m.ideas, quotes: m.quotes || [] } });
        let savedLocal = [];
        if (m.images && m.images.length) {
          if (opts.saveImages) {
            savedLocal = await core.downloadImagesForMessage({ id: m.id.replace(/^ch-item-/, ''), urls: m.images, imagesDir: cfg.imagesDir });
          }
          const imgs = (savedLocal.length ? savedLocal.map(s => ({ ...s, kind: 'attachment' })) : m.images.map(u => ({ kind: 'attachment', original_url: u })));
          await db.insertImages({ message_id: m.id, idea_id, images: imgs });
        }
        pushCache(m);
        // Publish to Redis so frontend can broadcast to /chat/ws clients
        try {
          const wire = { ...m, raw: { quotes: m.quotes || [] } };
          await redis.publish(redisChannel, JSON.stringify({ id: m.id, message: wire }));
        } catch {}

        const idShort = (m.id || '').replace(/^ch-item-/, '');
        const when = (m.utc || '').slice(0,16).replace('T',' ');
        const sym = m.symbol ? ` [${m.symbol}]` : '';
        const imgSuffix = (savedLocal.length ? ` [img: ${savedLocal.map(s=>s.local_path).join(', ')}]` : (m.images && m.images.length ? ` [img: ${m.images.join(', ')}]` : ''));
        const ideaSuffix = (m.ideas && m.ideas.length) ? ` [idea: ${(m.ideas[0].symbol? m.ideas[0].symbol+'/':'') + (m.ideas[0].id||'')}]` : '';
        console.log(`${when} (${idShort}) ${m.username}${sym} — ${m.text || ''}${imgSuffix}${ideaSuffix}`.trim());
        messagesSinceLastKeepAlive++;
      }
    } catch (err) {
      console.error('onMessage error:', err.message);
    }
  });

  await page.evaluate(() => {
    function replaceEmojis(el) {
      const MAP = {
        ':agree:':'👍', ':disagree:':'👎', ':okay:':'👌', ':peace:':'✌️', ':wait:':'👆', ':wave:':'👋', ':raised_hands:':'🙌', ':pray:':'🙏',
        ':)':'🙂', ':D':'😄', ':joy:':'😂', ';)':'😉', ':love:':'😍', ':P':'😛', ':flushed:':'😳', ':|':'😐', ':thinking_face:':'🤔', ':(':'🙁', ':weary:':'😩', ":'(":'😢', ':cry:':'😭', ':panic:':'😱', ':rage:':'😡', ':triumph:':'😤', ':mask:':'😷', ':shades:':'😎', ':sleepy:':'😴', 'o_O':'😲', ':halo:':'😇', ':sarcasm:':'😬', ']:-)':'😈', ':money_mouth:':'🤑',
        ':zzz:':'💤', ':buy:':':buy:', ':sell:':':sell:', ':profit:':':profit:', ':loss:':':loss:', ':uptrend:':'📈', ':downtrend:':'📉',
        ':bear:':':bear:', ':bull:':':bull:', ':dollar:':':dollar:', ':euro:':':euro:', ':pound:':':pound:', ':yen:':':yen:', ':bitcoin:':':bitcoin:', ':ethereum:':':ethereum:', ':moneybag:':'💰',
        ':cookie:':'🍪', ':coffee:':'☕', ':popcorn:':'🍿', ':cocktail:':'🍸', ':hot:':'🔥',
        ':poop:':'💩', ':heart:':'❤️', ':heartbroken:':'💔',
        ':sun:':'☀️', ':moon:':'🌚', ':sunflower:':'🌻', ':star:':'⭐', ':sunny:':'🌤️', ':partly_sunny:':'⛅', ':cloud:':'☁️', ':zap:':'⚡',
        ':hammer:':'🔨', ':idea:':'💡', ':slot_machine:':'🎰', ':bullseye:':'🎯', ':rocket:':'🚀', ':inverted_rocket:':':inverted_rocket:', ':checkered_flag:':'🏁', ':alarm_clock:':'⏰', ':rip:':'🪦', ':ghost:':'👻',
        ':up:':'🆙', ':cool:':'🆒', ':free:':'🆓', ':sos:':'🆘', ':100:':'💯', ':stop:':'⛔'
      };
      const mapCode = (s) => {
        if (!s) return '';
        const t = String(s).trim();
        return MAP.hasOwnProperty(t) ? MAP[t] : t;
      };
      el.querySelectorAll('.tv-emoji-wrapper').forEach((em) => {
        const t = em.getAttribute('title') || '';
        const span = document.createElement('span');
        const mapped = mapCode(t);
        span.textContent = mapped ? ` ${mapped} ` : '';
        em.replaceWith(span);
      });
      el.querySelectorAll('img[alt]').forEach((img) => {
        const alt = (img.getAttribute('alt') || '').trim();
        if (!alt) return;
        const span = document.createElement('span');
        const mapped = mapCode(alt);
        span.textContent = ` ${mapped} `;
        img.replaceWith(span);
      });
    }
    function extract(it, onlyId) {
      const id = it.getAttribute('id') || null;
      const authorA = it.querySelector('.ch-item-author .ch-userlink');
      const user = authorA?.getAttribute('data-username') || (authorA?.textContent || '').trim() || null;
      const userIdClass = Array.from(it.classList).find(c => c.startsWith('ch-item-user-')) || '';
      const numeric_user_id = userIdClass ? Number(userIdClass.replace('ch-item-user-','')) : null;
      const badgeA = it.querySelector('.ch-userlink__badge-wrapper a');
      const badge = badgeA?.getAttribute('aria-label') || null;
      const avatarImg = it.querySelector('.ch-item-userpic img');
      const avatar = avatarImg ? new URL(avatarImg.getAttribute('src') || '', location.origin).toString() : null;
      const sym = (it.querySelector('.ch-item-symbol')?.textContent || '').replace(/,$/,'').trim() || null;
      const timeEl = it.querySelector('.ch-item-time time');
      const time = timeEl ? (timeEl.getAttribute('title') || timeEl.textContent || '').trim() : null;
      // Split into per-part messages
      const msgs = [];
      const parts = Array.from(it.querySelectorAll('.ch-item-text'));
      for (const part of parts) {
        // Collect all quote blocks in this part
        const qWraps = Array.from(part.querySelectorAll('.ch-item-quote'));
        const quotes = [];
        for (const qEl of qWraps) {
          const u = qEl.querySelector('a[data-username], a[href^="/u/"]');
          const qUser = u?.getAttribute('data-username') || (u?.textContent || '').replace(/^@/,'').trim() || null;
          const qClone = qEl.cloneNode(true);
          replaceEmojis(qClone);
          qClone.querySelectorAll('.ch-item-snapshot-link,.tv-widget-chart-like-button').forEach(n => n.remove());
          qClone.querySelectorAll('br').forEach(br => { br.replaceWith(document.createTextNode('\n')); });
          let qt = (qClone.textContent || '').replace(/\n{3,}/g,'\n\n').trim();
          if (qUser) {
            const re = new RegExp(`^@?${qUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*wrote:`, 'i');
            qt = qt.replace(re, '').trim();
          }
          const textParts = qt.split(/\n/).map(s => s.trim());
          // Gather images/ideas in this quote
          const qLinks = Array.from(qEl.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(Boolean);
          const qAbs = qLinks.map(h => new URL(h, location.origin).toString());
          const qPrev = Array.from(qEl.querySelectorAll('.ch-item-snapshot-preview img, .ch-item-chart-preview img'))
            .map(img => img.getAttribute('src')).filter(Boolean)
            .map(s => new URL(s, location.origin).toString());
          const qUrls = qAbs.concat(qPrev);
          const imgRe = /(\.(png|jpe?g|gif|webp)(\?|$))|\/x\//i;
          const qCand = qUrls.filter(u => imgRe.test(u)).filter(u => !/_thumb\./i.test(u));
          function qTok(u){
            const m1 = (u||'').match(/\/x\/([A-Za-z0-9]+)/i); if (m1) return m1[1];
            const m2 = (u||'').match(/\/snapshots\/([a-z])\/([A-Za-z0-9]+)\.(png|webp)/i); if (m2) return m2[2];
            return u;
          }
          // Combine links and previews, prefer /snapshots/; choose a single best image per quote
          const byAny = new Map();
          const all = qCand.concat(qPrev);
          for (const url of all) {
            const t = qTok(url);
            const prev = byAny.get(t);
            const snap = /\/snapshots\//i.test(url);
            if (!prev || (snap && !/\/snapshots\//i.test(prev))) byAny.set(t, url);
          }
          const quoteImages = Array.from(byAny.values());
          quotes.push({ user: qUser, text_parts: textParts, images: quoteImages, ideas: qPrev });
        }
        // Build a separate clone for media extraction to avoid removing preview nodes
        const mediaRoot = part.cloneNode(true);
        replaceEmojis(mediaRoot);
        // Exclude images/links inside quotes from body media
        mediaRoot.querySelectorAll('.ch-item-quote').forEach(n => n.remove());
        const mediaLinks = Array.from(mediaRoot.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(Boolean);
        const abs = mediaLinks.map(h => new URL(h, location.origin).toString());
        const previews = Array.from(mediaRoot.querySelectorAll('.ch-item-snapshot-preview img, .ch-item-chart-preview img')).map(img => img.getAttribute('src')).filter(Boolean).map(s => new URL(s, location.origin).toString());
        const urls = abs.concat(previews);
        const imgRe = /(\.(png|jpe?g|gif|webp)(\?|$))|\/x\//i;
        const cand = urls.filter(u => imgRe.test(u)).filter(u => !/_thumb\./i.test(u));
        function tokenOf(u){
          const m1 = (u||'').match(/\/x\/([A-Za-z0-9]+)/i); if (m1) return m1[1];
          const m2 = (u||'').match(/\/snapshots\/([a-z])\/([A-Za-z0-9]+)\.(png|webp)/i); if (m2) return m2[2];
          return u;
        }
        const byToken = new Map();
        for (const u of cand){
          const t = tokenOf(u);
          const prev = byToken.get(t);
          if (!prev || (/\/snapshots\//i.test(u) && !/\/snapshots\//i.test(prev))) byToken.set(t, u);
        }
        const images = Array.from(byToken.values());
        // Now build text content from a cleaned copy (remove UI wrappers/labels)
        const copy = part.cloneNode(true);
        replaceEmojis(copy);
        const qAll = copy.querySelectorAll('.ch-item-quote'); qAll.forEach(n => n.remove());
        copy.querySelectorAll('.ch-item-snapshot-link,.tv-widget-chart-like-button,.ch-item-chart-link,.ch-item-chart-preview,.ch-item-preview-wrap').forEach(n => n.remove());
        copy.querySelectorAll('br').forEach(br => { br.replaceWith(document.createTextNode('\n')); });
        const text = (copy.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
        const msgId = part.getAttribute('id') || id;
        if (!onlyId || (msgId && msgId === onlyId)) {
          msgs.push({ id: msgId, user, numeric_user_id, badge, avatar, symbol: sym, time, text, quotes, images, ideas: [] });
        }
      }
      // idea/script detection on container: attach to first message if present
      const ideaA = it.querySelector('.ch-item-chart-link a[data-publication-type="idea"], .ch-item-chart-link a[data-publication-type="script"]');
      if (ideaA && msgs.length) {
        const idea_id = ideaA.getAttribute('data-id') || null;
        const idea_symbol = ideaA.getAttribute('data-symbol') || null;
        const rawUrl = ideaA.getAttribute('data-url') || ideaA.getAttribute('href') || '';
        const idea_url = new URL(rawUrl, location.origin).toString();
        const likesEl = it.querySelector('.js-chart-like .js-likes-counter');
        const like_count = likesEl ? (likesEl.textContent || '').trim() : null;
        const previewImg = it.querySelector('.ch-item-chart-preview img');
        const preview = previewImg ? (previewImg.getAttribute('src') || '') : null;
        msgs[0].ideas = [{ id: idea_id, symbol: idea_symbol, url: idea_url, likes: like_count, preview }];
      }
      return msgs;
    }
    // Prefer the chat container if present (for initial backfill), but always
    // observe the entire document body so we survive container re-mounts.
    const root = document.querySelector('.ch-data') || document.body;
    // Track seen by message-id: prefer part.id; fallback to container.id for singles
    const seen = new Set();
    Array.from(root.querySelectorAll('.ch-item')).forEach(cont => {
      const cid = cont.getAttribute('id') || null;
      const parts = cont.querySelectorAll('.ch-item-text');
      if (!parts.length && cid) { seen.add(cid); }
      parts.forEach(p => { const mid = p.getAttribute('id') || cid; if (mid) seen.add(mid); });
    });
    const obs = new MutationObserver((muts) => {
      const acc = [];
      for (const m of muts) {
        for (const node of m.addedNodes || []) {
          if (!(node instanceof Element)) continue;
          // direct part added
          if (node.matches && node.matches('.ch-item-text')) {
            const cont = node.closest('.ch-item');
            const cid = cont ? cont.getAttribute('id') : null;
            const mid = node.getAttribute('id') || cid;
            if (mid && !seen.has(mid)) { seen.add(mid); acc.push(...extract(cont, mid)); }
          }
          // parts added within subtree
          const items = node.querySelectorAll ? node.querySelectorAll('.ch-item-text') : [];
          for (const it of items) {
            const cont = it.closest('.ch-item');
            const cid = cont ? cont.getAttribute('id') : null;
            const mid = it.getAttribute('id') || cid;
            if (mid && !seen.has(mid)) { seen.add(mid); acc.push(...extract(cont, mid)); }
          }
        }
      }
      if (acc.length) window.___emitNewMessages(acc);
    });
    // IMPORTANT: observe on document.body instead of the chat container.
    // TradingView occasionally re-mounts the chat root (.ch-data). If we
    // observe the specific container and it gets replaced, the observer goes
    // silent. Observing the body ensures we continue to detect newly-added
    // .ch-item/.ch-item-text nodes across re-renders.
    obs.observe(document.body, { childList: true, subtree: true });
    window.___tvObserverInstalled = true;
  });

  // Periodically ensure observer is installed (guards against SPA remounts)
  const ensureObserver = setInterval(async () => {
    try {
      await page.evaluate(() => {
        try {
          if (!window.___tvObserverInstalled) {
            // Reinstall quickly by re-attaching the same logic
            const root = document.querySelector('.ch-data') || document.body;
            const seen = new Set();
            Array.from(root.querySelectorAll('.ch-item')).forEach(cont => {
              const cid = cont.getAttribute('id') || null;
              const parts = cont.querySelectorAll('.ch-item-text');
              if (!parts.length && cid) { seen.add(cid); }
              parts.forEach(p => { const mid = p.getAttribute('id') || cid; if (mid) seen.add(mid); });
            });
            const obs = new MutationObserver((muts) => {
              const acc = [];
              for (const m of muts) {
                for (const node of m.addedNodes || []) {
                  if (!(node instanceof Element)) continue;
                  if (node.matches && node.matches('.ch-item-text')) {
                    const cont = node.closest('.ch-item');
                    const cid = cont ? cont.getAttribute('id') : null;
                    const mid = node.getAttribute('id') || cid;
                    if (mid && !seen.has(mid)) { seen.add(mid); acc.push(...(window.___extractOne ? window.___extractOne(cont, mid) : [])); }
                  }
                  const items = node.querySelectorAll ? node.querySelectorAll('.ch-item-text') : [];
                  for (const it of items) {
                    const cont = it.closest('.ch-item');
                    const cid = cont ? cont.getAttribute('id') : null;
                    const mid = it.getAttribute('id') || cid;
                    if (mid && !seen.has(mid)) { seen.add(mid); acc.push(...(window.___extractOne ? window.___extractOne(cont, mid) : [])); }
                  }
                }
              }
              if (acc.length && window.___emitNewMessages) window.___emitNewMessages(acc);
            });
            obs.observe(document.body, { childList: true, subtree: true });
            window.___tvObserverInstalled = true;
          }
        } catch (e) {}
      });
    } catch (e) {}
  }, 15000);

  console.log('[Ready] Streaming. Press Ctrl+C to stop.');
  process.on('SIGINT', async () => {
    try { clearInterval(keepAlive); } catch {}
    try { clearInterval(healthCheck); } catch {}
    try { clearInterval(ensureObserver); } catch {}
    try { await browser.close(); } catch {}
    try { await db.pool.end(); } catch {}
    try { await redis.quit(); } catch {}
    process.exit(0);
  });
})();
