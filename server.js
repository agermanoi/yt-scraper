const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// Permite chamadas do seu domínio
// Libera qualquer origem — ajuste depois se quiser restringir
app.use(cors());

app.use(express.json());

// ── Cache em memória para não sobrecarregar o YouTube ──
const cache = new Map();
const CACHE_TTL = 60 * 1000; // 60 segundos

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ── Scraper principal ──────────────────────────────────
async function scrapeChannel(channelId) {
  const cached = getCache(channelId);
  if (cached) return { ...cached, fromCache: true };

  // Busca a página /live do canal
  const url = `https://www.youtube.com/channel/${channelId}/live`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
  });

  const html = await res.text();

  // Extrai dados do ytInitialData embutido na página
  const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!match) {
    return { live: false, viewers: null, videoId: null, title: null };
  }

  let ytData;
  try { ytData = JSON.parse(match[1]); }
  catch { return { live: false, viewers: null, videoId: null, title: null }; }

  // Navega pela estrutura para achar o videoId e concurrent viewers
  const result = { live: false, viewers: null, videoId: null, title: null };

  try {
    // Tenta achar videoId via playerMicroformat
    const micro = ytData?.microformat?.playerMicroformatRenderer;
    if (micro?.liveBroadcastDetails?.isLiveNow === true) {
      result.live    = true;
      result.videoId = micro?.externalVideoId || null;
      result.title   = micro?.title?.simpleText || null;
    }
  } catch {}

  try {
    // Fallback: busca viewCount nos contents
    const str = JSON.stringify(ytData);

    // Extrai videoId
    if (!result.videoId) {
      const vidMatch = str.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (vidMatch) result.videoId = vidMatch[1];
    }

    // Extrai concurrent viewers
    const viewMatch = str.match(/"concurrentViewers":"(\d+)"/);
    if (viewMatch) {
      result.viewers = parseInt(viewMatch[1]);
      result.live    = true;
    }

    // Extrai "N assistindo agora" em PT-BR
    const ptMatch = str.match(/"([\d\.,]+)\s*assistindo agora"/);
    if (ptMatch && !result.viewers) {
      result.viewers = parseInt(ptMatch[1].replace(/\./g,'').replace(/,/g,''));
      result.live    = true;
    }

    // Detecta se está ao vivo pelo badge
    if (!result.live && str.includes('"BADGE_STYLE_TYPE_LIVE_NOW"')) {
      result.live = true;
    }

    // Extrai título se não achou ainda
    if (!result.title) {
      const titleMatch = str.match(/"title"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"/);
      if (titleMatch) result.title = titleMatch[1];
    }

  } catch {}

  // Thumbnail de alta qualidade
  if (result.videoId) {
    result.thumb = `https://i.ytimg.com/vi/${result.videoId}/maxresdefault_live.jpg`;
  }

  setCache(channelId, result);
  return { ...result, fromCache: false };
}

// ── ENDPOINTS ─────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'yt-live-scraper', uptime: process.uptime() });
});

// Scrapa um canal específico
// GET /live/:channelId
app.get('/live/:channelId', async (req, res) => {
  const { channelId } = req.params;
  if (!channelId || !channelId.startsWith('UC')) {
    return res.status(400).json({ error: 'Channel ID inválido' });
  }
  try {
    const data = await scrapeChannel(channelId);
    res.json({ channelId, ...data });
  } catch(e) {
    res.status(500).json({ error: e.message, channelId });
  }
});

// Scrapa múltiplos canais de uma vez
// POST /live/batch  body: { channelIds: ["UC...", "UC..."] }
app.post('/live/batch', async (req, res) => {
  const { channelIds } = req.body;
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return res.status(400).json({ error: 'Envie um array channelIds' });
  }
  if (channelIds.length > 20) {
    return res.status(400).json({ error: 'Máximo 20 canais por requisição' });
  }

  // Processa em paralelo com limite de 5 simultâneos
  const results = {};
  const chunks = [];
  for (let i = 0; i < channelIds.length; i += 5) {
    chunks.push(channelIds.slice(i, i + 5));
  }
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async id => {
      try {
        results[id] = await scrapeChannel(id);
      } catch(e) {
        results[id] = { live: false, viewers: null, error: e.message };
      }
    }));
    // pequeno delay entre chunks para não sobrecarregar
    if (chunks.indexOf(chunk) < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  res.json({ results, cachedAt: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`YT Live Scraper rodando na porta ${PORT}`);
});
