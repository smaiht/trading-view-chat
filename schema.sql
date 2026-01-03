-- TradingView Chat Schema

CREATE TABLE IF NOT EXISTS tv_users (
  username TEXT PRIMARY KEY,
  numeric_user_id BIGINT,
  profile_url TEXT,
  avatar_url TEXT,
  badge TEXT,
  metadata JSONB,
  trust_score INTEGER DEFAULT 0,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tv_users_numeric_user_id_uidx ON tv_users(numeric_user_id);

CREATE TABLE IF NOT EXISTS tv_rooms (
  slug TEXT PRIMARY KEY,
  title TEXT,
  url TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tv_ideas (
  idea_id TEXT PRIMARY KEY,
  symbol TEXT,
  url TEXT,
  author_username TEXT,
  author_user_id BIGINT,
  title TEXT,
  published_at_utc TIMESTAMPTZ,
  like_count INTEGER,
  preview_url TEXT,
  preview_local_path TEXT,
  text TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tv_messages (
  id TEXT PRIMARY KEY,
  room TEXT,
  username TEXT REFERENCES tv_users(username) ON UPDATE CASCADE,
  badge TEXT,
  symbol TEXT,
  utc TIMESTAMPTZ,
  time_title TEXT,
  content TEXT,
  idea_id TEXT REFERENCES tv_ideas(idea_id),
  raw JSONB,
  tg_msg_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tv_messages_user_idx ON tv_messages(username);
CREATE INDEX IF NOT EXISTS tv_messages_utc_idx ON tv_messages(utc);

CREATE TABLE IF NOT EXISTS tv_images (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT REFERENCES tv_messages(id),
  idea_id TEXT REFERENCES tv_ideas(idea_id),
  kind TEXT,
  original_url TEXT,
  local_path TEXT,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tv_images_message_idx ON tv_images(message_id);
