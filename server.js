const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOCATIONS_FILE)) fs.writeFileSync(LOCATIONS_FILE, '[]');

function readLocations() {
  return JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf8'));
}
function saveLocations(locs) {
  fs.writeFileSync(LOCATIONS_FILE, JSON.stringify(locs, null, 2));
}

const NWS_BASE = 'https://api.weather.gov';
const USER_AGENT = '(custom-weather, nickrtitterton@gmail.com)';

async function nwsFetch(endpoint) {
  const url = `${NWS_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NWS ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function cToF(c) {
  return c !== null && c !== undefined ? Math.round(c * 9 / 5 + 32) : null;
}

function mmToIn(mm) {
  return mm !== null && mm !== undefined ? Math.round(mm / 25.4 * 100) / 100 : null;
}

function getDate(vt) {
  return vt.split('T')[0];
}

const CLOUD_MAP = { CLR: 0, FEW: 25, SCT: 50, BKN: 75, OVC: 100 };

function groupByDate(items, dateKey, valueKey) {
  const map = {};
  for (const item of items) {
    const d = getDate(item[dateKey]);
    if (!map[d]) map[d] = [];
    map[d].push(item[valueKey]);
  }
  return map;
}

function processForecast(gridData) {
  const p = gridData.properties;
  const maxTemps = (p.maxTemperature?.values || []).map(v => ({ date: getDate(v.validTime), v: cToF(v.value) }));
  const minTemps = (p.minTemperature?.values || []).map(v => ({ date: getDate(v.validTime), v: cToF(v.value) }));
  const sky = (p.skyCover?.values || []).map(v => ({ date: getDate(v.validTime), v: v.value }));
  const precip = (p.quantitativePrecipitation?.values || []).map(v => ({ date: getDate(v.validTime), v: v.value }));

  const dates = new Set([...maxTemps, ...minTemps, ...sky, ...precip].map(d => d.date));
  const today = new Date().toISOString().split('T')[0];

  const result = [];
  for (const date of dates) {
    if (date < today) continue;
    const highArr = maxTemps.filter(d => d.date === date).map(d => d.v).filter(v => v !== null);
    const lowArr = minTemps.filter(d => d.date === date).map(d => d.v).filter(v => v !== null);
    const skyArr = sky.filter(d => d.date === date).map(d => d.v).filter(v => v !== null);
    const precipArr = precip.filter(d => d.date === date).map(d => d.v).filter(v => v !== null && v > 0);

    result.push({
      date,
      high: highArr.length > 0 ? Math.max(...highArr) : null,
      low: lowArr.length > 0 ? Math.min(...lowArr) : null,
      skyCover: skyArr.length > 0 ? Math.round(skyArr.reduce((a, b) => a + b, 0) / skyArr.length) : null,
      precipitation: precipArr.length > 0 ? mmToIn(precipArr.reduce((a, b) => a + b, 0)) : 0
    });
  }

  return result.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
}

function processHistory(observations) {
  const byDate = {};

  for (const obs of observations) {
    const p = obs.properties;
    const date = getDate(p.timestamp);
    if (!byDate[date]) byDate[date] = { date, high: [], low: [], skyCovers: [], precip: 0 };

    const day = byDate[date];
    const temp = p.temperature?.value;
    if (temp !== null && temp !== undefined) {
      day.high.push(cToF(temp));
      day.low.push(cToF(temp));
    }
    if (p.maxTemperatureLast24Hours?.value !== null && p.maxTemperatureLast24Hours?.value !== undefined) {
      day.high.push(cToF(p.maxTemperatureLast24Hours.value));
    }
    if (p.minTemperatureLast24Hours?.value !== null && p.minTemperatureLast24Hours?.value !== undefined) {
      day.low.push(cToF(p.minTemperatureLast24Hours.value));
    }
    if (p.cloudLayers?.length > 0) {
      const maxCov = Math.max(...p.cloudLayers.map(l => CLOUD_MAP[l.amount] || 0));
      day.skyCovers.push(maxCov);
    }
    if (p.precipitationLastHour?.value !== null && p.precipitationLastHour?.value > 0) {
      day.precip += p.precipitationLastHour.value;
    } else if (p.precipitationLast3Hours?.value !== null && p.precipitationLast3Hours?.value > 0) {
      day.precip += p.precipitationLast3Hours.value / 3;
    } else if (p.precipitationLast6Hours?.value !== null && p.precipitationLast6Hours?.value > 0) {
      day.precip += p.precipitationLast6Hours.value / 6;
    }
  }

  const today = new Date().toISOString().split('T')[0];
  return Object.values(byDate)
    .filter(d => d.date < today)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .reverse()
    .map(d => ({
      date: d.date,
      high: d.high.length > 0 ? Math.round(Math.max(...d.high)) : null,
      low: d.low.length > 0 ? Math.round(Math.min(...d.low)) : null,
      skyCover: d.skyCovers.length > 0 ? Math.round(d.skyCovers.reduce((a, b) => a + b, 0) / d.skyCovers.length) : null,
      precipitation: d.precip > 0 ? mmToIn(d.precip) : 0
    }));
}

const weatherCache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

function getCached(key) {
  const entry = weatherCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key, data) {
  weatherCache.set(key, { data, ts: Date.now() });
}

app.get('/api/locations', (req, res) => {
  res.json(readLocations());
});

app.post('/api/locations', (req, res) => {
  const { name, lat, lon } = req.body;
  if (!name || lat === undefined || lon === undefined) {
    return res.status(400).json({ error: 'name, lat, and lon required' });
  }
  const locs = readLocations();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const loc = { id, name, lat: Number(lat), lon: Number(lon) };
  locs.push(loc);
  saveLocations(locs);
  res.status(201).json(loc);
});

app.delete('/api/locations/:id', (req, res) => {
  let locs = readLocations();
  locs = locs.filter(l => l.id !== req.params.id);
  saveLocations(locs);
  res.json({ ok: true });
});

app.get('/api/weather/:lat/:lon', async (req, res) => {
  const key = `${req.params.lat},${req.params.lon}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);

  try {
    const { lat, lon } = req.params;
    const points = await nwsFetch(`/points/${lat},${lon}`);

    const props = points.properties;
    const gridId = props.gridId;
    const gridX = props.gridX;
    const gridY = props.gridY;

    let locationName = `${lat}, ${lon}`;
    if (props.relativeLocation?.properties) {
      const r = props.relativeLocation.properties;
      locationName = `${r.city}, ${r.state}`;
    }

    const [gridData, stationsData] = await Promise.all([
      nwsFetch(props.forecastGridData.replace(NWS_BASE, '')),
      nwsFetch(`/gridpoints/${gridId}/${gridX},${gridY}/stations`)
    ]);

    const forecast = processForecast(gridData);

    let history = [];
    if (stationsData.features?.length > 0) {
      try {
        const stationId = stationsData.features[0].properties.stationIdentifier;
        const obsData = await nwsFetch(`/stations/${stationId}/observations?limit=300`);
        history = processHistory(obsData.features || []);
      } catch {
      }
    }

    const result = {
      location: { name: locationName, lat: Number(lat), lon: Number(lon), gridId, gridX, gridY },
      forecast,
      history
    };

    setCache(key, result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Custom Weather running at http://localhost:${PORT}`);
});
