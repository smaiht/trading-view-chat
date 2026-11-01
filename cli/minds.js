#!/usr/bin/env node
// TradingView Minds poller: replacement for the public chat scraper
// (public chats were retired on 2026-09-30). Saves new posts to Postgres and
// publishes them to the same Redis channel the Telegram forwarder listens to.
const { DB } = require('../src/db');
const { createClient } = require('redis');
const cfg = require('../src/config');
const minds = require('../src/minds');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const db = new DB({ connectionString: cfg.databaseUrl });

  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisUrl = process.env.REDIS_URL || `redis://${redisHost}:6379`;
  const redisChannel = process.env.CHAT_REDIS_CHANNEL || 'chat:messages';
  const redis = createClient({ url: redisUrl });
  await redis.connect();

  // Rooms with no rows yet get seeded silently, except for the last backfill window
  const seeding = new Map();
  for (const sym of cfg.mindsSymbols) {
    seeding.set(sym, !(await db.getLastMessageUtc(`minds:${sym}`)));
  }

  console.log(`[Minds] Polling ${cfg.mindsSymbols.join(', ')} every ${cfg.mindsPollInterval / 1000}s`);

  async function pollSymbol(sym) {
    const room = `minds:${sym}`;
    const items = await minds.fetchMinds(sym);
    const backfillFrom = Date.now() - cfg.mindsBackfillMinutes * 60 * 1000;
    let added = 0, published = 0;
    // API is newest-first; forward in chronological order
    for (const item of items.slice().reverse()) {
      if (item.hidden || item.can_view === false || item.access !== 'public') continue;
      const m = minds.normalizeMind(item, sym);
      if (await db.getMessageById(m.id)) continue;

      await db.upsertUser({ username: m.username, profile_url: m.profile_url, avatar_url: m.avatar_url, badge: m.badge });
      await db.upsertMessage({ id: m.id, room, username: m.username, badge: m.badge, symbol: m.symbol, utc: m.utc, time_title: null, content: m.text, idea_id: null, raw: { url: m.url, images: m.images, ideas: m.ideas, quotes: [] } });
      await db.insertImages({ message_id: m.id, idea_id: null, images: m.images.map(u => ({ kind: 'attachment', original_url: u })) });
      added++;

      if (seeding.get(sym) && new Date(m.utc).getTime() < backfillFrom) continue;
      const wire = { ...m, raw: { quotes: [] } };
      await redis.publish(redisChannel, JSON.stringify({ id: m.id, message: wire }));
      published++;
      console.log(`[Minds] ${m.utc.slice(0, 16).replace('T', ' ')} [${m.symbol}] ${m.username}: ${m.text.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
    seeding.set(sym, false);
    if (added) console.log(`[Minds] ${sym}: saved ${added}, published ${published}`);
  }

  let stopping = false;
  const stop = async () => {
    stopping = true;
    try { await redis.quit(); } catch {}
    try { await db.pool.end(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    for (const sym of cfg.mindsSymbols) {
      try { await pollSymbol(sym); } catch (e) { console.error(`[Minds] ${sym} poll failed: ${e?.message || e}`); }
    }
    await sleep(cfg.mindsPollInterval);
  }
})().catch(e => { console.error('[Minds] fatal', e); process.exit(1); });
