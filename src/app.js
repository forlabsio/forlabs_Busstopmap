// 마라톤 노선 관리 — 앱 로직
import { haversine, totalDistance, cumulativeDistances, corridorCandidates, thin } from './geo.js';
import { encodeRoute, decodeRoute, resolveIds } from './share.js';
import {
  parseStore, serializeStore, upsertRoute, removeRoute, uniqueName, newRoute,
  loadFromBrowser, saveToBrowser, STORAGE_KEY,
} from './store.js';

const BASEMAP = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const PACE_KMH = 10;

const S = {
  map: null,
  stops: [],              // {id,name,lat,lng,city}
  byId: new Map(),
  store: { routes: [] },
  route: { id: null, name: '새 노선', region: null, stops: [] },
  waypoints: [],
  candidates: [],         // 거점 모드 미리보기 후보
  preview: [],
  composing: false,
  viewer: false,
  region: '',
  wpMarkers: [],
  edgeMarkers: [],
};

const $ = id => document.getElementById(id);
const fmtKm = km => (km < 10 ? km.toFixed(2) : km.toFixed(1));

function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ───────────────────────── 테마 ───────────────────────── */

function currentTheme() {
  const saved = localStorage.getItem('route-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(mode, { redraw = true } = {}) {
  document.documentElement.dataset.theme = mode;
  localStorage.setItem('route-theme', mode);

  // 버튼은 "누르면 될 상태"를 보여준다
  const btn = $('theme-btn');
  if (btn) {
    btn.textContent = mode === 'dark' ? '☀' : '☾';
    btn.title = mode === 'dark' ? '밝은 테마로 전환' : '어두운 테마로 전환';
  }
  if (redraw && S.map) {
    S.map.setStyle(BASEMAP[mode]);
    S.map.once('styledata', () => { installLayers(); drawRoute(); drawPreview(); });
  }
}

/* ───────────────────────── 데이터 ───────────────────────── */

async function loadStops() {
  const inline = document.getElementById('stops-inline');
  const rows = inline
    ? JSON.parse(inline.textContent)
    : await fetch('data/stops.json').then(r => {
        if (!r.ok) throw new Error('정류장 데이터를 불러오지 못했습니다 (' + r.status + ')');
        return r.json();
      });
  S.stops = rows.map(([id, name, lat, lng, city]) => ({ id, name, lat, lng, city }));
  S.byId = new Map(S.stops.map(s => [s.id, s]));

  const regions = [...new Set(S.stops.map(s => s.city))].sort();
  const sel = $('region');
  regions.forEach(r => sel.add(new Option(r, r)));
}

function stopsFeatureCollection() {
  const list = S.region ? S.stops.filter(s => s.city === S.region) : S.stops;
  return {
    type: 'FeatureCollection',
    features: list.map(s => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name },
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    })),
  };
}

/* ───────────────────────── 지도 ───────────────────────── */

function koreanLabels() {
  for (const l of S.map.getStyle().layers) {
    if (l.type !== 'symbol') continue;
    try {
      S.map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ko'], ['get', 'name']]);
    } catch { /* 라벨이 없는 레이어는 넘어간다 */ }
  }
}

