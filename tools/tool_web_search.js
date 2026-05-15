function decodeResultUrl(href) {
  if (href.startsWith('/l/?')) {
    try {
      const u = new URL('https://html.duckduckgo.com' + href);
      const uddg = u.searchParams.get('uddg');
      if (uddg) return uddg;
    } catch {}
  }
  return href.startsWith('http') ? href : null;
}

function cleanHtml(str) {
  return str
    .replace(/<b>/g, '').replace(/<\/b>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function webSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
  const html = await res.text();

  const titles = [], urls = [], snippets = [];

  const titleRe = /<a class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = titleRe.exec(html)) !== null && urls.length < 5) {
    urls.push(decodeResultUrl(m[1]) || '');
    titles.push(cleanHtml(m[2]));
  }

  const snippetRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snippetRe.exec(html)) !== null && snippets.length < 5) {
    snippets.push(cleanHtml(m[1]));
  }

  const count = Math.max(urls.length, snippets.length);
  const results = [];
  for (let i = 0; i < count; i++) {
    const parts = [];
    if (titles[i])   parts.push(`Title: ${titles[i]}`);
    if (urls[i])     parts.push(`URL: ${urls[i]}`);
    if (snippets[i]) parts.push(`Snippet: ${snippets[i]}`);
    if (parts.length) results.push(parts.join('\n'));
  }

  return results.length > 0 ? results.join('\n\n') : 'No results found.';
}

module.exports = { webSearch };
