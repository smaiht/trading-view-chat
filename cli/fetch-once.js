#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { DB } = require('../src/db');
const cfg = require('../src/config');
const core = require('../src/core');

function parseArgs() {
  const args = process.argv.slice(2);
  const roomIdx = Math.max(args.indexOf('--room'), args.indexOf('-r'));
  const limitIdx = Math.max(args.indexOf('--limit'), args.indexOf('-n'));
  const noImg = args.includes('--no-save-images');
  const noIdeas = args.includes('--no-save-ideas');
  return {
    room: roomIdx !== -1 ? args[roomIdx + 1] : (process.env.ROOM_URL || cfg.roomUrl),
    limit: limitIdx !== -1 ? Math.max(1, parseInt(args[limitIdx + 1] || '50', 10)) : 50,
    saveImages: noImg ? false : cfg.saveImages,
    saveIdeas: noIdeas ? false : cfg.saveIdeas,
  };
}

(async () => {
  const opts = parseArgs();
  const db = new DB({ connectionString: cfg.databaseUrl });

  const { browser, page } = await core.launchBrowser();
  await core.navigateRoom(page, opts.room);

  const all = await core.extractAllMessages(page);
  // Take last N messages
  const take = all.slice(-opts.limit);

  function tokenOf(u){
    const s = String(u||'');
    const m1 = s.match(/\/x\/([A-Za-z0-9]+)/i); if (m1) return m1[1];
    const m2 = s.match(/\/snapshots\/([a-z])\/([A-Za-z0-9]+)\.(png|webp)/i); if (m2) return m2[2];
    return null;
  }
  function escLike(s){ return String(s||'').replace(/[\\%_]/g, ch => `\\${ch}`); }

  async function findParentsForQuotes(m){
    if (!Array.isArray(m.quotes) || !m.quotes.length) return { primary: null, quotes: [] };
    const parents = [];
    let primary = null;
    for (const q of m.quotes) {
      const qUser = q && q.user ? String(q.user) : null;
      let found = null;
      if (qUser) {
        const fullText = (q && q.text ? String(q.text).trim() : '');
        const parts = Array.isArray(q.text_parts) ? q.text_parts.filter(Boolean) : [];
        // 1) Try concatenated text first (handles single message broken into lines)
        if (!found && (parts.length > 1 || /\n/.test(fullText))) {
          const concat = (parts.length ? parts.join('') : fullText.replace(/[\s\u00A0]+/g, '')).slice(0, 400);
          try {
            const resC = await db.pool.query(
              `SELECT id FROM tv_messages
                 WHERE username=$1 AND replace(replace(replace(replace(content, E'\r',''), E'\n',''), ' ', ''), E'\t','') ILIKE $2 ESCAPE '\\'
               ORDER BY COALESCE(utc, created_at) DESC NULLS LAST LIMIT 1`,
              [qUser, `%${escLike(concat)}%`]
            );
            if (resC.rows.length) found = resC.rows[0].id;
          } catch {}
        }
        // 2) Full text match as-is
        if (!found && fullText) {
          try {
            const res = await db.pool.query(
              `SELECT id FROM tv_messages WHERE username=$1 AND content ILIKE $2 ESCAPE '\\' ORDER BY COALESCE(utc, created_at) DESC NULLS LAST LIMIT 1`,
              [qUser, `%${escLike(fullText.slice(0,400))}%`]
            );
            if (res.rows.length) found = res.rows[0].id;
          } catch {}
        }
        // 3) Per-part matching
        if (!found && parts.length) {
          for (const p of parts) {
            try {
              const resP = await db.pool.query(
                `SELECT id FROM tv_messages WHERE username=$1 AND content ILIKE $2 ESCAPE '\\' ORDER BY COALESCE(utc, created_at) DESC NULLS LAST LIMIT 1`,
                [qUser, `%${escLike(String(p).slice(0,400))}%`]
              );
              if (resP.rows.length) { found = resP.rows[0].id; break; }
            } catch {}
          }
        }
        // 4) Fallback media tokens
        if (!found) {
          const qImgs = Array.isArray(q.images) ? q.images : [];
          const qIdeas = Array.isArray(q.ideas) ? q.ideas : [];
          const tokens = Array.from(new Set([...qImgs, ...qIdeas].map(tokenOf).filter(Boolean)));
          for (const t of tokens) {
            try {
            const resI = await db.pool.query(
                `SELECT i.message_id FROM tv_images i JOIN tv_messages pm ON pm.id=i.message_id WHERE pm.username=$1 AND (i.original_url ILIKE $2 OR i.local_path ILIKE $2) ORDER BY COALESCE(pm.utc, pm.created_at) DESC NULLS LAST LIMIT 1`,
                [qUser, `%${t}%`]
              );
              if (resI.rows.length) { found = resI.rows[0].message_id; break; }
            } catch {}
            try {
            const resD = await db.pool.query(
              `SELECT m.id FROM tv_ideas d JOIN tv_messages m ON m.idea_id=d.idea_id WHERE m.username=$1 AND d.preview_url ILIKE $2 ORDER BY COALESCE(m.utc, m.created_at) DESC NULLS LAST LIMIT 1`,
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

  for (const m of take) {
    try {
      const r = await findParentsForQuotes(m);
      if (Array.isArray(m.quotes) && Array.isArray(r.quotes)) {
        for (let i=0;i<m.quotes.length;i++) {
          if (r.quotes[i]) m.quotes[i].msg_id = r.quotes[i];
        }
      }
    } catch {}
  }

  // Persist
  for (const m of take) {
    await db.upsertUser({ username: m.username, numeric_user_id: m.numeric_user_id, profile_url: m.profile_url || null, avatar_url: m.avatar || null, badge: m.badge });
    let idea_id = null;
    if (m.ideas && m.ideas.length && opts.saveIdeas) {
      const idea = m.ideas[0];
      idea_id = idea.id;
      const enrich = await core.fetchIdeaDetails(idea.url).catch(()=>null);
      await db.upsertIdea({ idea_id: idea.id, symbol: idea.symbol, url: idea.url, author_username: enrich?.author_username || null, author_user_id: null, title: enrich?.title || null, published_at_utc: enrich?.published_at_utc || null, like_count: idea.likes ? parseInt(idea.likes,10) : null, preview_url: idea.preview || null, preview_local_path: null, text: enrich?.text || null });
    }
    await db.upsertMessage({ id: m.id, room: opts.room, username: m.username, badge: m.badge, symbol: m.symbol, utc: m.utc, time_title: m.time_title, content: m.text, idea_id, raw: { images: m.images, ideas: m.ideas, quotes: m.quotes || [] } });
    if (m.images && m.images.length) {
      let saved = [];
      if (opts.saveImages) {
        saved = await core.downloadImagesForMessage({ id: m.id.replace(/^ch-item-/, ''), urls: m.images, imagesDir: cfg.imagesDir });
      }
      const imgs = (saved.length ? saved.map(s => ({ ...s, kind: 'attachment' })) : m.images.map(u => ({ kind: 'attachment', original_url: u })));
      await db.insertImages({ message_id: m.id, idea_id: idea_id, images: imgs });
    }
  }

  await browser.close();
  await db.pool.end();
  console.log(`Saved ${take.length} messages.`);
})();
