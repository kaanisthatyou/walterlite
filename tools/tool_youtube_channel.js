const { youtubeFirstVideo } = require('./tool_youtube_search');

async function youtubeChannelLatest(query) {
  // Normalize: if it looks like a handle/channel name (not a full URL), build the URL
  let channelUrl;
  if (/^https?:\/\//.test(query)) {
    channelUrl = query.replace(/\/?$/, '/videos');
  } else {
    const handle = query.startsWith('@') ? query : `@${query.replace(/\s+/g, '')}`;
    channelUrl = `https://www.youtube.com/${handle}/videos`;
  }

  try {
    const res = await fetch(channelUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // YouTube embeds video data as JSON in ytInitialData — extract first videoId
    const m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
    throw new Error('no videoId found');
  } catch {
    // Fallback: search for the latest video from this channel
    const searchQuery = query.replace(/^@/, '') + ' latest video';
    return youtubeFirstVideo(searchQuery);
  }
}

module.exports = { youtubeChannelLatest };