function installLayers() {
  koreanLabels();
  const c = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // 정류장 (클러스터)
  S.map.addSource('stops', {
    type: 'geojson', data: stopsFeatureCollection(),
    cluster: true, clusterMaxZoom: 13, clusterRadius: 50,
  });
  S.map.addLayer({
    id: 'clusters', type: 'circle', source: 'stops', filter: ['has', 'point_count'],
    paint: {
      'circle-color': c('--cluster-bg'), 'circle-opacity': .85,
      'circle-radius': ['step', ['get', 'point_count'], 13, 100, 17, 1000, 23],
      'circle-stroke-width': 1.5, 'circle-stroke-color': c('--canvas'),
    },
  });
  S.map.addLayer({
    id: 'cluster-count', type: 'symbol', source: 'stops', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 10.5, 'text-font': ['Open Sans Bold'] },
    paint: { 'text-color': c('--cluster-fg') },
  });
  S.map.addLayer({
    id: 'stop-dots', type: 'circle', source: 'stops', filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 6],
      'circle-color': c('--canvas'), 'circle-stroke-width': 2, 'circle-stroke-color': c('--cluster-bg'),
    },
  });

  // 미리보기 (거점 모드)
  S.map.addSource('preview', { type: 'geojson', data: emptyFC() });
  S.map.addLayer({
    id: 'preview-line', type: 'line', source: 'preview',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': c('--muted'), 'line-width': 4, 'line-dasharray': [2, 1.5], 'line-opacity': .9 },
  });
  S.map.addLayer({
    id: 'preview-dots', type: 'circle', source: 'preview',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': c('--muted'), 'circle-opacity': .85 },
  });

  // 노선
  S.map.addSource('route', { type: 'geojson', data: emptyFC() });
  S.map.addLayer({
    id: 'route-casing', type: 'line', source: 'route',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': c('--canvas'), 'line-width': 9 },
  });
  S.map.addLayer({
    id: 'route-line', type: 'line', source: 'route',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': c('--primary'), 'line-width': 5 },
  });
  S.map.addLayer({
    id: 'route-dots', type: 'circle', source: 'route',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 5, 'circle-color': c('--canvas'),
      'circle-stroke-width': 3, 'circle-stroke-color': c('--primary'),
    },
  });
}

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

function initMap() {
  S.map = new maplibregl.Map({
    container: 'map',
    style: BASEMAP[currentTheme()],
    center: [126.95, 37.54], zoom: 11,
    attributionControl: { compact: true },
    preserveDrawingBuffer: true,   // 인쇄에 필요
  });
  S.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');

  S.map.on('load', () => {
    installLayers();
    $('loading').classList.add('hidden');

    S.map.on('click', 'clusters', e => {
      if (S.composing) return;        // 거점 모드에서는 확대 대신 거점을 찍는다
      const f = e.features[0];
      S.map.getSource('stops').getClusterExpansionZoom(f.properties.cluster_id).then(z => {
        S.map.easeTo({ center: f.geometry.coordinates, zoom: z });
      });
    });
    S.map.on('click', 'stop-dots', e => {
      if (S.viewer || S.composing) return;
      toggleStop(e.features[0].properties.id);
    });
    S.map.on('click', e => {
      if (S.composing) addWaypoint(e.lngLat);
    });
    for (const id of ['clusters', 'stop-dots']) {
      S.map.on('mouseenter', id, () => { S.map.getCanvas().style.cursor = 'pointer'; });
      S.map.on('mouseleave', id, () => { S.map.getCanvas().style.cursor = ''; });
    }
    S.map.on('mousemove', 'stop-dots', e => {
      S.map.getCanvas().title = e.features[0].properties.name;
    });

    bootRouteFromUrl();
  });
}

/* ───────────────────────── 노선 그리기 ───────────────────────── */

function routeFC(stops) {
  const fc = emptyFC();
  if (stops.length > 1) {
    fc.features.push({
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: stops.map(s => [s.lng, s.lat]) },
    });
  }
  stops.forEach(s => fc.features.push({
    type: 'Feature', properties: { id: s.id },
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
  }));
  return fc;
}

function drawRoute({ fit = false } = {}) {
  if (!S.map || !S.map.getSource('route')) return;
  const stops = S.route.stops;
  S.map.getSource('route').setData(routeFC(stops));

  S.edgeMarkers.forEach(m => m.remove());
  S.edgeMarkers = [];
  if (stops.length) {
    S.edgeMarkers.push(pinMarker(stops[0], '출발 · ' + stops[0].name, ''));
    if (stops.length > 1) {
      const last = stops.at(-1);
      S.edgeMarkers.push(pinMarker(last, '골인 · ' + last.name, 'finish'));
    }
  }
  if (fit && stops.length) fitToStops(stops);
}

