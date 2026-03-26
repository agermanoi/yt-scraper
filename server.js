const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const cache = new Map();
const CACHE_TTL = 60 * 1000;

function getCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// API Key usada APENAS para inscritos (1 unidade por canal — custo mínimo)
const YT_API_KEY = 'AIzaSyD0S9SycdZ89eSIqVdZ6eoJ7i7gtieErQo';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function parseSubs(text) {
  if (!text) return null;
  if (typeof text === 'number') return text;
  const t = text.toLowerCase().replace(/\s+/g,'').replace(',','.');
  if (t.includes('bi'))  return Math.round(parseFloat(t) * 1e9);
  if (t.includes('mi'))  return Math.round(parseFloat(t) * 1e6);
  if (t.includes('mil')) return Math.round(parseFloat(t) * 1e3);
  if (t.includes('m') && !t.includes('max')) return Math.round(parseFloat(t) * 1e6);
  if (t.includes('k'))   return Math.round(parseFloat(t) * 1e3);
  const n = parseInt(t.replace(/\D/g,''));
  return n || null;
}

// Extrai ytInitialData de um HTML
function extractYtData(html) {
  // tenta vários padrões pois o YouTube muda o formato
  const patterns = [
    /var ytInitialData\s*=\s*({.+?});\s*<\/script>/s,
    /var ytInitialData\s*=\s*({.+?});\s*var /s,
    /ytInitialData\s*=\s*({.+?});\s*(?:\/\/|<)/s,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
  }
  return null;
}

function extractPlayerResponse(html) {
  const patterns = [
    /var ytInitialPlayerResponse\s*=\s*({.+?});\s*<\/script>/s,
    /var ytInitialPlayerResponse\s*=\s*({.+?});\s*var /s,
    /ytInitialPlayerResponse\s*=\s*({.+?});\s*(?:\/\/|<)/s,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
  }
  return null;
}

