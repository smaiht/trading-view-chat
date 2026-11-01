#!/usr/bin/env node
// TradingView Ideas poller: posts new ideas to Telegram as chart + excerpt,
// with the full text (and author updates) on a Telegraph page.
const { DB } = require('../src/db');
const cfg = require('../src/config');
const ideas = require('../src/ideas');
const { TelegramClient } = require('../src/telegram');
const { TelegraphClient } = require('../src/telegraph');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRateLimit(fn) {
  try {
    return await fn();
  } catch (e) {
    const retryAfter = e?.data?.parameters?.retry_after;
    if (e?.status !== 429 || !retryAfter) throw e;
    console.warn(`[Ideas][TG] rate limited, waiting ${retryAfter}s`);
    await sleep(Number(retryAfter) * 1000);
    return fn();
  }
}

(async () => {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
    process.exit(2);
  }
  const tg = new TelegramClient({ token: cfg.telegramBotToken, chatId: cfg.telegramChatId });
  const telegraph = cfg.telegraphToken ? new TelegraphClient({ token: cfg.telegraphToken }) : null;
  if (!telegraph) console.warn('[Ideas] TELEGRAPH_TOKEN not set, posting without full-text pages');

  const db = new DB({ connectionString: cfg.databaseUrl });
  // Columns added for this service (schema.sql only runs on a fresh volume)
  await db.pool.query('ALTER TABLE tv_ideas ADD COLUMN IF NOT EXISTS telegraph_url TEXT');
  await db.pool.query('ALTER TABLE tv_ideas ADD COLUMN IF NOT EXISTS tg_msg_id BIGINT');

  // Feeds with no rows yet get seeded silently, except for the last backfill window
  const seeding = new Map();
  for (const sym of cfg.ideasSymbols) seeding.set(sym, !(await db.hasIdeasFromFeed(sym)));

  console.log(`[Ideas] Polling ${cfg.ideasSymbols.join(', ')} every ${cfg.ideasPollInterval / 1000}s`);

  async function forward(idea) {
    const telegraphUrl = telegraph
      ? await telegraph.createPage({
          title: idea.name,
          author_name: idea.user?.username,
          author_url: idea.user?.username ? `https://www.tradingview.com/u/${encodeURIComponent(idea.user.username)}/` : undefined,
          content: ideas.buildTelegraphContent(idea),
        }).catch(e => { console.error(`[Ideas] Telegraph failed for ${idea.uuid}: ${e.message}`); return null; })
      : null;
    const caption = ideas.buildCaption(idea, telegraphUrl);
    let msg;
    try {
      msg = await withRateLimit(() => tg.sendPhoto({ photo: idea.image?.big, caption, parse_mode: 'HTML' }));
    } catch (e) {
      console.warn(`[Ideas][TG] photo failed for ${idea.uuid}, sending text: ${e.message}`);
      msg = await withRateLimit(() => tg.sendMessage({ text: caption, parse_mode: 'HTML', disable_web_page_preview: false }));
    }
    return { telegraphUrl, tgMsgId: msg?.message_id || null };
  }

  async function save(item, sym, detail) {
    const src = detail || item;
    await db.upsertIdea({
      idea_id: item.image_url,
      symbol: item.symbol?.full_name || null,
      url: item.chart_url,
      author_username: item.user?.username || null,
      author_user_id: item.user?.id || null,
      title: item.name,
      published_at_utc: item.created_at ? new Date(item.created_at).toISOString() : null,
      like_count: item.likes_count ?? null,
      preview_url: item.image?.big || null,
      preview_local_path: null,
      text: src.description || null,
      raw: { feed: sym, ...src },
    });
  }

  async function pollSymbol(sym) {
    const list = await ideas.fetchIdeas(sym);
    const now = Date.now();
    const publishFrom = now - (seeding.get(sym) ? cfg.ideasBackfillMinutes * 60 * 1000 : cfg.ideasMaxAgeHours * 3600 * 1000);
    let saved = 0, sent = 0;
    const items = list
      .filter(i => i.image_url && !i.is_script && i.is_visible !== false && i.is_public !== false)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    for (const item of items) {
      if (await db.ideaExists(item.image_url)) continue;
      if (new Date(item.created_at).getTime() < publishFrom) {
        await save(item, sym, null);
        saved++;
        continue;
      }
      try {
        const detail = await ideas.fetchIdea(item.image_url);
        const { telegraphUrl, tgMsgId } = await forward(detail);
        await save(item, sym, detail);
        await db.setIdeaForwarded(item.image_url, telegraphUrl, tgMsgId);
        saved++; sent++;
        console.log(`[Ideas] ${item.created_at.slice(0, 16).replace('T', ' ')} [${item.symbol?.short_name}] ${item.user?.username}: ${item.name} -> tg ${tgMsgId}${telegraphUrl ? ` ${telegraphUrl}` : ''}`);
      } catch (e) {
        // Not saved, so it is retried on the next poll
        console.error(`[Ideas] ${item.image_url} failed: ${e?.message || e}`);
      }
    }
    seeding.set(sym, false);
    if (saved) console.log(`[Ideas] ${sym}: saved ${saved}, sent ${sent}`);
  }

  let stopping = false;
  const stop = async () => {
    stopping = true;
    try { await db.pool.end(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    for (const sym of cfg.ideasSymbols) {
      try { await pollSymbol(sym); } catch (e) { console.error(`[Ideas] ${sym} poll failed: ${e?.message || e}`); }
    }
    await sleep(cfg.ideasPollInterval);
  }
})().catch(e => { console.error('[Ideas] fatal', e); process.exit(1); });
