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

    // inscritos via scraping — sem API, sem cota
    // busca na página principal padrões conhecidos
    const subsPatterns = [
      /"subscriberCountText":\{"simpleText":"([^"]+)"/,
      /"subscriberCountText":\{"runs":\[\{"text":"([^"]+)"/,
      /"subscriberCount":"(\d+)"/,
      /,"subscriberCount":"(\d+)","hiddenSubscriberCount"/,
    ];
    for (const p of subsPatterns) {
      const m = html.match(p);
      if (m && m[1]) { result.subs = parseSubs(m[1]); break; }
    }

    // fallback: scrape /about que tem inscritos visíveis
    if (!result.subs) {
      try {
        const aboutR = await fetch(`https://www.youtube.com/channel/${channelId}/about`, { headers: HEADERS });
        const aboutHtml = await aboutR.text();
        for (const p of subsPatterns) {
          const m = aboutHtml.match(p);
          if (m && m[1]) { result.subs = parseSubs(m[1]); break; }
        }
        // padrão extra na página about
        if (!result.subs) {
          const aboutM = aboutHtml.match(/"(\d[\d\.\,]* (?:mi|mil|bi|k|m)?(?:\s*de)?\s*inscritos)"/i);
          if (aboutM) result.subs = parseSubs(aboutM[1]);
        }
      } catch {}
    }

  } catch(e) { result.error_stats = e.message; }

  // ── 2. Busca TODAS as lives do canal via /search ──
  try {
    const searchUrl = `https://www.youtube.com/channel/${channelId}/search?query=`;
    // usa a página /videos?view=2 que lista conteúdo ao vivo
    const liveSearchUrl = `https://www.youtube.com/channel/${channelId}/streams`;
    const r    = await fetch(`https://www.youtube.com/channel/${channelId}/live`, { headers: HEADERS });
    const html = await r.text();
    const finalUrl = r.url;

    // videoId da URL redirecionada
    if (finalUrl.includes('/watch?v=')) {
      result.live = true;
      const urlVid = finalUrl.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (urlVid) result.videoId = urlVid[1];
    }

    // playerResponse
    const player = extractPlayerResponse(html);
    if (player) {
      const vd = player?.videoDetails;
      if (vd?.isLive || vd?.isLiveContent) {
        result.live    = true;
        result.videoId = result.videoId || vd?.videoId || null;
        result.title   = vd?.title || null;
        if (vd?.viewCount && parseInt(vd.viewCount) > 0)
          result.viewers = parseInt(vd.viewCount);
      }
    }

    // viewers — padrão confirmado: "originalViewCount":"NNNN"
    const origViewM = html.match(/"originalViewCount":"(\d+)"/);
    if (origViewM && parseInt(origViewM[1]) > 0) {
      result.viewers = parseInt(origViewM[1]); result.live = true;
    }
    if (!result.viewers) {
      const escM = html.match(/\\"originalViewCount\\":\\"(\d+)\\"/);
      if (escM && parseInt(escM[1]) > 0) { result.viewers = parseInt(escM[1]); result.live = true; }
    }
    if (!result.viewers) {
      const cvM = html.match(/"concurrentViewers":"(\d+)"/);
      if (cvM && parseInt(cvM[1]) > 0) { result.viewers = parseInt(cvM[1]); result.live = true; }
    }
    if (!result.viewers) {
      const watchM = html.match(/([\d\.\,]+)\s*assistindo agora/i);
      if (watchM) { result.viewers = parseSubs(watchM[1]); result.live = true; }
    }

    if (!result.live) {
      result.live = html.includes('"BADGE_STYLE_TYPE_LIVE_NOW"')
        || html.includes('"isLive":true')
        || html.includes('"isLiveNow":true');
    }

    // título
    if (!result.title && result.live) {
      const ytData = extractYtData(html);
      if (ytData) {
        const str = JSON.stringify(ytData);
        const titleM = str.match(/"videoPrimaryInfoRenderer":\{"title":\{"runs":\[\{"text":"([^"]+)"/);
        if (titleM) result.title = titleM[1];
      }
    }

    if (!result.videoId && result.live) {
      const vidM = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (vidM) result.videoId = vidM[1];
    }

  } catch(e) { result.error_live = e.message; }

  // ── 3. Busca lives adicionais na página /streams ──
  result.extraLives = [];
  try {
    const r2    = await fetch(`https://www.youtube.com/channel/${channelId}/streams`, { headers: HEADERS });
    const html2 = await r2.text();
    const ytData2 = extractYtData(html2);
    if (ytData2) {
      // Navega pelos gridVideoRenderer / videoRenderer para achar só os que estão LIVE agora
      const str = JSON.stringify(ytData2);

      // Cada vídeo ao vivo tem "thumbnailOverlays" com "LIVE" e um "videoId" próximo
      // Estratégia: achar blocos que contenham SIMULTANEAMENTE "LIVE_NOW" E um viewCount ativo
      // O padrão mais confiável: "isLive":true dentro do mesmo bloco de videoRenderer
      
      // Extrai todos os blocos de videoRenderer
      const rendererMatches = str.match(/"videoRenderer":\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || [];
      
      for (const block of rendererMatches) {
        // só processa se o bloco indica live ATIVA (não upcoming, não ended)
        const isActiveLive = block.includes('"BADGE_STYLE_TYPE_LIVE_NOW"') ||
                             (block.includes('"style":"LIVE"') && !block.includes('"isUpcoming"'));
        if (!isActiveLive) continue;

        const vidM   = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const titleM = block.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
        if (!vidM) continue;
        const videoId = vidM[1];
        if (videoId === result.videoId) continue; // já é a live principal

        result.extraLives.push({
          videoId,
          title: titleM ? titleM[1] : null,
          thumb: `https://i.ytimg.com/vi/${videoId}/maxresdefault_live.jpg`,
          ytLink: `https://www.youtube.com/watch?v=${videoId}`,
        });
      }
    }
  } catch(e) { result.error_streams = e.message; }

  if (result.videoId && result.live) {
    result.thumb  = `https://i.ytimg.com/vi/${result.videoId}/maxresdefault_live.jpg`;
    result.ytLink = `https://www.youtube.com/watch?v=${result.videoId}`;
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
      },
      aboutPage: await (async () => {
        try {
          const r3 = await fetch(`https://www.youtube.com/channel/${channelId}/about`, { headers: HEADERS });
          const h3 = await r3.text();
          return {
            length: h3.length,
            hasSubs: h3.includes('subscriberCount'),
            subsSnippet: h3.match(/subscriber[^"]{0,120}/i)?.[0] || null,
            subsText: h3.match(/"subscriberCountText":.{0,150}/)?.[0] || null,
            rawSubs: h3.match(/"subscriberCount":"[^"]+"/)?.[0] || null,
          };
        } catch(e) { return { error: e.message }; }
      })(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`YT Live Scraper rodando na porta ${PORT}`));