function pinMarker(stop, label, cls) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="pin ${cls}"><i></i>${escapeHtml(label)}</div>`;
  return new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([stop.lng, stop.lat]).addTo(S.map);
}

function fitToStops(stops) {
  const b = new maplibregl.LngLatBounds();
  stops.forEach(s => b.extend([s.lng, s.lat]));
  const narrow = innerWidth < 768;
  S.map.fitBounds(b, {
    padding: narrow ? { top: 80, bottom: 200, left: 30, right: 30 }
                    : { top: 110, bottom: 90, left: 80, right: 400 },
    duration: 600,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ───────────────────────── 패널 ───────────────────────── */

function renderPanel() {
  const stops = S.route.stops;
  const list = $('list');
  const cum = cumulativeDistances(stops);
  const total = cum.at(-1) || 0;

  $('stat-km').innerHTML = `${fmtKm(total)}<small>km</small>`;
  $('stat-n').textContent = stops.length;
  $('stat-time').innerHTML = `${Math.round(total / PACE_KMH * 60)}<small>분</small>`;
  $('route-name').value = S.route.name;

  if (!stops.length) {
    list.innerHTML = `<div class="empty">${S.viewer ? '표시할 정류장이 없습니다.'
      : '지도에서 정류장을 클릭하거나<br><b>거점 찍기</b>로 코스를 만들어보세요.'}</div>`;
    return;
  }

  list.innerHTML = stops.map((s, i) => {
    const edge = i === 0 || i === stops.length - 1 ? ' edge' : '';
    const badge = i === 0 ? '출' : (i === stops.length - 1 ? '골' : i + 1);
    return `<div class="item${edge}" draggable="${!S.viewer}" data-i="${i}">
      ${S.viewer ? '' : '<span class="grip">⠿</span>'}
      <span class="num">${badge}</span>
      <span class="nm" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
      <span class="seg">${fmtKm(cum[i])}km</span>
      ${S.viewer ? '' : `<button class="x" data-del="${i}" title="제거">✕</button>`}
    </div>`;
  }).join('');
}

function bindPanelEvents() {
  const list = $('list');

  list.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    S.route.stops.splice(Number(del.dataset.del), 1);
    renderPanel(); drawRoute();
  });

  // 드래그로 순서 변경
  let from = null;
  list.addEventListener('dragstart', e => {
    const item = e.target.closest('.item');
    if (!item) return;
    from = Number(item.dataset.i);
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    const item = e.target.closest('.item');
    list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (item) item.classList.add('drop-target');
  });
  list.addEventListener('drop', e => {
    e.preventDefault();
    const item = e.target.closest('.item');
    list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (!item || from === null) return;
    const to = Number(item.dataset.i);
    const [moved] = S.route.stops.splice(from, 1);
    S.route.stops.splice(to, 0, moved);
    from = null;
    renderPanel(); drawRoute();
  });
  list.addEventListener('dragend', () => {
    list.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    from = null;
  });

  $('route-name').addEventListener('input', e => { S.route.name = e.target.value; });
}

function toggleStop(id) {
  const i = S.route.stops.findIndex(s => s.id === id);
  if (i >= 0) {
    S.route.stops.splice(i, 1);
  } else {
    const s = S.byId.get(id);
    if (!s) return;
    S.route.stops.push({ id: s.id, name: s.name, lat: s.lat, lng: s.lng });
  }
  renderPanel(); drawRoute();
}

/* ───────────────────────── 검색 ───────────────────────── */

function bindSearch() {
  const input = $('search'), box = $('results');
  let hits = [], sel = -1;

  const close = () => { box.classList.remove('open'); sel = -1; };

  const render = () => {
    if (!hits.length) return close();
    box.innerHTML = hits.map((s, i) =>
      `<div class="result${i === sel ? ' sel' : ''}" data-id="${s.id}">
         <span class="name">${escapeHtml(s.name)}</span><span class="city">${escapeHtml(s.city)}</span>
       </div>`).join('');
    box.classList.add('open');
  };

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) return close();
    const pool = S.region ? S.stops.filter(s => s.city === S.region) : S.stops;
    hits = [];
    for (const s of pool) {
      if (s.name.toLowerCase().includes(q)) { hits.push(s); if (hits.length >= 20) break; }
    }
    sel = -1;
    render();
  });

  input.addEventListener('keydown', e => {
    if (!box.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, hits.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(hits[Math.max(sel, 0)]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });

  box.addEventListener('click', e => {
    const row = e.target.closest('[data-id]');
    if (row) pick(S.byId.get(row.dataset.id));
  });

  function pick(s) {
    if (!s) return;
    S.map.easeTo({ center: [s.lng, s.lat], zoom: Math.max(S.map.getZoom(), 15) });
    if (!S.viewer) { toggleStop(s.id); toast(`${s.name} 추가됨`); }
    input.value = ''; close();
  }

  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); input.focus(); }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) close();
  });
}

/* ───────────────────────── 거점 자동 채우기 ───────────────────────── */

function setComposing(on) {
  S.composing = on;
  $('compose').classList.toggle('open', on);
  $('tool-compose').classList.toggle('on', on);
  S.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  if (!on) clearWaypoints();
}

function addWaypoint(lngLat) {
  S.waypoints.push({ lat: lngLat.lat, lng: lngLat.lng });
  drawWaypoints();
  recomputePreview();
}

function clearWaypoints() {
  S.waypoints = []; S.candidates = []; S.preview = [];
  drawWaypoints(); drawPreview(); updateComposeUI();
}

function drawWaypoints() {
  S.wpMarkers.forEach(m => m.remove());
  S.wpMarkers = S.waypoints.map((w, i) => {
    const el = document.createElement('div');
    el.className = 'wp-pin';
    el.textContent = i + 1;
    return new maplibregl.Marker({ element: el }).setLngLat([w.lng, w.lat]).addTo(S.map);
  });
}

function recomputePreview() {
  const pool = S.region ? S.stops.filter(s => s.city === S.region) : S.stops;
  S.candidates = corridorCandidates(pool, S.waypoints, 160);
  applyGap();
}

function applyGap() {
  const gap = Number($('gap').value);
  $('gap-out').textContent = gap + 'm';
  S.preview = thin(S.candidates, gap);
  drawPreview();
  updateComposeUI();
}

function drawPreview() {
  if (!S.map || !S.map.getSource('preview')) return;
  const fc = emptyFC();
  if (S.waypoints.length > 1) {
    fc.features.push({
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: S.waypoints.map(w => [w.lng, w.lat]) },
    });
  }
  S.preview.forEach(s => fc.features.push({
    type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
  }));
  S.map.getSource('preview').setData(fc);
}

function updateComposeUI() {
  const n = S.preview.length;
  const km = totalDistance(S.preview);
  $('btn-wp-apply').disabled = n === 0;
  $('compose-status').textContent = S.waypoints.length < 2
    ? '지도를 클릭해 출발 → 경유 → 도착 순으로 찍으세요 (2개 이상)'
    : `거점 ${S.waypoints.length}개 · 정류장 ${n}개 · ${fmtKm(km)}km — 거점을 더 찍으면 도로를 더 잘 따라갑니다`;
}

function applyWaypoints() {
  if (!S.preview.length) return;
  S.route.stops = S.preview.map(s => ({ ...s }));
  renderPanel(); drawRoute({ fit: true });
  toast(`정류장 ${S.preview.length}개를 노선에 넣었습니다`);
  setComposing(false);
}

/* ───────────────────────── 저장 / 불러오기 ───────────────────────── */

function refreshRouteSelect() {
  const sel = $('route-select');
  sel.innerHTML = '<option value="">새 노선</option>';
  S.store.routes.forEach(r => sel.add(new Option(`${r.name} (${r.stops.length})`, r.id)));
  sel.value = S.route.id || '';
}

function loadRoute(id) {
  if (!id) { newBlankRoute(); return; }
  const r = S.store.routes.find(x => x.id === id);
  if (!r) return;
  S.route = { id: r.id, name: r.name, region: r.region, stops: r.stops.map(s => ({ ...s })) };
  renderPanel(); drawRoute({ fit: true }); refreshRouteSelect();
}

function newBlankRoute() {
  S.route = { id: null, name: '새 노선', region: S.region || null, stops: [] };
  renderPanel(); drawRoute(); refreshRouteSelect();
}

function saveRoute() {
  if (!S.route.stops.length) return toast('정류장을 먼저 추가하세요');
  const name = uniqueName(S.store, ($('route-name').value || '새 노선').trim(), S.route.id);
  const route = S.route.id
    ? { ...S.route, name, stops: S.route.stops, region: S.region || S.route.region }
    : newRoute(name, S.region || null, S.route.stops);
  upsertRoute(S.store, route);
  try {
    saveToBrowser(S.store);
  } catch {
    return toast('저장 공간이 부족합니다. 노선을 내보낸 뒤 일부를 지워주세요');
  }
  S.route.id = route.id; S.route.name = name;
  refreshRouteSelect(); renderPanel();
  toast(`"${name}" 저장됨`);
}

function deleteRoute() {
  if (!S.route.id) return toast('저장된 노선이 아닙니다');
  if (!confirm(`"${S.route.name}" 노선을 삭제할까요?`)) return;
  removeRoute(S.store, S.route.id);
  saveToBrowser(S.store);
  newBlankRoute();
  toast('삭제되었습니다');
}

function exportRoutes() {
  if (!S.store.routes.length) return toast('저장된 노선이 없습니다');
  const now = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const url = URL.createObjectURL(new Blob([serializeStore(S.store)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = `marathon-routes-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`노선 ${S.store.routes.length}개를 파일로 내보냈습니다`);
}

