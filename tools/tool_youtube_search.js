async function youtubeFirstVideo(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cookie': 'CONSENT=YES+cb; PREF=hl=en&gl=US',
    },
  });
  if (!res.ok) throw new Error(`YouTube search HTTP ${res.status}`);
  const html = await res.text();

  // 1. videoRenderer — organic search result (most reliable)
  let m = html.match(/"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;

  // 2. richItemRenderer wrapping a videoRenderer
  m = html.match(/"richItemRenderer"[^}]*"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;

  // 3. /watch?v= URL embedded directly in the page JSON
  m = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})(?:[^a-zA-Z0-9_-]|$)/);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;

  // 4. Any videoId key (broadest fallback)
  m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;

  throw new Error(`No video found for: "${query}"`);
}

module.exports = { youtubeFirstVideo };
