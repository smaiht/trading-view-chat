const { Pool } = require('pg');

class DB {
  constructor({ connectionString }) {
    this.pool = new Pool({ connectionString });
  }

  async ensureSchema() {
    const fs = require('fs');
    const path = require('path');
    // 1) Migrate legacy table names -> tv_* (idempotent)
    const pairs = [
      ['users','tv_users'],
      ['rooms','tv_rooms'],
      ['ideas','tv_ideas'],
      ['messages','tv_messages'],
      ['images','tv_images'],
    ];
    for (const [oldName, newName] of pairs) {
      try {
        const existsOld = await this.pool.query('SELECT to_regclass($1) AS r', [oldName]);
        const existsNew = await this.pool.query('SELECT to_regclass($1) AS r', [newName]);
        const hasOld = !!existsOld.rows[0].r;
        const hasNew = !!existsNew.rows[0].r;
        if (hasOld && !hasNew) {
          await this.pool.query(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
        }
      } catch {}
    }

    // 2) Apply/ensure tv_* schema
    const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await this.pool.query(sql);

    // 3) Ensure ON UPDATE CASCADE for tv_messages(username)
    try {
      await this.pool.query('ALTER TABLE tv_messages DROP CONSTRAINT IF EXISTS messages_username_fkey');
    } catch {}
    try {
      await this.pool.query('ALTER TABLE tv_messages DROP CONSTRAINT IF EXISTS tv_messages_username_fkey');
    } catch {}
    try {
      await this.pool.query('ALTER TABLE tv_messages ADD CONSTRAINT tv_messages_username_fkey FOREIGN KEY (username) REFERENCES tv_users(username) ON UPDATE CASCADE');
    } catch {}
    try {
      await this.pool.query('ALTER TABLE tv_users ADD COLUMN IF NOT EXISTS metadata JSONB');
    } catch {}
  }

  async upsertUser({ username, numeric_user_id, profile_url, avatar_url, badge }) {
    if (!username && !numeric_user_id) return;
    const newName = username || null;
    const numId = numeric_user_id || null;
    // 1) Fast path: update by numeric id; append previous name into metadata in SQL if name changes
    if (numId) {
      const upd = await this.pool.query(
        `UPDATE tv_users
            SET username = COALESCE($1, username),
                profile_url = COALESCE($3, profile_url),
                avatar_url = COALESCE($4, avatar_url),
                badge = COALESCE($5, badge),
                metadata = CASE
                  WHEN $1 IS NOT NULL AND username IS DISTINCT FROM $1 THEN
                    jsonb_set(
                      COALESCE(metadata, '{"prev_names":[]}'::jsonb),
                      '{prev_names}',
                      COALESCE(metadata->'prev_names','[]'::jsonb) || to_jsonb(username),
                      true
                    )
                  ELSE metadata
                END,
                last_seen_at = now()
          WHERE numeric_user_id = $2`,
        [newName, numId, profile_url || null, avatar_url || null, badge || null]
      );
      if (upd.rowCount && upd.rowCount > 0) return;
    }
    // 2) Bind or insert by username (single UPSERT)
    await this.pool.query(
      `INSERT INTO tv_users(username, numeric_user_id, profile_url, avatar_url, badge, metadata, last_seen_at, first_seen_at)
         VALUES($1,$2,$3,$4,$5, COALESCE($6, '{"prev_names":[]}'::jsonb), now(), now())
       ON CONFLICT (username)
       DO UPDATE SET numeric_user_id = COALESCE(tv_users.numeric_user_id, EXCLUDED.numeric_user_id),
                     profile_url = COALESCE(EXCLUDED.profile_url, tv_users.profile_url),
                     avatar_url = COALESCE(EXCLUDED.avatar_url, tv_users.avatar_url),
                     badge = COALESCE(EXCLUDED.badge, tv_users.badge),
                     metadata = COALESCE(tv_users.metadata, EXCLUDED.metadata),
                     last_seen_at = now()`,
      [newName, numId, profile_url || null, avatar_url || null, badge || null, null]
    );
  }

  async upsertIdea({ idea_id, symbol, url, author_username, author_user_id, title, published_at_utc, like_count, preview_url, preview_local_path, text, raw }) {
    if (!idea_id) return;
    await this.pool.query(
      `INSERT INTO tv_ideas(idea_id, symbol, url, author_username, author_user_id, title, published_at_utc, like_count, preview_url, preview_local_path, text, raw)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (idea_id)
       DO UPDATE SET symbol=COALESCE(EXCLUDED.symbol, tv_ideas.symbol),
                     url=COALESCE(EXCLUDED.url, tv_ideas.url),
                     author_username=COALESCE(EXCLUDED.author_username, tv_ideas.author_username),
                     author_user_id=COALESCE(EXCLUDED.author_user_id, tv_ideas.author_user_id),
                     title=COALESCE(EXCLUDED.title, tv_ideas.title),
                     published_at_utc=COALESCE(EXCLUDED.published_at_utc, tv_ideas.published_at_utc),
                     like_count=COALESCE(EXCLUDED.like_count, tv_ideas.like_count),
                     preview_url=COALESCE(EXCLUDED.preview_url, tv_ideas.preview_url),
                     preview_local_path=COALESCE(EXCLUDED.preview_local_path, tv_ideas.preview_local_path),
                     text=COALESCE(EXCLUDED.text, tv_ideas.text),
                     raw=COALESCE(EXCLUDED.raw, tv_ideas.raw)`,
      [idea_id, symbol || null, url || null, author_username || null, author_user_id || null, title || null, published_at_utc || null, like_count || null, preview_url || null, preview_local_path || null, text || null, raw ? JSON.stringify(raw) : null]
    );
  }

  async upsertMessage({ id, room, username, badge, symbol, utc, time_title, content, idea_id, raw }) {
    if (!id) return;
    await this.pool.query(
      `INSERT INTO tv_messages(id, room, username, badge, symbol, utc, time_title, content, idea_id, raw)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id)
       DO UPDATE SET room=COALESCE(EXCLUDED.room, tv_messages.room),
                     username=COALESCE(EXCLUDED.username, tv_messages.username),
                     badge=COALESCE(EXCLUDED.badge, tv_messages.badge),
                     symbol=COALESCE(EXCLUDED.symbol, tv_messages.symbol),
                     utc=COALESCE(EXCLUDED.utc, tv_messages.utc),
                     time_title=COALESCE(EXCLUDED.time_title, tv_messages.time_title),
                     content=COALESCE(EXCLUDED.content, tv_messages.content),
                     idea_id=COALESCE(EXCLUDED.idea_id, tv_messages.idea_id),
                     raw=COALESCE(EXCLUDED.raw, tv_messages.raw)`,
      [id, room || null, username || null, badge || null, symbol || null, utc || null, time_title || null, content || null, idea_id || null, raw ? JSON.stringify(raw) : null]
    );
  }

  async insertImages({ message_id, idea_id, images }) {
    if (!images || !images.length) return;
    for (const img of images) {
      await this.pool.query(
        `INSERT INTO tv_images(message_id, idea_id, kind, original_url, local_path, sha256, width, height)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [message_id || null, idea_id || null, img.kind || null, img.original_url || null, img.local_path || null, img.sha256 || null, img.width || null, img.height || null]
      );
    }
  }

  async getRecentMessagesByUser(username, limit = 50) {
    const res = await this.pool.query(
      `SELECT id, content, utc FROM tv_messages WHERE username=$1 ORDER BY utc DESC NULLS LAST LIMIT $2`,
      [username, limit]
    );
    return res.rows;
  }

  async getMessageById(id) {
    const r = await this.pool.query(`SELECT * FROM tv_messages WHERE id=$1`, [id]);
    return r.rows[0] || null;
  }

  async getImagesForMessage(id) {
    const r = await this.pool.query(
      `SELECT id, kind, original_url, local_path, sha256, width, height
       FROM tv_images WHERE message_id=$1 ORDER BY id ASC`,
      [id]
    );
    return r.rows || [];
  }

  async getTgMsgId(id) {
    const r = await this.pool.query(`SELECT tg_msg_id FROM tv_messages WHERE id=$1`, [id]);
    if (!r.rows.length) return null;
    return r.rows[0].tg_msg_id || null;
  }

  async setTgMsgId(id, tgMsgId) {
    await this.pool.query(`UPDATE tv_messages SET tg_msg_id=$2 WHERE id=$1`, [id, tgMsgId]);
  }

  async getLastMessageUtc(room) {
    const r = await this.pool.query(
      `SELECT COALESCE(utc, created_at) AS ts FROM tv_messages
         WHERE room=$1
      ORDER BY COALESCE(utc, created_at) DESC NULLS LAST
         LIMIT 1`,
      [room]
    );
    if (!r.rows.length) return null;
    const ts = r.rows[0].ts;
    return ts ? new Date(ts).toISOString() : null;
  }

  // Returns epoch seconds (float, micro-precision) for the last message utc only
  // We do NOT fall back to created_at here, to keep ordering based on parsed chat time.
  async getLastMessageEpoch(room) {
    const r = await this.pool.query(
      `SELECT EXTRACT(EPOCH FROM utc) AS epoch
         FROM tv_messages
        WHERE room=$1 AND utc IS NOT NULL
     ORDER BY utc DESC
        LIMIT 1`,
      [room]
    );
    if (!r.rows.length) return null;
    const e = r.rows[0].epoch;
    const v = (typeof e === 'number') ? e : parseFloat(e);
    return Number.isFinite(v) ? v : null;
  }
}

module.exports = { DB };
