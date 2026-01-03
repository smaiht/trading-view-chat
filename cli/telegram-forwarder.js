#!/usr/bin/env node
const { createClient } = require('redis');
const cfg = require('../src/config');
const { DB } = require('../src/db');
const { TelegramClient, escHtml } = require('../src/telegram');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeNewlines(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function composeCaption({ m, omitHeader = false }) {
  // m: { username, badge, symbol, text, quotes?: [{user,text_parts,images,ideas,msg_id}], raw?: {quotes: [...]} }
  const profileUrl = m.username ? `https://www.tradingview.com/u/${encodeURIComponent(m.username)}/` : null;
  const name = m.username ? `<a href=\"${profileUrl}\">${escHtml(m.username)}</a>` : 'unknown';
  const suffixParts = [];
  if (m.badge) suffixParts.push(escHtml(m.badge));
  if (m.symbol) suffixParts.push(escHtml(m.symbol));
  const suffix = suffixParts.length ? ` | ${suffixParts.join(' | ')}` : '';
  const header = omitHeader ? '' : `<b>${name}</b>${suffix}`;
  const quotes = (m?.raw?.quotes && Array.isArray(m.raw.quotes) && m.raw.quotes.length)
    ? m.raw.quotes
    : (Array.isArray(m.quotes) ? m.quotes : []);
  // Render quotes inside <blockquote>, using newline characters (no <br>)
  const quoteBlocks = (quotes || []).map(q => {
    const parts = Array.isArray(q.text_parts) ? q.text_parts : [];
    const textJoined = parts.length ? parts.map(p => escHtml(p)).join('\n') : '';
    return `\n<blockquote><b>${escHtml(q.user || '')}</b>:\n${textJoined}</blockquote>`;
  }).join('');
  const hasAnyQuote = (quotes || []).length > 0;
  // If header is omitted, avoid leading blank line before body
  const body = m.text
    ? `${omitHeader ? '' : (hasAnyQuote ? '\n' : '\n\n')}${escHtml(normalizeNewlines(m.text))}`
    : '';
  // Append idea link on a new line if present
  const ideaUrl = (Array.isArray(m.ideas) && m.ideas[0] && m.ideas[0].url) ? String(m.ideas[0].url) : null;
  const ideaLine = ideaUrl ? `\n\nPublished Idea: ${escHtml(ideaUrl)}` : '';
  return (header + quoteBlocks + body + ideaLine).trim();
}

class SeqQueue {
  constructor() { this.q = []; this.running = false; }
  push(fn) {
    this.q.push(fn);
    try { console.log(`[TG][Q] push size=${this.q.length}`); } catch {}
    this._drain();
  }
  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.q.length) {
        const fn = this.q.shift();
        try { console.log(`[TG][Q] drain size=${this.q.length}`); } catch {}
        try { await fn(); } catch (e) { console.error('[TG][TASK][ERR]', e?.message || e); }
      }
    } finally {
      this.running = false;
    }
  }
}

