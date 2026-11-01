const API_BASE = 'https://www.tradingview.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.tradingview.com/',
};

// Newest-first page of Minds for a symbol, e.g. BITSTAMP:BTCUSD
async function fetchMinds(symbol) {
  const url = `${API_BASE}/api/v2/minds/?f=symbol&symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

// tradingview.com/x/ABCD1234/ -> s3 snapshot png (same mapping the chat scraper relied on)
function snapshotFromXLink(u) {
  const m = String(u || '').match(/tradingview\.com\/x\/([A-Za-z0-9]+)/i);
  if (!m) return null;
  return `https://s3.tradingview.com/snapshots/${m[1][0].toLowerCase()}/${m[1]}.png`;
}

// Flatten text_ast into plain text; collect images and idea links on the way
function renderAst(ast) {
  const images = [];
  const ideas = [];

  function inline(n) {
    if (typeof n === 'string') return n;
    if (!n || typeof n !== 'object') return '';
    const p = n.params || {};
    switch (n.type) {
      case 'symbol': return p.text || '';
      case 'url': {
        const snap = snapshotFromXLink(p.url);
        if (snap) { images.push(snap); return ''; }
        return p.url || p.linkText || '';
      }
      case 'idea_link':
        if (p.link) ideas.push({ id: p.uid || null, url: p.link });
        return p.name || p.link || '';
      default: return (n.children || []).map(inline).join('');
    }
  }

  function block(n) {
    if (typeof n === 'string') return n;
    switch (n?.type) {
      case 'root': return (n.children || []).map(block).filter(s => s.trim()).join('\n\n');
      case 'list': return (n.children || []).map(li => `• ${inline(li).trim()}`).join('\n');
      case 'quote': return (n.children || []).map(inline).join('').split('\n').map(s => `> ${s}`).join('\n');
      default: return inline(n);
    }
  }

  const text = block(ast || {}).replace(/\n{3,}/g, '\n\n').trim();
  return { text, images, ideas };
}

// Map one Minds API item to the message shape stream.js publishes
function normalizeMind(item, feedSymbol) {
  const { text, images, ideas } = renderAst(item.text_ast);
  const shortSym = String(feedSymbol).split(':').pop();
  // Most posts open with the symbol tag itself; the header already shows it
  const body = text.startsWith(shortSym) ? text.slice(shortSym.length).trim() : text;
  if (item.snapshot_url) images.unshift(item.snapshot_url);
  const author = item.author || {};
  const avatar = author.avatars?.mid || author.avatars?.small || null;
  return {
    id: `mind-${item.uid}`,
    username: author.username || null,
    badge: (author.badges && author.badges[0] && author.badges[0].verbose_name) || null,
    profile_url: author.uri ? new URL(author.uri, API_BASE).toString() : null,
    avatar_url: avatar && /^https?:/i.test(avatar) ? avatar : null,
    symbol: shortSym,
    utc: item.created ? new Date(item.created).toISOString() : null,
    url: item.url || null,
    text: body,
    quotes: [],
    images: [...new Set(images)],
    ideas,
  };
}

module.exports = { fetchMinds, renderAst, normalizeMind };
