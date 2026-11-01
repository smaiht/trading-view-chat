class TelegraphClient {
  constructor({ token }) {
    if (!token) throw new Error('TELEGRAPH_TOKEN missing');
    this.token = token;
  }

  // content: array of Telegraph Nodes; returns the page URL
  async createPage({ title, author_name, author_url, content }) {
    const res = await fetch('https://api.telegra.ph/createPage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: this.token,
        title: String(title || 'Untitled').slice(0, 256),
        author_name: author_name ? String(author_name).slice(0, 128) : undefined,
        author_url: author_url || undefined,
        content,
        return_content: false,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`Telegraph createPage failed: ${res.status} ${JSON.stringify(data)}`);
    return data.result.url;
  }
}

module.exports = { TelegraphClient };
