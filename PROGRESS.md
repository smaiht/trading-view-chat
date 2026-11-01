# Progress

## 2026-11-01 — public chat is gone, moving to Minds

### What happened
- TradingView retired **all public chats on 2026-09-30** ([official notice](https://www.tradingview.com/support/solutions/43000591339-public-chats-are-being-retired-on-sep-30-2026/)).
  `https://www.tradingview.com/chat/#bitcoin` now returns **404 "Page not found"**.
- The new "Chats" in Community Hub are only 1-on-1 and private invite-only groups; there are no public rooms anymore.
  Users pushed back (petitions on [ipetitions](https://www.ipetitions.com/p/petition-to-keep-the-tradingview-public-chat-rooms-open/) and [change.org](https://www.change.org/p/keep-tradingview-public-chats-online)), but there is no sign of a reversal.
- Our last chat message is from ~2026-10-01. After that the scraper restarted in a loop (174 restarts):
  health check saw no new messages → `exit(1)` → Docker restart → Chrome → 404 → again.
- History up to the shutdown remains in Postgres (`tv_messages`, ~1.3 GB volume on the server).

### Done
- [x] `scraper` moved behind the compose profile `scraper` (not started by default), commit `dd15f0e`.
- [x] `telegram` keeps updating the BTC price in the channel title (OKX API, independent of the chat).
- [x] Researched the replacement: **TradingView Minds** has a public JSON API, no browser or login needed:
  `GET https://www.tradingview.com/api/v2/minds/?f=symbol&symbol=BITSTAMP%3ABTCUSD`
  - 20 posts per page, newest first, `next` = cursor for older pages.
  - Feeds are grouped by alias: `BITSTAMP:BTCUSD` = Coinbase/Oanda/CRYPTO BTCUSD; `BINANCE:BTCUSDT` = Bybit/OKX BTCUSDT(.P).
  - Volume is much lower than the old chat: ~20 posts / 14 h per feed, ~70/day for both.
  - Post = `uid`, `created`, `author{username,badges,avatars}`, `text_ast` (p / b / i / symbol / url / idea_link / list / quote), optional `snapshot_url`, `total_likes`, `total_comments`.
- [x] New `minds` service (`cli/minds.js` + `src/minds.js`): polls the feeds every 60 s, stores posts in `tv_messages`
  (`id = mind-<uid>`, `room = minds:<symbol>`) and publishes them to Redis `chat:messages`, so the existing Telegram forwarder sends them unchanged.
  - First run for a feed: posts older than `MINDS_BACKFILL_MINUTES` (60) are saved silently, so the channel is not flooded.
  - `tradingview.com/x/<id>/` links and `snapshot_url` are sent as photos (`s3.tradingview.com/snapshots/...png`).
  - Env: `MINDS_SYMBOLS`, `MINDS_POLL_INTERVAL`, `MINDS_BACKFILL_MINUTES` (see `.env.example`).

### Next
- [ ] Watch the channel for a day: formatting, images, volume.
- [ ] Comments under Minds posts (`total_comments`) as Telegram replies — needs the comments endpoint.
- [ ] More feeds if it is too quiet (e.g. ETH, or `CRYPTOCAP:BTC` — that one is almost dead, last posts months old).
- [ ] Alternative if Minds is not enough: join a large private TradingView group with our account and read it logged in.