async function scrapeChannel(channelId) {
  const result = {
    live: false, viewers: null, videoId: null,
    title: null, thumb: null, name: null,
    handle: null, subs: null, avatar: null,
  };

  // ── 1. Página principal — nome, avatar, inscritos ──
  try {
    const r    = await fetch(`https://www.youtube.com/channel/${channelId}`, { headers: HEADERS });
    const html = await r.text();

    // nome
    const nameM = html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/);
    if (nameM) result.name = nameM[1];

    // avatar
    const avatarM = html.match(/"avatar":\{"thumbnails":\[\{"url":"(https:\/\/yt3[^"]+)"/);
    if (avatarM) result.avatar = avatarM[1].replace(/=s\d+/, '=s88');

    // handle
    const handleM = html.match(/"canonicalChannelUrl":"https:\/\/www\.youtube\.com\/(@[^"]+)"/);
    if (handleM) result.handle = handleM[1];

    // inscritos via API (1 unidade — custo mínimo, sem problema de bot)
    try {
      const apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${YT_API_KEY}`;
      const apiRes = await fetch(apiUrl);
      const apiJson = await apiRes.json();
      if (!apiJson.error && apiJson.items?.length > 0) {
        result.subs = parseInt(apiJson.items[0].statistics.subscriberCount || 0);
      }
    } catch {}

  } catch(e) { result.error_stats = e.message; }

  // ── 2. Página /live — detecta live, videoId, viewers ──
  try {
    const r    = await fetch(`https://www.youtube.com/channel/${channelId}/live`, { headers: HEADERS });
    const html = await r.text();
    const finalUrl = r.url;

    // Se redirecionou para /watch?v= → tem live
    if (finalUrl.includes('/watch?v=')) {
      result.live = true;
      const urlVid = finalUrl.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (urlVid) result.videoId = urlVid[1];
    }

    // playerResponse tem os dados mais confiáveis de live
    const player = extractPlayerResponse(html);
    if (player) {
      const vd = player?.videoDetails;
      if (vd?.isLive || vd?.isLiveContent) {
        result.live    = true;
        result.videoId = result.videoId || vd?.videoId || null;
        result.title   = vd?.title || null;

        // viewers no videoDetails
        if (vd?.viewCount && parseInt(vd.viewCount) > 0) {
          result.viewers = parseInt(vd.viewCount);
        }
      }
      // liveStreamingDetails
      const lsd = player?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
      if (lsd?.isLiveNow) {
        result.live    = true;
        result.videoId = result.videoId || player?.microformat?.playerMicroformatRenderer?.externalVideoId || null;
      }
    }

    // ── viewers: busca no HTML bruto com múltiplos padrões ──
    // O YouTube embute os dados em JSON escapado, então buscamos no texto bruto

    // padrão 1: "originalViewCount":"3985" (confirmado no debug)
    const origViewM = html.match(/"originalViewCount":"(\d+)"/);
    if (origViewM && parseInt(origViewM[1]) > 0) {
      result.viewers = parseInt(origViewM[1]);
      result.live    = true;
    }

    // padrão 2: originalViewCount escapado (\"originalViewCount\":\"3985\")
    if (!result.viewers) {
      const escM = html.match(/\\"originalViewCount\\":\\"(\d+)\\"/);
      if (escM && parseInt(escM[1]) > 0) {
        result.viewers = parseInt(escM[1]);
        result.live    = true;
      }
    }

    // padrão 3: concurrentViewers
    if (!result.viewers) {
      const cvM = html.match(/"concurrentViewers":"(\d+)"/);
      if (cvM && parseInt(cvM[1]) > 0) { result.viewers = parseInt(cvM[1]); result.live = true; }
    }

    // padrão 4: "3985 assistindo agora" ou "3.985 assistindo agora"
    if (!result.viewers) {
      const watchM = html.match(/"([\d\.\,]+)\s*assistindo agora"/i);
      if (watchM) { result.viewers = parseSubs(watchM[1]); result.live = true; }
    }

    // padrão 5: escaped "3985 assistindo agora"
    if (!result.viewers) {
      const watchEsc = html.match(/([\d\.\,]+) assistindo agora/i);
      if (watchEsc) { result.viewers = parseSubs(watchEsc[1]); result.live = true; }
    }

    // badge live
    if (!result.live) {
      result.live = html.includes('"BADGE_STYLE_TYPE_LIVE_NOW"')
        || html.includes('"isLive":true')
        || html.includes('"style":"LIVE"');
    }

    // ytInitialData para videoId e título
    const ytData = extractYtData(html);
    if (ytData) {
      const str = JSON.stringify(ytData);
      if (!result.videoId) {
        const vidM = str.match(/"currentVideoEndpoint":[^}]+?"videoId":"([a-zA-Z0-9_-]{11})"/);
        if (vidM) result.videoId = vidM[1];
      }
      if (!result.title && result.live) {
        const titleM = str.match(/"videoPrimaryInfoRenderer":\{"title":\{"runs":\[\{"text":"([^"]+)"/);
        if (titleM) result.title = titleM[1];
      }
    }

    // último fallback — raw HTML
    if (!result.live) {
      result.live = html.includes('"isLiveNow":true')
        || html.includes('"isLive":true')
        || html.includes('isLiveContent":true');
    }

    if (!result.videoId && result.live) {
      const vidM = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (vidM) result.videoId = vidM[1];
    }

  } catch(e) { result.error_live = e.message; }

  if (result.videoId && result.live) {
    result.thumb = `https://i.ytimg.com/vi/${result.videoId}/maxresdefault_live.jpg`;
  }

  setCache(channelId, result);
  return { ...result, fromCache: false };
}

// ── ENDPOINTS ──────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'yt-live-scraper', uptime: Math.round(process.uptime()) });
});

// GET /live/:channelId?nocache=1
app.get('/live/:channelId', async (req, res) => {
  const { channelId } = req.params;
  if (!channelId || !channelId.startsWith('UC'))
    return res.status(400).json({ error: 'Channel ID inválido' });

  if (!req.query.nocache) {
    const cached = getCache(channelId);
    if (cached) return res.json({ channelId, ...cached, fromCache: true });
  }

  try {
    res.json({ channelId, ...await scrapeChannel(channelId) });
  } catch(e) {
    res.status(500).json({ error: e.message, channelId });
  }
});

// POST /live/batch
app.post('/live/batch', async (req, res) => {
  const { channelIds, nocache } = req.body;
  if (!Array.isArray(channelIds) || !channelIds.length)
    return res.status(400).json({ error: 'Envie um array channelIds' });
  if (channelIds.length > 20)
    return res.status(400).json({ error: 'Máximo 20 canais' });

  const results = {};
  for (let i = 0; i < channelIds.length; i += 2) {
    const chunk = channelIds.slice(i, i + 2);
    await Promise.all(chunk.map(async id => {
      if (!nocache) {
        const cached = getCache(id);
        if (cached) { results[id] = { ...cached, fromCache: true }; return; }
      }
      try { results[id] = await scrapeChannel(id); }
      catch(e) { results[id] = { live: false, viewers: null, subs: null, error: e.message }; }
    }));
    if (i + 2 < channelIds.length)
      await new Promise(r => setTimeout(r, 600));
  }

  res.json({ results, cachedAt: new Date().toISOString() });
});


// DEBUG — mostra trechos do HTML para diagnóstico
app.get('/debug/:channelId', async (req, res) => {
  const { channelId } = req.params;
  try {
    const r1   = await fetch(`https://www.youtube.com/channel/${channelId}`, { headers: HEADERS });
    const h1   = await r1.text();
    const r2   = await fetch(`https://www.youtube.com/channel/${channelId}/live`, { headers: HEADERS });
    const h2   = await r2.text();

    // Extrai trechos relevantes
    const snap = (html, pattern, label) => {
      const m = html.match(pattern);
      return m ? { [label]: m[0].substring(0, 300) } : { [label]: null };
    };

    res.json({
      channelPage: {
        length: h1.length,
        hasSubs: h1.includes('subscriberCount'),
        subsSnippet: h1.match(/subscriber[^"]{0,80}/i)?.[0] || null,
        subsText: h1.match(/"subscriberCountText":.{0,150}/)?.[0] || null,
        subsAlt: h1.match(/[\d\.,]+ (?:mi|mil|k|m) de inscritos/i)?.[0] || null,
      },
      livePage: {
        length: h2.length,
        finalUrl: r2.url,
        hasIsLive: h2.includes('isLive'),
        hasConcurrent: h2.includes('concurrentViewers'),
        concurrentSnippet: h2.match(/concurrentViewers.{0,100}/)?.[0] || null,
        viewCountSnippet: h2.match(/"viewCount":"[^"]+"/)?.[0] || null,
        watchingSnippet: h2.match(/.{0,30}assistindo agora.{0,50}/i)?.[0] || null,
        originalViewCount: h2.match(/.{0,10}originalViewCount.{0,50}/)?.[0] || null,
        originalViewCountEsc: h2.match(/.{0,10}originalViewCount.{0,80}/)?.map(m=>m)?.[0] || null,
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`YT Live Scraper rodando na porta ${PORT}`));
