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
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

// Extrai todos os matches de um padrão no JSON
function extractAll(str, pattern) {
  const results = [];
  let m;
  const re = new RegExp(pattern, 'g');
  while ((m = re.exec(str)) !== null) results.push(m[1]);
  return results;
}

async function scrapeChannel(channelId) {
  const cached = getCache(channelId);
  if (cached) return { ...cached, fromCache: true };

  const result = {
    live: false, viewers: null, videoId: null,
    title: null, thumb: null, name: null,
    handle: null, subs: null, avatar: null,
  };

  // ── 1. Scrape página principal do canal (para nome, inscritos, avatar) ──
  try {
    const r   = await fetch(`https://www.youtube.com/channel/${channelId}`, { headers: HEADERS });
    const html = await r.text();

    // nome
    const nameM = html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/);
    if (nameM) result.name = nameM[1];

    // handle (@nome)
    const handleM = html.match(/"canonicalChannelUrl":"https:\/\/www\.youtube\.com\/(@[^"]+)"/);
    if (handleM) result.handle = handleM[1];

    // avatar — pega a maior thumbnail disponível
    const avatarM = html.match(/"avatar":\{"thumbnails":\[\{"url":"(https:\/\/yt3[^"]+)"/);
    if (avatarM) result.avatar = avatarM[1].replace(/=s\d+/, '=s88');

    // inscritos — tenta vários padrões
    const subsPatterns = [
      /"subscriberCountText":\{"simpleText":"([^"]+)"/,
      /"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"/,
      /"metadataRowRenderer":\{"title":\{"simpleText":"Inscritos"\},"contents":\[\{"simpleText":"([^"]+)"/,
      /"subscribers":\{"simpleText":"([^"]+)"/,
    ];
    for (const pat of subsPatterns) {
      const m = html.match(pat);
      if (m) { result.subs = m[1]; break; }
    }

    // fallback inscritos: busca "X de inscritos" ou "X subscribers"
    if (!result.subs) {
      const fbM = html.match(/"([0-9][0-9\.,]* (?:mi|mil|bi|M|K)?(?: de)? ?(?:inscritos|subscribers))"/i);
      if (fbM) result.subs = fbM[1];
    }
  } catch(e) {
    result.error_stats = e.message;
  }

  // ── 2. Scrape página /live do canal ──
  try {
    const r    = await fetch(`https://www.youtube.com/channel/${channelId}/live`, { headers: HEADERS });
    const html = await r.text();

    // Verifica se é realmente uma live — página de live redireciona para /watch?v=
    const isLivePage = r.url.includes('/watch?v=') || html.includes('"isLiveNow":true') || html.includes('"isLive":true');

    // videoId — pega o primeiro da URL redirecionada se houver
    if (r.url.includes('/watch?v=')) {
      const urlVid = r.url.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (urlVid) result.videoId = urlVid[1];
    }

    // videoId do HTML
    if (!result.videoId) {
      // busca videoId dentro de "currentVideoEndpoint"
      const cvM = html.match(/"currentVideoEndpoint":\{"clickTrackingParams":"[^"]*","commandMetadata":[^}]+\},"watchEndpoint":\{"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (cvM) result.videoId = cvM[1];
    }

    // concurrent viewers
    const viewPatterns = [
      /"concurrentViewers":"(\d+)"/,
      /"viewCount":"(\d+)"/,
    ];
    for (const pat of viewPatterns) {
      const m = html.match(pat);
      if (m && parseInt(m[1]) > 0) {
        result.viewers = parseInt(m[1]);
        result.live    = true;
        break;
      }
    }

    // "N assistindo agora"
    if (!result.viewers) {
      const ptM = html.match(/"([0-9][0-9\.,]*(?:\s*(?:mil|mi|k))?)(?:\s+(?:assistindo agora|watching now))"/i);
      if (ptM) {
        result.viewers = parseSubs(ptM[1]);
        result.live    = true;
      }
    }

    // badge de live
    if (!result.live) {
      result.live = html.includes('"BADGE_STYLE_TYPE_LIVE_NOW"')
        || html.includes('"isLiveNow":true')
        || html.includes('"style":"LIVE"')
        || isLivePage;
    }

    // título da live
    if (result.live && !result.title) {
      const titleM = html.match(/"videoDetails":\{"videoId":"[^"]+","title":"([^"]+)"/);
      if (titleM) result.title = titleM[1];
    }

    // se videoId encontrado mas não tem certeza se é live, verifica pelo título
    if (result.videoId && !result.live) {
      const liveTitle = html.match(/"isLiveContent":true/);
      if (liveTitle) result.live = true;
    }

  } catch(e) {
    result.error_live = e.message;
  }

  if (result.videoId && result.live) {
    result.thumb = `https://i.ytimg.com/vi/${result.videoId}/maxresdefault_live.jpg`;
  }

  setCache(channelId, result);
  return { ...result, fromCache: false };
}

function parseSubs(text) {
  if (!text) return 0;
  if (typeof text === 'number') return text;
  const t = text.toLowerCase().replace(/\s+/g,'').replace(',','.');
  if (t.includes('bi'))  return Math.round(parseFloat(t) * 1e9);
  if (t.includes('mi'))  return Math.round(parseFloat(t) * 1e6);
  if (t.includes('mil')) return Math.round(parseFloat(t) * 1e3);
  if (t.includes('m'))   return Math.round(parseFloat(t) * 1e6);
  if (t.includes('k'))   return Math.round(parseFloat(t) * 1e3);
  return parseInt(t.replace(/\D/g,'')) || 0;
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
    res.json({ channelId, ...await scrapeChannel(channelId) });
  } catch(e) {
    res.status(500).json({ error: e.message, channelId });
  }
});

// POST /live/batch
app.post('/live/batch', async (req, res) => {
  const { channelIds } = req.body;
  if (!Array.isArray(channelIds) || !channelIds.length)
    return res.status(400).json({ error: 'Envie um array channelIds' });
  if (channelIds.length > 20)
    return res.status(400).json({ error: 'Máximo 20 canais' });

  const results = {};
  // processa 2 por vez para não ser bloqueado
  for (let i = 0; i < channelIds.length; i += 2) {
    const chunk = channelIds.slice(i, i + 2);
    await Promise.all(chunk.map(async id => {
      try { results[id] = await scrapeChannel(id); }
      catch(e) { results[id] = { live: false, viewers: null, subs: null, error: e.message }; }
    }));
    if (i + 2 < channelIds.length)
      await new Promise(r => setTimeout(r, 800));
  }

  res.json({ results, cachedAt: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`YT Live Scraper rodando na porta ${PORT}`));
