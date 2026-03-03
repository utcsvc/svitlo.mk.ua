import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = process.env.TZ || 'Europe/Kiev';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'), { fallthrough: true }));

const OFF_ENERGY_ORIGIN = 'https://off.energy.mk.ua';
const SVITLO_ORIGIN = 'https://svitlo.bot';

const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function fetchJson(url, { ttlMs = 30_000 } = {}) {
  const cacheKey = `json:${url}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Upstream error ${res.status} for ${url}: ${text.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  cacheSet(cacheKey, data, ttlMs);
  return data;
}

async function fetchBuffer(url, { ttlMs = 3600_000 } = {}) {
  const cacheKey = `buf:${url}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`Upstream error ${res.status} for ${url}`);
    err.status = 502;
    throw err;
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await res.arrayBuffer();
  const value = { contentType, buffer: Buffer.from(arrayBuffer) };
  cacheSet(cacheKey, value, ttlMs);
  return value;
}

function normalizeKey(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

let nsIndexPromise = null;
async function getNsIndex() {
  if (nsIndexPromise) return nsIndexPromise;
  nsIndexPromise = (async () => {
    const filii = await fetchJson(`${OFF_ENERGY_ORIGIN}/api/addr/filii`, { ttlMs: 24 * 3600_000 });

    const results = [];
    const concurrency = 6;
    for (let i = 0; i < filii.length; i += concurrency) {
      const batch = filii.slice(i, i + concurrency);
      const batchNs = await Promise.all(
        batch.map((f) =>
          fetchJson(`${OFF_ENERGY_ORIGIN}/api/addr/filii/${encodeURIComponent(f.idfilial)}/ns`, {
            ttlMs: 24 * 3600_000
          }).catch(() => [])
        )
      );
      for (let j = 0; j < batch.length; j++) {
        const f = batch[j];
        const ns = batchNs[j] || [];
        ns.forEach((n) => {
          results.push({
            filiyaId: f.idfilial,
            filiyaName: f.fullname,
            nsId: n.idnaspunkt,
            nsName: n.naznaspunkt
          });
        });
      }
    }

    const byName = new Map();
    results.forEach((r) => {
      const key = normalizeKey(r.nsName);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(r);
    });

    return { all: results, byName };
  })();
  return nsIndexPromise;
}

async function getQueues() {
  const queues = await fetchJson(`${OFF_ENERGY_ORIGIN}/api/outage-queue/by-type/3`, { ttlMs: 5 * 60_000 });
  return (queues || []).filter((q) => !q.deleted);
}

function parseTimeToMinutes(hms) {
  const [hh, mm] = String(hms).split(':').map((v) => parseInt(v, 10));
  return hh * 60 + mm;
}

function fmtHmFromMinutes(min) {
  if (min >= 1440) return '00:00';
  const hh = Math.floor(min / 60) % 24;
  const mm = min % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function fmtHoursFromMinutes(min) {
  const hours = min / 60;
  if (Number.isInteger(hours)) return `${hours} год.`;
  const rounded = Math.round(hours * 2) / 2;
  if (Number.isInteger(rounded)) return `${rounded} год.`;
  return `${rounded.toFixed(1).replace(/\.0$/, '')} год.`;
}

function dateKeyLocal(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDaySchedule({ series, queueId, timeSeries }) {
  const typeBySlotId = new Map();
  for (const slot of timeSeries) typeBySlotId.set(slot.id, 'ENABLE');

  for (const item of series || []) {
    if (item.outage_queue_id !== queueId) continue;
    const prev = typeBySlotId.get(item.time_series_id) || 'ENABLE';
    if (prev === 'SURE_OFF') continue;
    typeBySlotId.set(item.time_series_id, item.type);
  }

  const slots = timeSeries
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((slot) => {
      const startMin = parseTimeToMinutes(slot.start);
      let endMin = parseTimeToMinutes(slot.end);
      if (String(slot.end).startsWith('00:00')) endMin = 1440;
      const type = typeBySlotId.get(slot.id) || 'ENABLE';
      const isOff = type !== 'ENABLE';
      return { startMin, endMin, type, isOff };
    });

  const offIntervals = [];
  let current = null;
  for (const s of slots) {
    if (s.isOff) {
      if (!current) {
        current = { startMin: s.startMin, endMin: s.endMin, type: s.type };
      } else if (current.endMin === s.startMin) {
        current.endMin = s.endMin;
        if (current.type !== 'SURE_OFF' && s.type === 'SURE_OFF') current.type = 'SURE_OFF';
      } else {
        offIntervals.push(current);
        current = { startMin: s.startMin, endMin: s.endMin, type: s.type };
      }
    } else if (current) {
      offIntervals.push(current);
      current = null;
    }
  }
  if (current) offIntervals.push(current);

  const offMinutes = offIntervals.reduce((sum, i) => sum + (i.endMin - i.startMin), 0);
  const onMinutes = 1440 - offMinutes;

  return { offIntervals, offMinutes, onMinutes };
}

function findPowerProgress({ now, dayStart, offIntervals }) {
  const nowMin = (now.getTime() - dayStart.getTime()) / 60000;

  const inOff = offIntervals.find((i) => i.startMin <= nowMin && nowMin < i.endMin);
  if (inOff) {
    const from = new Date(dayStart.getTime() + inOff.startMin * 60000);
    const to = new Date(dayStart.getTime() + inOff.endMin * 60000);
    return { mode: 'off', from, to, nextInterval: inOff };
  }

  const next = offIntervals.find((i) => nowMin < i.startMin) || null;
  const prev = [...offIntervals].reverse().find((i) => i.endMin <= nowMin) || null;

  const segStartMin = prev ? prev.endMin : 0;
  const segEndMin = next ? next.startMin : 1440;

  const from = new Date(dayStart.getTime() + segStartMin * 60000);
  const to = new Date(dayStart.getTime() + segEndMin * 60000);

  return { mode: 'on', from, to, nextInterval: next };
}

function slugToQueueName(slug) {
  return String(slug || '').replace(/-/g, '.');
}
function queueNameToSlug(name) {
  return String(name || '').replace(/\./g, '-');
}

app.get(['/assets/styles.css', '/assets/styles.css*'], async (req, res, next) => {
  try {
    const { contentType, buffer } = await fetchBuffer(`${SVITLO_ORIGIN}/assets/styles.css`, { ttlMs: 6 * 3600_000 });
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'public, max-age=21600');
    res.send(buffer);
  } catch (e) {
    next(e);
  }
});

app.get('/assets/img/*', async (req, res, next) => {
  try {
    const rel = req.path.replace(/^\//, '');
    const { contentType, buffer } = await fetchBuffer(`${SVITLO_ORIGIN}/${rel}`, { ttlMs: 24 * 3600_000 });
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(buffer);
  } catch (e) {
    next(e);
  }
});

app.get(['/favicon_1.ico', '/icon.png'], async (req, res, next) => {
  try {
    const rel = req.path.replace(/^\//, '');
    const { contentType, buffer } = await fetchBuffer(`${SVITLO_ORIGIN}/${rel}`, { ttlMs: 24 * 3600_000 });
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(buffer);
  } catch (e) {
    next(e);
  }
});

app.get('/', async (req, res, next) => {
  try {
    const queues = await getQueues();
    res.render('index', {
      regionTitle: 'Миколаївська область',
      regionTag: 'Миколаївська обл.',
      queues: queues.map((q) => ({ name: q.name, slug: queueNameToSlug(q.name) }))
    });
  } catch (e) {
    next(e);
  }
});

app.get('/queue/:queueSlug', async (req, res, next) => {
  try {
    const queueSlug = req.params.queueSlug;
    const queueName = slugToQueueName(queueSlug);

    const queues = await getQueues();
    const queue = queues.find((q) => q.name === queueName);
    if (!queue) {
      res.status(404).send('Queue not found');
      return;
    }

    const [timeSeries, active] = await Promise.all([
      fetchJson(`${OFF_ENERGY_ORIGIN}/api/schedule/time-series`, { ttlMs: 6 * 3600_000 }),
      fetchJson(`${OFF_ENERGY_ORIGIN}/api/v2/schedule/active`, { ttlMs: 30_000 })
    ]);

    const grouped = new Map();
    for (const item of active || []) {
      const d = new Date(item.from);
      const k = dateKeyLocal(d);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(...(item.series || []));
    }

    const now = new Date();
    const todayKey = dateKeyLocal(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = dateKeyLocal(tomorrow);

    function buildForDay(dayKey) {
      const dayDate = new Date(dayKey + 'T00:00:00');
      const dayStart = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 0, 0, 0);
      const series = grouped.get(dayKey) || [];

      const { offIntervals, offMinutes, onMinutes } = buildDaySchedule({
        series,
        queueId: queue.id,
        timeSeries
      });

      const list = offIntervals.map((i) => ({
        from: fmtHmFromMinutes(i.startMin),
        to: fmtHmFromMinutes(i.endMin),
        duration: fmtHoursFromMinutes(i.endMin - i.startMin),
        startMin: i.startMin,
        endMin: i.endMin
      }));

      return { dayStart, offIntervals, offMinutes, onMinutes, list };
    }

    const today = buildForDay(todayKey);
    const tomorrowData = buildForDay(tomorrowKey);

    const progress = findPowerProgress({ now, dayStart: today.dayStart, offIntervals: today.offIntervals });
    const progressFrom = Math.floor(progress.from.getTime() / 1000);
    const progressTo = Math.floor(progress.to.getTime() / 1000);

    let currentScheduleKey = null;
    if (progress.nextInterval) {
      currentScheduleKey = `${progress.nextInterval.startMin}-${progress.nextInterval.endMin}`;
    }

    res.render('queue', {
      regionTitle: 'Миколаївській області',
      regionTag: 'Миколаївська обл.',
      queueName,
      queueSlug,
      today: {
        offLabel: fmtHoursFromMinutes(today.offMinutes),
        onLabel: fmtHoursFromMinutes(today.onMinutes),
        list: today.list,
        currentScheduleKey
      },
      tomorrow: {
        list: tomorrowData.list
      },
      powerProgress: {
        mode: progress.mode,
        from: progressFrom,
        to: progressTo,
        label: progress.mode === 'off' ? 'Триває відключення' : 'Світло є'
      }
    });
  } catch (e) {
    next(e);
  }
});

app.get('/ajax/get_cities', async (req, res, next) => {
  try {
    const term = String(req.query.term || '').trim();
    const { all } = await getNsIndex();
    const uniq = new Map();
    for (const r of all) {
      const name = String(r.nsName || '').trim();
      if (!name) continue;
      const key = normalizeKey(name);
      if (!uniq.has(key)) uniq.set(key, name);
    }
    let list = [...uniq.values()];
    if (term) {
      const t = normalizeKey(term);
      list = list.filter((v) => normalizeKey(v).includes(t));
    }
    list.sort((a, b) => a.localeCompare(b, 'uk'));
    res.json(list.slice(0, 50));
  } catch (e) {
    next(e);
  }
});

app.get('/ajax/get_streets', async (req, res, next) => {
  try {
    const city = String(req.query.city || '').trim();
    const term = String(req.query.term || '').trim();
    if (!city) {
      res.json([]);
      return;
    }

    const { byName } = await getNsIndex();
    const candidates = byName.get(normalizeKey(city)) || [];
    const picked = candidates[0];
    if (!picked) {
      res.json([]);
      return;
    }

    const streets = await fetchJson(`${OFF_ENERGY_ORIGIN}/api/addr/ns/${encodeURIComponent(picked.nsId)}/street`, {
      ttlMs: 24 * 3600_000
    });
    let list = (streets || []).map((s) => s.nazstreet).filter(Boolean);

    if (term) {
      const t = normalizeKey(term);
      list = list.filter((v) => normalizeKey(v).includes(t));
    }
    list.sort((a, b) => a.localeCompare(b, 'uk'));
    res.json(list.slice(0, 50));
  } catch (e) {
    next(e);
  }
});

app.get('/ajax/get_nums', async (req, res, next) => {
  try {
    const city = String(req.query.city || '').trim();
    const street = String(req.query.street || '').trim();
    const term = String(req.query.term || '').trim();
    if (!city || !street) {
      res.json([]);
      return;
    }

    const { byName } = await getNsIndex();
    const candidates = byName.get(normalizeKey(city)) || [];
    const picked = candidates[0];
    if (!picked) {
      res.json([]);
      return;
    }

    const streets = await fetchJson(`${OFF_ENERGY_ORIGIN}/api/addr/ns/${encodeURIComponent(picked.nsId)}/street`, {
      ttlMs: 24 * 3600_000
    });
    const stObj = (streets || []).find((s) => normalizeKey(s.nazstreet) === normalizeKey(street));
    if (!stObj) {
      res.json([]);
      return;
    }

    const doms = await fetchJson(`${OFF_ENERGY_ORIGIN}/api/addr/street/${encodeURIComponent(stObj.idstreet)}/dom`, {
      ttlMs: 24 * 3600_000
    });
    let list = (doms || []).map((d) => d.nazdom).filter(Boolean);
    if (term) {
      const t = normalizeKey(term);
      list = list.filter((v) => normalizeKey(v).includes(t));
    }
    list.sort((a, b) => a.localeCompare(b, 'uk'));
    res.json(list.slice(0, 50));
  } catch (e) {
    next(e);
  }
});

app.get('/ajax/start_search', async (req, res, next) => {
  try {
    const city = String(req.query.city || '').trim();
    const street = String(req.query.street || '').trim();
    const num = String(req.query.num || '').trim();
    const ALL = 'Всі вулиці';
    const ALL2 = 'Усі будинки';

    if (!city || !street || !num || street === ALL || num === ALL2) {
      res.json({ redirect: null });
      return;
    }

    const { byName } = await getNsIndex();
    const candidates = byName.get(normalizeKey(city)) || [];
    const picked = candidates[0];
    if (!picked) {
      res.json({ redirect: null });
      return;
    }

    const streets = await fetchJson(`${OFF_ENERGY_ORIGIN}/api/addr/ns/${encodeURIComponent(picked.nsId)}/street`, {
      ttlMs: 24 * 3600_000
    });
    const stObj = (streets || []).find((s) => normalizeKey(s.nazstreet) === normalizeKey(street));
    if (!stObj) {
      res.json({ redirect: null });
      return;
    }

    const doms = await fetchJson(`${OFF_ENERGY_ORIGIN}/api/addr/street/${encodeURIComponent(stObj.idstreet)}/dom`, {
      ttlMs: 24 * 3600_000
    });
    const domObj = (doms || []).find((d) => normalizeKey(d.nazdom) === normalizeKey(num));
    if (!domObj) {
      res.json({ redirect: null });
      return;
    }

    const outage = await fetchJson(
      `${OFF_ENERGY_ORIGIN}/api/addr/dom/${encodeURIComponent(domObj.iddom)}/outage-queue`,
      { ttlMs: 60_000 }
    );
    const first = Array.isArray(outage) ? outage[0] : null;
    const queueName = first?.outage?.name;
    if (!queueName) {
      res.json({ redirect: null });
      return;
    }

    res.json({ redirect: `/queue/${queueNameToSlug(queueName)}` });
  } catch (e) {
    next(e);
  }
});

app.get('/about.html', (req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="uk"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="/styles.css?v=1" />
  <title>Контакти</title>
</head>
<body>
  <header>
    <div class="container">
      <div class="topbar">
        <a class="brand" href="/"><span class="logo" aria-hidden="true"></span><b>Відключення світла</b></a>
        <div class="region-pill"><span class="region-dot" aria-hidden="true"></span><span>Миколаївська обл.</span></div>
      </div>
    </div>
  </header>
  <main>
    <div class="container">
      <h1 style="margin:24px 0 10px;">Контакти</h1>
      <p>Дані про відключення: <a href="https://off.energy.mk.ua/" target="_blank" rel="noreferrer">off.energy.mk.ua</a></p>
    </div>
  </main>
  <footer>
    <div class="container">
      <div class="foot">
        <span>Дані: <a href="https://off.energy.mk.ua" target="_blank" rel="noreferrer">off.energy.mk.ua</a></span>
        <a href="/about.html">Контакти</a>
      </div>
    </div>
  </footer>
</body></html>
  `);
});

app.get('/image/all/:type/render/:ts', (req, res) => {
  res.status(501).send('Image render is not implemented in this clone.');
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).type('text').send(err.message || 'Server error');
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
