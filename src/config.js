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
  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
  telegramBotToken2: process.env.TELEGRAM_BOT_TOKEN_2 || null,
  telegramChatId: process.env.TELEGRAM_CHAT_ID || null, // e.g. '@trading_view_chat' or numeric id like -100xxxxxxxxxx
};
