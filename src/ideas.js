const { renderAst, snapshotUrl } = require('./minds');
const { escHtml } = require('./telegram');

const API_BASE = 'https://www.tradingview.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.tradingview.com/',
};

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// First page of ideas for a symbol (mostly newest first, with some older "hot" ones mixed in)
async function fetchIdeas(symbol) {
  const data = await getJson(`${API_BASE}/api/v1/ideas/?symbol=${encodeURIComponent(symbol)}`);
  return Array.isArray(data?.results) ? data.results : [];
}

// Full idea: untruncated description_ast, updates, direction, interval
async function fetchIdea(uuid) {
  return getJson(`${API_BASE}/api/v1/ideas/${encodeURIComponent(uuid)}/`);
}

// Detail responses carry a relative chart_url, list responses an absolute one
function ideaUrl(idea) {
  return new URL(idea.chart_url || `/chart/${idea.uuid}/`, API_BASE).toString();
}

function directionLabel(d) {
  if (d === 1) return '🟢 Long';
  if (d === 2) return '🔴 Short';
  return null;
}

function intervalLabel(iv) {
  const s = String(iv || '');
  if (!/^\d+$/.test(s)) return s || null; // 1D, 1W, 3M...
  const n = parseInt(s, 10);
  return n % 60 === 0 ? `${n / 60}h` : `${n}m`;
}

const PARA = { para: true }; // paragraph break marker inside inline runs

// description_ast -> Telegraph nodes. Inline runs become <p>: blank lines start a new
// paragraph, single newlines become <br>; embedded chart snapshots become <figure><img>.
function astToTelegraph(ast) {
  const blocks = [];
  let run = [];

  function textNodes(s) {
    const out = [];
    String(s).split(/\n{2,}/).forEach((para, pi) => {
      if (pi) out.push(PARA);
      para.split('\n').forEach((line, i) => {
        if (i) out.push({ tag: 'br' });
        if (line) out.push(line);
      });
    });
    return out;
  }

  function inline(n) {
    if (typeof n === 'string') return textNodes(n);
    if (!n || typeof n !== 'object') return [];
    const p = n.params || {};
    // Paragraph breaks can't live inside <b>/<i>; degrade them to line breaks there
    const kids = () => (n.children || []).flatMap(inline).flatMap(t => (t === PARA ? [{ tag: 'br' }, { tag: 'br' }] : [t]));
    switch (n.type) {
      case 'b': return [{ tag: 'b', children: kids() }];
      case 'i': return [{ tag: 'i', children: kids() }];
      case 'symbol': return [p.text || ''];
      case 'url': return p.url ? [{ tag: 'a', attrs: { href: p.url }, children: [p.linkText || p.url] }] : [];
      case 'idea_link': return p.link ? [{ tag: 'a', attrs: { href: p.link }, children: [p.name || p.link] }] : [];
      default: return kids();
    }
  }

  function push(tokens) {
    for (const t of tokens) {
      if (t === PARA) flush();
      else run.push(t);
    }
  }

  function flush() {
    // Drop leading/trailing <br> so paragraphs don't get empty lines at the edges
    while (run.length && run[0].tag === 'br') run.shift();
    while (run.length && run[run.length - 1].tag === 'br') run.pop();
    if (run.length) blocks.push({ tag: 'p', children: run });
    run = [];
  }

  function block(n) {
    switch (n?.type) {
      case 'p': flush(); push((n.children || []).flatMap(inline)); flush(); return;
      case 'list':
        flush();
        blocks.push({ tag: 'ul', children: (n.children || []).map(li => ({ tag: 'li', children: inline(li).map(t => (t === PARA ? { tag: 'br' } : t)) })) });
        return;
      case 'quote': flush(); blocks.push({ tag: 'blockquote', children: (n.children || []).flatMap(inline).map(t => (t === PARA ? { tag: 'br' } : t)) }); return;
      case 'image': {
        const src = snapshotUrl(n.params?.image?.id);
        if (src) { flush(); blocks.push({ tag: 'figure', children: [{ tag: 'img', attrs: { src } }] }); }
        return;
      }
      default: push(inline(n));
    }
  }

  (ast?.children || []).forEach(block);
  flush();
  return blocks;
}

function ideaMeta(idea) {
  return [directionLabel(idea.direction), idea.symbol?.short_name || null, intervalLabel(idea.interval)].filter(Boolean);
}

// Full idea page: chart, meta line, body, author updates, link back
function buildTelegraphContent(idea) {
  const content = [];
  if (idea.image?.big) content.push({ tag: 'figure', children: [{ tag: 'img', attrs: { src: idea.image.big } }] });
  const meta = ideaMeta(idea);
  if (meta.length) content.push({ tag: 'p', children: [{ tag: 'b', children: [meta.join(' · ')] }] });
  content.push(...astToTelegraph(idea.description_ast));
  const updates = Array.isArray(idea.updates) ? idea.updates : [];
  if (updates.length) {
    content.push({ tag: 'hr' }, { tag: 'h4', children: ['Updates'] });
    for (const u of updates) {
      const when = u.created_at ? new Date(u.created_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
      content.push({ tag: 'p', children: [{ tag: 'b', children: [u.label || 'Update'] }, when ? ` · ${when}` : ''] });
      content.push(...astToTelegraph(u.description_ast));
    }
  }
  content.push({ tag: 'hr' }, { tag: 'p', children: [{ tag: 'a', attrs: { href: ideaUrl(idea) }, children: ['Open on TradingView'] }] });
  return content;
}

// Telegram photo caption (HTML, max 1024 chars): header + excerpt + links
function buildCaption(idea, telegraphUrl) {
  const user = idea.user || {};
  const profile = user.username ? `${API_BASE}/u/${encodeURIComponent(user.username)}/` : null;
  const badge = user.badges?.[0]?.verbose_name;
  const meta = ideaMeta(idea);
  const head = [
    `📊 <b>${escHtml(idea.name)}</b>`,
    meta.length ? escHtml(meta.join(' · ')) : null,
    user.username ? `by <a href="${profile}">${escHtml(user.username)}</a>${badge ? ` · ${escHtml(badge)}` : ''}` : null,
  ].filter(Boolean).join('\n');
  const links = [
    telegraphUrl ? `<a href="${telegraphUrl}">📖 Full idea</a>` : null,
    `<a href="${ideaUrl(idea)}">TradingView</a>`,
  ].filter(Boolean).join(' · ');

  const text = renderAst(idea.description_ast).text;
  const room = 1000 - head.length - links.length - 4;
  let excerpt = text;
  if (escHtml(excerpt).length > room) {
    excerpt = text.slice(0, Math.max(0, room - 1));
    while (escHtml(excerpt).length > room - 1) excerpt = excerpt.slice(0, -20);
    excerpt = excerpt.replace(/\s+\S*$/, '') + '…';
  }
  return [head, excerpt ? escHtml(excerpt) : null, links].filter(Boolean).join('\n\n');
}

module.exports = { fetchIdeas, fetchIdea, astToTelegraph, buildTelegraphContent, buildCaption, intervalLabel };
