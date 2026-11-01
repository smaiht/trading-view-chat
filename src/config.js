const fs = require('fs');
const path = require('path');
require('dotenv').config();

function boolFromEnv(name, def = true) {
  const v = process.env[name];
  if (v === undefined) return def;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  }
  return def;
}

module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/tvchat',
  roomUrl: process.env.ROOM_URL || 'https://www.tradingview.com/chat/#bitcoin',
  saveImages: boolFromEnv('SAVE_IMAGES', true),
  saveIdeas: boolFromEnv('SAVE_IDEAS', true),
  imagesDir: process.env.IMAGES_DIR || path.join(process.cwd(), 'data', 'images'),
  // Minds (BITSTAMP:BTCUSD and BINANCE:BTCUSDT are separate feeds; other exchanges share one of them)
  mindsSymbols: (process.env.MINDS_SYMBOLS || 'BITSTAMP:BTCUSD,BINANCE:BTCUSDT').split(',').map(s => s.trim()).filter(Boolean),
  mindsPollInterval: (parseInt(process.env.MINDS_POLL_INTERVAL, 10) || 60) * 1000,
  mindsBackfillMinutes: parseInt(process.env.MINDS_BACKFILL_MINUTES, 10) || 60,
  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
  telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
};
