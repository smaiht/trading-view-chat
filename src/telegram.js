const fs = require('fs');
const path = require('path');

function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

class TelegramClient {
  constructor({ token, chatId }) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
    if (!chatId) throw new Error('TELEGRAM_CHAT_ID missing');
    this.token = token;
    this.chatId = chatId;
    this.base = `https://api.telegram.org/bot${this.token}`;
  }

  async _callJson(method, payload) {
    const url = `${this.base}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const err = new Error(`Telegram ${method} failed: ${res.status} ${res.statusText} ${JSON.stringify(data)}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data.result;
  }

  async _callMultipart(method, buildForm) {
    const url = `${this.base}/${method}`;
    const form = new FormData();
    await buildForm(form);
    const res = await fetch(url, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const err = new Error(`Telegram ${method} failed: ${res.status} ${res.statusText} ${JSON.stringify(data)}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data.result;
  }

  async sendMessage({ text, parse_mode = 'HTML', reply_to_message_id = undefined, disable_web_page_preview = true }) {
    return this._callJson('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode,
      disable_web_page_preview,
      reply_to_message_id,
    });
  }

  async sendPhoto({ photo, caption = undefined, parse_mode = 'HTML', reply_to_message_id = undefined }) {
    const isLocal = photo && !/^https?:\/\//i.test(photo);
    if (isLocal) {
      return this._callMultipart('sendPhoto', async (form) => {
        form.append('chat_id', this.chatId);
        const buf = await fs.promises.readFile(photo);
        const blob = new Blob([buf]);
        form.append('photo', blob, path.basename(photo));
        if (caption) form.append('caption', caption);
        if (parse_mode) form.append('parse_mode', parse_mode);
        if (reply_to_message_id) form.append('reply_to_message_id', String(reply_to_message_id));
      });
    }
    return this._callJson('sendPhoto', {
      chat_id: this.chatId,
      photo,
      caption,
      parse_mode,
      reply_to_message_id,
    });
  }

  async sendMediaGroup({ items, reply_to_message_id = undefined }) {
    // items: [{ type: 'photo', media: '/path/or/url', caption?, parse_mode? }]
    const locals = [];
    const mediaPayload = [];
    let idx = 0;
    for (const it of items) {
      const isLocal = it.media && !/^https?:\/\//i.test(it.media);
      const attachName = `file${idx}`;
      mediaPayload.push({
        type: it.type || 'photo',
        media: isLocal ? `attach://${attachName}` : it.media,
        caption: it.caption,
        parse_mode: it.parse_mode,
      });
      if (isLocal) locals.push({ name: attachName, path: it.media });
      idx++;
    }

    return this._callMultipart('sendMediaGroup', async (form) => {
      form.append('chat_id', this.chatId);
      if (reply_to_message_id) form.append('reply_to_message_id', String(reply_to_message_id));
      form.append('media', JSON.stringify(mediaPayload));
      for (const f of locals) {
        const buf = await fs.promises.readFile(f.path);
        const blob = new Blob([buf]);
        form.append(f.name, blob, path.basename(f.path));
      }
    });
  }

  async editMessageText({ message_id, text, parse_mode = 'HTML', disable_web_page_preview = true }) {
    return this._callJson('editMessageText', {
      chat_id: this.chatId,
      message_id,
      text,
      parse_mode,
      disable_web_page_preview,
    });
  }
}

module.exports = { TelegramClient, escHtml };
