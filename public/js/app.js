let map;
let markers = {};
let dialogLat = null;
let dialogLon = null;
let clickTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadLocations();

  document.getElementById('dialog-cancel').addEventListener('click', closeDialog);
  document.getElementById('dialog-close').addEventListener('click', closeDialog);
  document.getElementById('dialog-confirm').addEventListener('click', confirmAddLocation);
  document.getElementById('location-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDialog();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDialog();
  });
  document.getElementById('location-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmAddLocation();
  });
});

function initMap() {
  map = L.map('map', {
    center: [39.8283, -98.5795],
    zoom: 4,
    zoomControl: true
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(map);

  map.on('click', onMapClick);
}

function onMapClick(e) {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    dialogLat = e.latlng.lat.toFixed(4);
    dialogLon = e.latlng.lng.toFixed(4);
    document.getElementById('dialog-coords').textContent = `Lat: ${dialogLat}, Lon: ${dialogLon}`;
    document.getElementById('location-name').value = '';
    document.getElementById('location-dialog').classList.remove('hidden');
    setTimeout(() => document.getElementById('location-name').focus(), 100);
  }, 280);
}

function closeDialog() {
  document.getElementById('location-dialog').classList.add('hidden');
  dialogLat = null;
  dialogLon = null;
}

function updateMapHeight() {
  const hasCards = document.getElementById('cards').children.length > 0;
  const mapEl = document.getElementById('map');
  mapEl.classList.toggle('map-compact', hasCards);
  if (map) setTimeout(() => map.invalidateSize(), 50);
}

async function confirmAddLocation() {
  const name = document.getElementById('location-name').value.trim();
  if (!name || !dialogLat || !dialogLon) return;

  try {
    const res = await fetch('/api/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, lat: dialogLat, lon: dialogLon })
    });
    if (!res.ok) throw new Error('Failed to save location');
    const loc = await res.json();
    closeDialog();
    document.getElementById('loading-state').classList.add('hidden');
    addMarker(loc);
    renderLocationCard(loc);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function loadLocations() {
  try {
    const res = await fetch('/api/locations');
    const locs = await res.json();
    document.getElementById('loading-state').classList.add('hidden');

    for (const loc of locs) {
      addMarker(loc);
      renderLocationCard(loc);
    }
    updateMapHeight();
  } catch (err) {
    document.getElementById('loading-state').innerHTML = `<p class="card-error">Failed to load locations: ${err.message}</p>`;
  }
}

function addMarker(loc) {
  const marker = L.marker([loc.lat, loc.lon])
    .addTo(map)
    .bindPopup(`<b>${loc.name}</b><br>${loc.lat}, ${loc.lon}`);
  markers[loc.id] = marker;
}

async function renderLocationCard(loc) {
  const cards = document.getElementById('cards');
  const existing = document.getElementById(`card-${loc.id}`);
  if (existing) existing.remove();

  const card = document.createElement('div');
  card.id = `card-${loc.id}`;
  card.className = 'weather-card';
  card.innerHTML = `
    <div class="card-header">
      <div>
        <h3>${escapeHtml(loc.name)}</h3>
        <div class="coords">${loc.lat}, ${loc.lon}</div>
      </div>
      <button class="btn btn-danger" onclick="removeLocation('${loc.id}')">Remove</button>
    </div>
    <div id="weather-${loc.id}">
      <div class="card-loading">Loading weather data...</div>
    </div>
  `;
  cards.appendChild(card);
  updateMapHeight();

  fetchWeather(loc);
}

async function fetchWeather(loc) {
  const container = document.getElementById(`weather-${loc.id}`);
  if (!container) return;

  try {
    const res = await fetch(`/api/weather/${loc.lat}/${loc.lon}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }
    const data = await res.json();
    container.innerHTML = buildWeatherHTML(data);
  } catch (err) {
    container.innerHTML = `<div class="card-error">${escapeHtml(err.message)}</div>`;
  }
}

function buildWeatherHTML(data) {
  const noData = `<span class="na">--</span>`;

  function row(d, label) {
    const dateStr = d ? formatDate(d.date) : label;
    const high = d && d.high !== null ? `${d.high}°` : noData;
    const low = d && d.low !== null ? `${d.low}°` : noData;
    const cloud = d && d.skyCover !== null ? `${d.skyCover}%` : noData;
    const precip = d && d.precipitation !== null && d.precipitation !== undefined
      ? (d.precipitation > 0 ? `${d.precipitation.toFixed(2)}"` : `0"`)
      : noData;
    const humid = d && d.humidity !== null ? `${d.humidity}%` : noData;
    return `<tr>
      <td class="date">${dateStr}</td>
      <td class="high">${high}</td>
      <td class="low">${low}</td>
      <td class="humidity">${humid}</td>
      <td class="cloud">${cloud}</td>
      <td class="precip">${precip}</td>
    </tr>`;
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  const hasHistory = data.history && data.history.length > 0;
  const hasForecast = data.forecast && data.forecast.length > 0;

  let html = '<div class="weather-tables">';

  html += '<div class="table-section"><h4>Previous 5 Days</h4><table><thead><tr><th>Date</th><th>High</th><th>Low</th><th>Hum</th><th>Cloud</th><th>Precip</th></tr></thead><tbody>';
  if (hasHistory) {
    for (const d of data.history) html += row(d);
  } else {
    html += `<tr><td colspan="6" style="text-align:center;color:#475569;">No historical data</td></tr>`;
  }
  html += '</tbody></table></div>';

  html += '<div class="table-section"><h4>Next 5 Days</h4><table><thead><tr><th>Date</th><th>High</th><th>Low</th><th>Hum</th><th>Cloud</th><th>Precip</th></tr></thead><tbody>';
  if (hasForecast) {
    for (const d of data.forecast) html += row(d);
  } else {
    html += `<tr><td colspan="6" style="text-align:center;color:#475569;">No forecast data</td></tr>`;
  }
  html += '</tbody></table></div>';

  html += '</div>';
  return html;
}

async function removeLocation(id) {
  try {
    await fetch(`/api/locations/${id}`, { method: 'DELETE' });
    const card = document.getElementById(`card-${id}`);
    if (card) card.remove();
    if (markers[id]) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }
    updateMapHeight();
    if (document.getElementById('cards').children.length === 0) {
      document.getElementById('loading-state').classList.remove('hidden');
      document.getElementById('loading-state').innerHTML = '<p>Click on the map to add a location</p>';
    }
  } catch (err) {
    alert('Error removing location: ' + err.message);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