function importRoutes(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const incoming = parseStore(e.target.result).routes;
    if (!incoming.length) return toast('불러올 노선이 없습니다');
    let added = 0, updated = 0;
    incoming.forEach(r => {
      if (!r.id) r.id = `route-${Date.now()}-${added}`;
      const exists = S.store.routes.some(x => x.id === r.id);
      upsertRoute(S.store, r);
      exists ? updated++ : added++;
    });
    saveToBrowser(S.store);
    refreshRouteSelect();
    toast(`${added}개 추가, ${updated}개 갱신되었습니다`);
  };
  reader.readAsText(file);
}

/* ───────────────────────── 공유 / 뷰어 ───────────────────────── */

async function shareLink() {
  if (!S.route.stops.length) return toast('정류장을 먼저 추가하세요');
  const token = await encodeRoute({ name: $('route-name').value || S.route.name, stops: S.route.stops });
  const url = `${location.origin}${location.pathname}?r=${token}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(`공유 링크를 복사했습니다 (${url.length}자)`);
  } catch {
    prompt('아래 링크를 복사하세요', url);
  }
}

async function bootRouteFromUrl() {
  const params = new URLSearchParams(location.search);
  const token = params.get('r');
  const slug = params.get('w');
  if (!token && !slug) return;

  let name = '', ids = [], stops = null;
  if (token) {
    const decoded = await decodeRoute(token);
    if (!decoded) return toast('공유 링크를 읽을 수 없습니다');
    ({ name, ids } = decoded);
  } else {
    try {
      const pub = await fetch(`published/${slug}.json`).then(r => r.json());
      name = pub.name || slug;
      if (Array.isArray(pub.stops)) stops = pub.stops;
      else ids = pub.ids || [];
    } catch {
      return toast(`"${slug}" 노선을 찾을 수 없습니다`);
    }
  }

  let missing = [];
  if (!stops) ({ stops, missing } = resolveIds(ids, S.byId));

  enterViewerMode();
  S.route = { id: null, name, region: null, stops };
  renderPanel(); drawRoute({ fit: true });
  if (missing.length) toast(`정류장 ${missing.length}개는 현재 데이터에 없어 건너뛰었습니다`, 4000);
}

function enterViewerMode() {
  S.viewer = true;
  document.body.classList.add('viewer');
  $('route-name').readOnly = true;
  $('btn-copy-mine').style.display = '';
}

function copyToMine() {
  const name = uniqueName(S.store, S.route.name || '공유받은 노선');
  const route = newRoute(name, null, S.route.stops);
  upsertRoute(S.store, route);
  saveToBrowser(S.store);
  toast(`"${name}"을 내 노선으로 저장했습니다. 편집하려면 주소에서 ?r=... 을 지우세요`, 4000);
}

/* ───────────────────────── 인쇄 ───────────────────────── */

function printRoute() {
  if (!S.route.stops.length) return toast('정류장을 먼저 추가하세요');
  const img = S.map.getCanvas().toDataURL('image/png');
  const stops = S.route.stops;
  const cum = cumulativeDistances(stops);
  const rows = stops.map((s, i) =>
    `<tr><td>${i + 1}</td><td>${escapeHtml(s.name)}</td><td>${fmtKm(cum[i])} km</td></tr>`).join('');
  const w = open('', '_blank');
  w.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
    <title>${escapeHtml(S.route.name)}</title>
    <style>
      body { font-family: -apple-system, "Apple SD Gothic Neo", sans-serif; padding: 28px; color: #191f28; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      .meta { color: #6b7684; font-size: 12px; margin-bottom: 16px; }
      img { width: 100%; border: 1px solid #e5e8eb; border-radius: 8px; }
      table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 12px; }
      th, td { border-bottom: 1px solid #e5e8eb; padding: 7px 8px; text-align: center; }
      th { background: #f2f4f6; }
      td:nth-child(2) { text-align: left; }
      @media print { body { padding: 0; } }
    </style></head><body>
    <h1>${escapeHtml(S.route.name)}</h1>
    <div class="meta">정류장 ${stops.length}개 · 총 ${fmtKm(cum.at(-1) || 0)}km (직선 거리 기준) ·
      ${new Date().toLocaleDateString('ko-KR')}</div>
    <img src="${img}">
    <table><thead><tr><th>순번</th><th>정류장</th><th>누적 거리</th></tr></thead><tbody>${rows}</tbody></table>
    </body></html>`);
  w.document.close();
  w.onload = () => w.print();
}