(async () => {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
    process.exit(2);
  }
  const tg = new TelegramClient({ token: cfg.telegramBotToken, chatId: cfg.telegramChatId });
  let lastUser = null;
  const db = new DB({ connectionString: cfg.databaseUrl });

  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisUrl = process.env.REDIS_URL || `redis://${redisHost}:6379`;
  const redisChannel = process.env.CHAT_REDIS_CHANNEL || 'chat:messages';
  const sub = createClient({ url: redisUrl });
  await sub.connect();
  const queue = new SeqQueue();

  // Do not wait for parent; use if immediately available only

  async function sendOne(m, attempt = 0, enqueuedAt = null) {
    // Skip if already has tg id
    const existing = await db.getTgMsgId(m.id);
    if (existing) {
      try { console.log(`[TG][SKIP] already sent id=${m.id} tg_msg_id=${existing}`); } catch {}
      return;
    }
    const now = Date.now();
    const waitMs = enqueuedAt ? (now - enqueuedAt) : null;
    try { console.log(`[TG][BEGIN] id=${m.id} attempt=${attempt+1} wait_ms=${waitMs ?? '-'} quotes=${Array.isArray(m?.raw?.quotes||m?.quotes) ? (m.raw?.quotes||m.quotes).length : 0}`); } catch {}
    // Determine reply parent from first quote msg_id, if available
    let parentTg = null;
    try {
      const qs = (m && m.raw && Array.isArray(m.raw.quotes)) ? m.raw.quotes : (Array.isArray(m.quotes) ? m.quotes : []);
      const parentId = (qs && qs[0] && qs[0].msg_id) ? String(qs[0].msg_id) : null;
      parentTg = parentId ? (await db.getTgMsgId(parentId)) : null;
    } catch {}
    // Prefer source URLs from the event; fallback to DB original_url if needed
    const eventImgs = Array.isArray(m.images) ? m.images.filter(u => typeof u === 'string' && u.trim()) : [];
    let urls = eventImgs;
    if (!urls.length) {
      const dbImgs = await db.getImagesForMessage(m.id);
      urls = dbImgs.map(i => i.original_url).filter(Boolean);
    }

    // Build caption/body
    const sameSender = !!(lastUser && m.username && lastUser === String(m.username));
    const caption = composeCaption({ m, omitHeader: sameSender });

    let resultMsgId = null;
    try {
      const callStarted = Date.now();
      console.log(`[TG][SEND] id=${m.id} user=${m.username || '-'} images=${urls.length} reply_to=${parentTg || '-'} caption_len=${(caption||'').length} omit_header=${sameSender}`);
      if (urls.length === 0) {
        // Text-only
        const res = await tg.sendMessage({ text: caption, parse_mode: 'HTML', reply_to_message_id: parentTg || undefined, disable_web_page_preview: true });
        resultMsgId = res.message_id;
        const dur = Date.now() - callStarted;
        console.log(`[TG][OK] id=${m.id} type=message msg_id=${resultMsgId} dur_ms=${dur}`);
      } else if (urls.length === 1) {
        try {
          const res = await tg.sendPhoto({ photo: urls[0], caption, parse_mode: 'HTML', reply_to_message_id: parentTg || undefined });
          resultMsgId = res.message_id;
          const dur = Date.now() - callStarted;
          console.log(`[TG][OK] id=${m.id} type=photo msg_id=${resultMsgId} dur_ms=${dur}`);
        } catch (e) {
          // Fallback to text-only if media upload/fetch fails
          console.warn(`[TG][PHOTO][ERR] id=${m.id} ${e?.message || e}`);
          const res2 = await tg.sendMessage({ text: caption, parse_mode: 'HTML', reply_to_message_id: parentTg || undefined, disable_web_page_preview: true });
          resultMsgId = res2.message_id;
          const dur = Date.now() - callStarted;
          console.log(`[TG][OK] id=${m.id} type=message msg_id=${resultMsgId} dur_ms=${dur}`);
        }
      } else {
        try {
          const items = urls.map((p, i) => ({ type: 'photo', media: p, caption: i === 0 ? caption : undefined, parse_mode: i === 0 ? 'HTML' : undefined }));
          const res = await tg.sendMediaGroup({ items, reply_to_message_id: parentTg || undefined });
          // sendMediaGroup returns array of messages; pick the first as canonical
          const dur = Date.now() - callStarted;
          if (Array.isArray(res) && res.length) resultMsgId = res[0].message_id;
          console.log(`[TG][OK] id=${m.id} type=media_group count=${Array.isArray(res)?res.length:0} first_msg_id=${resultMsgId || '-'} dur_ms=${dur}`);
        } catch (e) {
          console.warn(`[TG][GROUP][ERR] id=${m.id} ${e?.message || e}`);
          const res2 = await tg.sendMessage({ text: caption, parse_mode: 'HTML', reply_to_message_id: parentTg || undefined, disable_web_page_preview: true });
          resultMsgId = res2.message_id;
          const dur = Date.now() - callStarted;
          console.log(`[TG][OK] id=${m.id} type=message msg_id=${resultMsgId} dur_ms=${dur}`);
        }
      }
    } catch (e) {
      // Handle rate limit retry
      const retryAfter = e?.data?.parameters?.retry_after || e?.data?.retry_after;
      if (e?.status === 429 && retryAfter) {
        const waitMs = (Number(retryAfter) || 1) * 1000;
        console.warn(`[TG][RATE] id=${m.id} retry_after=${retryAfter}s wait_ms=${waitMs}`);
        await sleep(waitMs);
        return sendOne(m, attempt, enqueuedAt); // retry same attempt level after backoff
      }
      if (attempt < 5) {
        const waitMs = Math.min(30000, 1000 * Math.pow(2, attempt));
        console.warn(`[TG][RETRY] id=${m.id} attempt=${attempt+1} wait_ms=${waitMs} err=${e?.message || e}`);
        await sleep(waitMs);
        return sendOne(m, attempt + 1, enqueuedAt);
      }
      console.error(`[TG][FAIL] id=${m.id} attempts=${attempt+1} err=${e?.message || e}`);
      throw e;
    }

    if (resultMsgId) {
      await db.setTgMsgId(m.id, resultMsgId);
      try { console.log(`[TG][DONE] id=${m.id} tg_msg_id=${resultMsgId}`); } catch {}
      lastUser = m && m.username ? String(m.username) : lastUser;
    }
  }

  await sub.subscribe(redisChannel, (raw) => {
    try {
      const ev = JSON.parse(raw);
      const m = ev.message || ev.m || null;
      if (!m || !m.id) return;
      const enqueuedAt = Date.now();
      queue.push(() => sendOne(m, 0, enqueuedAt));
    } catch (e) {
      console.error('[TG][PARSE][ERR]', e?.message || e);
    }
  });

  console.log(`[TG] Forwarder ready. Subscribed to ${redisChannel}.`);

  // ============================================================
  // BTC Price Updater (parallel task) - via OKX Public API
  // ============================================================
  const PRICE_UPDATE_INTERVAL = 60 * 1000; // 1 minute (API is public, no need to hammer)
  const PRICE_MESSAGE_ID = process.env.BTC_PRICE_MESSAGE_ID ? parseInt(process.env.BTC_PRICE_MESSAGE_ID, 10) : 0;

  function formatNumber(num, decimals = 2) {
    return Number(num).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function formatVolume(num) {
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
    return num.toFixed(2);
  }

  async function fetchOkxTicker() {
    const res = await fetch('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP');
    const json = await res.json();
    if (json.code !== '0' || !json.data?.[0]) return null;
    const d = json.data[0];
    return {
      last: parseFloat(d.last),
      open24h: parseFloat(d.open24h),
      high24h: parseFloat(d.high24h),
      low24h: parseFloat(d.low24h),
      vol24h: parseFloat(d.vol24h),
      ts: new Date(parseInt(d.ts, 10))
    };
  }

  async function fetchOkxFunding() {
    const res = await fetch('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP');
    const json = await res.json();
    if (json.code !== '0' || !json.data?.[0]) return null;
    return parseFloat(json.data[0].fundingRate);
  }

  async function updateBtcPrice() {
    try {
      const ticker = await fetchOkxTicker();
      if (!ticker) return;

      const fundingRate = await fetchOkxFunding().catch(() => null);

      const change24h = ticker.open24h ? ((ticker.last - ticker.open24h) / ticker.open24h * 100) : null;
      const changeAbs = ticker.open24h ? (ticker.last - ticker.open24h) : null;
      const emoji = (!change24h || Math.abs(change24h) < 0.01) ? '⚪' : (change24h > 0 ? '🟢' : '🔴');
      const sign = change24h >= 0 ? '+' : '';
      const timeStr = ticker.ts.toISOString().replace('T', ' ').substring(0, 16);

      // Line 1: Price
      let msg = `💰 <b>$${formatNumber(ticker.last, 0)}</b>\n\n`;

      // 24h stats
      msg += `📊 <b>24h:</b> ${emoji} <b>${sign}${change24h?.toFixed(2) || '0.00'}%</b>`;
      if (changeAbs !== null) msg += ` (${sign}$${formatNumber(Math.abs(changeAbs), 0)})`;
      msg += '\n';
      msg += `O: $${formatNumber(ticker.open24h, 0)}\n`;
      msg += `H: $${formatNumber(ticker.high24h, 0)}\n`;
      msg += `L: $${formatNumber(ticker.low24h, 0)}\n\n`;

      // Volume + Funding
      let stats = [];
      if (ticker.vol24h) stats.push(`Vol: ${formatVolume(ticker.vol24h)}`);
      if (fundingRate !== null) stats.push(`FR: ${(fundingRate * 100).toFixed(4)}%`);
      if (stats.length) msg += `📈 ${stats.join(' • ')}\n\n`;

      msg += `⏰ <i>${timeStr} UTC</i>`;

      // Update message
      await tg.editMessageText({
        message_id: PRICE_MESSAGE_ID,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });

      console.log(`[BTC] Updated: $${formatNumber(ticker.last, 1)} (${sign}${change24h?.toFixed(2) || '0.00'}%)`);

    } catch (err) {
      // Silently ignore "message is not modified" errors
      if (err.message && !err.message.includes('message is not modified')) {
        console.error(`[BTC] Error: ${err.message}`);
      }
    }
  }

  // Start price updater
  if (PRICE_MESSAGE_ID > 0) {
    console.log(`[BTC] Price updater enabled. Message ID: ${PRICE_MESSAGE_ID}, Interval: ${PRICE_UPDATE_INTERVAL/1000}s`);
    updateBtcPrice(); // Initial update
    setInterval(updateBtcPrice, PRICE_UPDATE_INTERVAL);
  } else {
    console.log(`[BTC] Price updater disabled (BTC_PRICE_MESSAGE_ID not set)`);
  }
  // ============================================================

  process.on('SIGINT', async () => { try { await sub.quit(); } catch {} try { await db.pool.end(); } catch {} process.exit(0); });
})();
