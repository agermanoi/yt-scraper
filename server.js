const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Cache em memória ──────────────────────────────────
const cache = new Map();
const CACHE_LIVE  = 60  * 1000; // 1 min para dados de live
const CACHE_STATS = 300 * 1000; // 5 min para inscritos/views

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data, ttl) {
  cache.set(key, { data, ts: Date.now(), ttl });
}

// ── Scrape página do canal (live + inscritos via ytInitialData) ──
async function scrapeChannel(channelId) {
  const cached = getCache('ch_' + channelId);
  if (cached) return { ...cached, fromCache: true };

  const url = `https://www.youtube.com/channel/${channelId}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
  });

  const html = await res.text();
  const result = {
    live: false, viewers: null, videoId: null, title: null, thumb: null,
    name: null, handle: null, subs: null, avatar: null,
  };

  // ── ytInitialData ──
  const dataMatch = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  if (dataMatch) {
    try {
      const ytData = JSON.parse(dataMatch[1]);
      const str    = JSON.stringify(ytData);

      // nome do canal
      const nameMatch = str.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/);
      if (nameMatch) result.name = nameMatch[1];

      // handle
      const handleMatch = str.match(/"vanityUrl":"([^"]+)"/);
      if (handleMatch) result.handle = handleMatch[1];

      // avatar
      const avatarMatch = str.match(/"avatar":\{"thumbnails":\[.*?"url":"(https:\/\/yt[^"]+)"/s);
      if (avatarMatch) result.avatar = avatarMatch[1];

      // inscritos (subscriberCountText)
      const subsMatch = str.match(/"subscriberCountText":\{"simpleText":"([^"]+)"/);
      if (subsMatch) result.subs = subsMatch[1]; // ex: "6,5 mi de inscritos"
    } catch {}
  }

  // ── ytInitialPlayerConfig / live ──
  const liveMatch = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  if (liveMatch) {
    try {
      const player = JSON.parse(liveMatch[1]);
      const micro  = player?.microformat?.playerMicroformatRenderer;
      if (micro?.liveBroadcastDetails?.isLiveNow === true) {
        result.live    = true;
        result.videoId = micro?.externalVideoId || null;
        result.title   = micro?.title?.simpleText || null;
      }
    } catch {}
  }

  // ── Scrape página /live se não achou live ──
  if (!result.live) {
    try {
      const liveRes  = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        }
      });
      const liveHtml = await liveRes.text();
      const str2     = liveHtml;

      // concurrent viewers
      const viewMatch = str2.match(/"concurrentViewers":"(\d+)"/);
      if (viewMatch) { result.viewers = parseInt(viewMatch[1]); result.live = true; }

      // "N assistindo agora"
      const ptMatch = str2.match(/"([\d\.,]+)\s*(?:assistindo agora|watching now)"/);
      if (ptMatch && !result.viewers) {
        result.viewers = parseInt(ptMatch[1].replace(/\./g,'').replace(/,/g,''));
        result.live    = true;
      }

      // badge live
      if (!result.live && str2.includes('"BADGE_STYLE_TYPE_LIVE_NOW"')) result.live = true;

      // videoId
      if (!result.videoId) {
        const vidMatch = str2.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        if (vidMatch) result.videoId = vidMatch[1];
      }

      // título
      if (!result.title) {
        const titleMatch = str2.match(/"title"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"/);
        if (titleMatch) result.title = titleMatch[1];
      }
    } catch {}
  }

  if (result.videoId) {
    result.thumb = `https://i.ytimg.com/vi/${result.videoId}/maxresdefault_live.jpg`;
  }

  setCache('ch_' + channelId, result, CACHE_LIVE);
  return { ...result, fromCache: false };
}

// ── ENDPOINTS ─────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'yt-live-scraper', uptime: process.uptime() });
});

app.get('/live/:channelId', async (req, res) => {
  const { channelId } = req.params;
  if (!channelId || !channelId.startsWith('UC'))
    return res.status(400).json({ error: 'Channel ID inválido' });
  try {
    const data = await scrapeChannel(channelId);
    res.json({ channelId, ...data });
  } catch(e) {
    res.status(500).json({ error: e.message, channelId });
  }
});

// POST /live/batch  — retorna live + inscritos de vários canais
app.post('/live/batch', async (req, res) => {
  const { channelIds } = req.body;
  if (!Array.isArray(channelIds) || !channelIds.length)
    return res.status(400).json({ error: 'Envie um array channelIds' });
  if (channelIds.length > 20)
    return res.status(400).json({ error: 'Máximo 20 canais' });

  const results = {};
  const chunks  = [];
  for (let i = 0; i < channelIds.length; i += 3)
    chunks.push(channelIds.slice(i, i + 3));

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async id => {
      try { results[id] = await scrapeChannel(id); }
      catch(e) { results[id] = { live: false, viewers: null, subs: null, error: e.message }; }
    }));
    if (chunks.indexOf(chunk) < chunks.length - 1)
      await new Promise(r => setTimeout(r, 500));
  }

  res.json({ results, cachedAt: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`YT Live Scraper rodando na porta ${PORT}`));