/* ───────────────────────── 모바일 바텀시트 ───────────────────────── */

function bindSheet() {
  const panel = $('panel');
  const states = ['', 'half', 'full'];
  let idx = 0;
  $('panel').querySelector('.panel-head').addEventListener('click', e => {
    if (innerWidth >= 768) return;
    if (e.target.closest('input, select, button')) return;
    idx = (idx + 1) % states.length;
    panel.classList.remove('half', 'full');
    if (states[idx]) panel.classList.add(states[idx]);
  });
}

/* ───────────────────────── 시작 ───────────────────────── */

function bindUI() {
  $('theme-btn').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  $('region').addEventListener('change', e => {
    S.region = e.target.value;
    $('region-chip').classList.toggle('active', !!S.region);
    if (S.map.getSource('stops')) S.map.getSource('stops').setData(stopsFeatureCollection());
    if (S.composing) recomputePreview();
  });

  $('route-select').addEventListener('change', e => loadRoute(e.target.value));
  $('btn-save').addEventListener('click', saveRoute);
  $('btn-export').addEventListener('click', exportRoutes);
  $('btn-share').addEventListener('click', shareLink);
  $('btn-copy-mine').addEventListener('click', copyToMine);

  $('tool-compose').addEventListener('click', () => setComposing(!S.composing));
  $('tool-new').addEventListener('click', newBlankRoute);
  $('tool-delete').addEventListener('click', deleteRoute);
  $('tool-print').addEventListener('click', printRoute);
  $('tool-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importRoutes(e.target.files[0]);
    e.target.value = '';
  });

  $('gap').addEventListener('input', applyGap);
  $('btn-wp-apply').addEventListener('click', applyWaypoints);
  $('btn-wp-clear').addEventListener('click', clearWaypoints);
  $('btn-wp-undo').addEventListener('click', () => {
    S.waypoints.pop(); drawWaypoints(); recomputePreview();
  });

  bindPanelEvents(); bindSearch(); bindSheet();
}

async function main() {
  applyTheme(currentTheme(), { redraw: false });
  try {
    await loadStops();
  } catch (err) {
    $('loading-msg').textContent = err.message + ' — 로컬 서버로 열었는지 확인해주세요.';
    return;
  }
  $('loading-msg').textContent = '지도를 준비하는 중…';
  S.store = loadFromBrowser();
  initMap();
  bindUI();
  refreshRouteSelect();
  renderPanel();
  window.__app = S;   // 스모크 테스트용
}

main();
