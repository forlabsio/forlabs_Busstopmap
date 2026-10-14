// 마라톤 노선 관리 — 앱 로직
import { haversine, totalDistance, cumulativeDistances, corridorCandidates, thin, bestInsertIndex } from './geo.js';
import { encodeRoute, decodeRoute, resolveIds } from './share.js';
import {
  parseStore, serializeStore, upsertRoute, removeRoute, uniqueName, newRoute,
  loadFromBrowser, saveToBrowser, STORAGE_KEY,
  ROUTE_COLORS, colorOf, nextColor, renameRoute, setRouteColor,
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
  route: { id: null, name: '새 노선', region: null, color: ROUTE_COLORS[0], stops: [] },
  waypoints: [],
  candidates: [],         // 거점 모드 미리보기 후보
  preview: [],
  composing: false,
  viewer: false,
  region: '',
  wpMarkers: [],
  edgeMarkers: [],
  pickers: {},
  dataReady: null,         // 정류장 데이터 로딩 Promise
  overlay: false,          // 전체 노선 보기
  overlayHidden: new Set(), // 전체 보기에서 꺼둔 노선 id
  insertAfter: null,      // n번 뒤에 넣기로 지정한 위치 (null이면 자동)
};

/** 공유 링크로 열렸는가. 이 경우 정류장 6만 개를 지도에 올릴 필요가 없다. */
const VIEWER_INTENT = (() => {
  const q = new URLSearchParams(location.search);
  return q.has('r') || q.has('w');
})();

const $ = id => document.getElementById(id);
const fmtKm = km => (km < 10 ? km.toFixed(2) : km.toFixed(1));

/* 편집 되돌리기 — 노선을 바꾸기 "전에" 스냅샷을 남긴다 */
const undoStack = [];

function snapshot(label) {
  queueMicrotask(updateUndoButton);
  undoStack.push({
    label,
    name: S.route.name,
    id: S.route.id,
    stops: S.route.stops.map(s => ({ ...s })),
  });
  if (undoStack.length > 30) undoStack.shift();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) return toast('되돌릴 작업이 없습니다');
  S.route.id = prev.id;
  S.route.name = prev.name;
  S.route.stops = prev.stops;
  renderPanel();
  drawRoute({ fit: true });
  refreshRouteSelect();
  toast(`실행 취소: ${prev.label}`);
}

/** 편집 중인 노선이 저장본과 다른지 표시한다 */
function updateUndoButton() {
  const btn = $('tool-undo');
  if (btn) btn.hidden = S.viewer || undoStack.length === 0;
}

function updateDirty() {
  updateUndoButton();
  const el = $('dirty');
  if (!el) return;
  const saved = S.route.id && S.store.routes.find(r => r.id === S.route.id);
  const dirty = S.route.stops.length > 0 &&
    (!saved || JSON.stringify(saved.stops) !== JSON.stringify(S.route.stops) || saved.name !== S.route.name);
  el.hidden = S.viewer || !dirty;
}

function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ───────────────────────── 셀렉트 컴포넌트 ───────────────────────── */

/**
 * OS 기본 select 대신 쓰는 드롭다운.
 * items: [{ value, label, meta?, divider? }]
 */
function createSelect(host, { onChange, placeholder = '선택' } = {}) {
  let items = [], value = null, active = -1;

  host.innerHTML = `
    <button type="button" class="select-trigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="select-label">${placeholder}</span>
      <svg class="select-caret" width="11" height="11" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="3"><path d="M5 9l7 7 7-7"/></svg>
    </button>
    <div class="select-menu" role="listbox" hidden></div>`;

  const trigger = host.querySelector('.select-trigger');
  const label = host.querySelector('.select-label');
  const menu = host.querySelector('.select-menu');

  const isOpen = () => !menu.hidden;

  function renderMenu() {
    menu.innerHTML = items.map((it, i) => it.divider
      ? '<div class="select-divider"></div>'
      : `<div class="select-option" role="option" data-i="${i}"
              aria-selected="${it.value === value}">
           ${it.color ? `<span class="opt-dot" style="background:${it.color}"></span>`
                      : '<span class="opt-check">✓</span>'}
           <span class="opt-name">${escapeHtml(it.label)}</span>
           ${it.meta ? `<span class="opt-meta">${escapeHtml(it.meta)}</span>` : ''}
         </div>`).join('');
  }

  function renderLabel() {
    const cur = items.find(it => it.value === value);
    label.textContent = cur ? cur.label : placeholder;
  }

  function open() {
    if (isOpen()) return;
    renderMenu();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    active = items.findIndex(it => it.value === value);
    highlight();
    const sel = menu.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function close() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    active = -1;
  }

  function highlight() {
    menu.querySelectorAll('.select-option').forEach(el =>
      el.classList.toggle('is-active', Number(el.dataset.i) === active));
    const el = menu.querySelector('.is-active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function move(step) {
    const picks = items.map((it, i) => (it.divider ? -1 : i)).filter(i => i >= 0);
    if (!picks.length) return;
    const pos = picks.indexOf(active);
    active = picks[(pos + step + picks.length) % picks.length] ?? picks[0];
    highlight();
  }

  function choose(i) {
    const it = items[i];
    if (!it || it.divider) return;
    value = it.value;
    renderLabel();
    close();
    onChange?.(value, it);
  }

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  menu.addEventListener('click', e => {
    const el = e.target.closest('.select-option');
    if (el) choose(Number(el.dataset.i));
  });
  menu.addEventListener('mousemove', e => {
    const el = e.target.closest('.select-option');
    if (el && Number(el.dataset.i) !== active) { active = Number(el.dataset.i); highlight(); }
  });
  trigger.addEventListener('keydown', e => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      if (!isOpen()) return open();
      if (e.key === 'Enter' || e.key === ' ') return choose(active);
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  document.addEventListener('click', e => { if (!host.contains(e.target)) close(); });

  return {
    setItems(next, keepValue = true) {
      items = next;
      if (!keepValue || !items.some(it => it.value === value)) value = items[0]?.value ?? null;
      renderLabel();
      if (isOpen()) renderMenu();
    },
    setValue(v) { value = v; renderLabel(); if (isOpen()) renderMenu(); },
    getValue: () => value,
    close,
  };
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

  const btn = $('theme-btn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(mode === 'dark'));
    btn.title = mode === 'dark' ? '밝은 테마로 전환' : '어두운 테마로 전환';
  }
  if (redraw && S.map) {
    S.map.setStyle(BASEMAP[mode]);
    S.map.once('styledata', () => { installLayers(); drawRoute(); drawPreview(); drawAllRoutes(); });
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
  performance.mark('stops-loaded');
  S.stops = rows.map(([id, name, lat, lng, city]) => ({ id, name, lat, lng, city }));
  S.byId = new Map(S.stops.map(s => [s.id, s]));

  const counts = new Map();
  S.stops.forEach(s => counts.set(s.city, (counts.get(s.city) || 0) + 1));
  const regions = [...counts.keys()].sort();
  S.pickers.region.setItems([
    { value: '', label: '전국', meta: S.stops.length.toLocaleString() },
    { divider: true },
    ...regions.map(r => ({ value: r, label: r, meta: counts.get(r).toLocaleString() })),
  ]);
}

/** 6만 개 피처를 만드는 일은 지도가 그려진 뒤 한가할 때 한다 */
function populateStopLayer() {
  if (VIEWER_INTENT || !S.map || !S.map.getSource('stops') || !S.stops.length) return;
  const run = () => S.map.getSource('stops').setData(stopsFeatureCollection());
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 0);
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

  // 정류장 (클러스터) — 공유 링크 보기에서는 만들지 않는다
  if (!VIEWER_INTENT) {
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
  }

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

  // 전체 노선 보기 (편집 중인 노선 아래에 깔린다)
  S.map.addSource('routes-all', { type: 'geojson', data: emptyFC() });
  S.map.addLayer({
    id: 'all-casing', type: 'line', source: 'routes-all',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': c('--canvas'), 'line-width': 7, 'line-opacity': .85 },
  });
  S.map.addLayer({
    id: 'all-line', type: 'line', source: 'routes-all',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': .95 },
  });
  S.map.addLayer({
    id: 'all-label', type: 'symbol', source: 'routes-all', minzoom: 10,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Open Sans Bold'], 'text-size': 11,
      'symbol-placement': 'line-center', 'text-padding': 4,
    },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': c('--canvas'), 'text-halo-width': 2 },
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
    paint: { 'line-color': currentColor(), 'line-width': 5 },
  });
  S.map.addLayer({
    id: 'route-dots', type: 'circle', source: 'route',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      // 순번이 들어가야 하므로 확대할수록 원을 키운다
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4.5, 13, 7, 16, 11],
      'circle-color': ['case', ['get', 'edge'], currentColor(), c('--canvas')],
      'circle-stroke-width': 2.5, 'circle-stroke-color': currentColor(),
    },
  });
  S.map.addLayer({
    id: 'route-numbers', type: 'symbol', source: 'route', minzoom: 11.5,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: {
      'text-field': ['to-string', ['get', 'n']],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 8.5, 14, 10, 16, 12],
      // 멀리서는 겹치면 숨기고, 작업하려고 확대하면 모두 보여준다
      'text-allow-overlap': ['step', ['zoom'], false, 14.5, true],
      'text-ignore-placement': ['step', ['zoom'], false, 14.5, true],
      'text-padding': 1,
    },
    paint: {
      'text-color': ['case', ['get', 'edge'], '#ffffff', currentColor()],
      'text-halo-color': ['case', ['get', 'edge'], currentColor(), c('--canvas')],
      'text-halo-width': 1,
    },
  });
}

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

const currentColor = () => S.route.color || colorOf(S.route);

/** 색을 바꾸면 편집 중 노선의 레이어 색도 즉시 따라간다 */
function repaintRoute() {
  if (!S.map || !S.map.getLayer('route-line')) return;
  const col = currentColor();
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
  S.map.setPaintProperty('route-line', 'line-color', col);
  S.map.setPaintProperty('route-dots', 'circle-color', ['case', ['get', 'edge'], col, canvas]);
  S.map.setPaintProperty('route-dots', 'circle-stroke-color', col);
  S.map.setPaintProperty('route-numbers', 'text-color', ['case', ['get', 'edge'], '#ffffff', col]);
  S.map.setPaintProperty('route-numbers', 'text-halo-color', ['case', ['get', 'edge'], col, canvas]);
  const dot = $('color-dot') || $('color-btn');
  if (dot) dot.style.background = col;
}

/** 전체 보기에서 켜져 있는 노선들 (편집 중인 것은 위에 따로 그린다) */
function visibleRoutes() {
  return S.store.routes.filter(r => !S.overlayHidden.has(r.id) && r.id !== S.route.id && r.stops.length > 1);
}

function drawAllRoutes() {
  if (!S.map || !S.map.getSource('routes-all')) return;
  const fc = emptyFC();
  if (S.overlay) {
    for (const r of visibleRoutes()) {
      fc.features.push({
        type: 'Feature',
        properties: { name: r.name, color: colorOf(r) },
        geometry: { type: 'LineString', coordinates: r.stops.map(s => [s.lng, s.lat]) },
      });
    }
  }
  S.map.getSource('routes-all').setData(fc);
}

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
    performance.mark('map-ready');
    $('loading').hidden = true;
    populateStopLayer();

    S.map.on('click', 'clusters', e => {
      if (S.composing) return;        // 코스 자동 만들기 중에는 확대 대신 지점을 찍는다
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
  stops.forEach((s, i) => fc.features.push({
    type: 'Feature',
    properties: { id: s.id, n: i + 1, edge: i === 0 || i === stops.length - 1 },
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
  $('route-title').textContent = S.route.name;
  if ($('route-name').hidden) $('route-name').value = S.route.name;
  updateDirty();
  updateDeleteButton();
  syncPalette();
  queueMicrotask(syncPeekHeight);

  if (!stops.length) {
    list.innerHTML = S.viewer
      ? '<div class="empty">표시할 정류장이 없습니다.</div>'
      : `<div class="empty">
           지도에서 정류장을 클릭하거나<br>아래 버튼으로 시작해보세요.
           <button class="btn" id="empty-compose" style="margin-top:16px">✨ 코스 자동 만들기</button>
         </div>`;
    const quick = $('empty-compose');
    if (quick) quick.addEventListener('click', () => setComposing(true));
    return;
  }

  list.innerHTML = stops.map((s, i) => {
    const isFirst = i === 0, isLast = i === stops.length - 1;
    const edge = isFirst || isLast ? ' edge' : '';
    const tag = isFirst ? '<span class="edge-tag">출발</span>'
              : (isLast && stops.length > 1 ? '<span class="edge-tag">골인</span>' : '');
    const pinned = S.insertAfter === i ? ' insert-target' : '';
    return `<div class="item${edge}${pinned}" draggable="${!S.viewer}" data-i="${i}">
      ${S.viewer ? '' : '<span class="grip">⠿</span>'}
      <span class="num">${i + 1}</span>
      <span class="nm" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>${tag}
      <span class="seg">${fmtKm(cum[i])}km</span>
      ${S.viewer ? '' : `<button class="ins" data-ins="${i}" title="이 뒤에 정류장 넣기">⊕</button>
      <button class="x" data-del="${i}" title="제거">✕</button>`}
    </div>`;
  }).join('');
}

function bindPanelEvents() {
  const list = $('list');

  list.addEventListener('click', e => {
    const ins = e.target.closest('[data-ins]');
    if (ins) {
      const i = Number(ins.dataset.ins);
      S.insertAfter === i ? clearInsertPoint() : setInsertPoint(i);
      return;
    }
    const del = e.target.closest('[data-del]');
    if (!del) return;
    snapshot('정류장 제거');
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
    snapshot('순서 변경');
    const [moved] = S.route.stops.splice(from, 1);
    S.route.stops.splice(to, 0, moved);
    from = null;
    renderPanel(); drawRoute();
  });
  list.addEventListener('dragend', () => {
    list.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    from = null;
  });


}

function toggleStop(id) {
  const i = S.route.stops.findIndex(s => s.id === id);

  if (i >= 0) {
    snapshot('정류장 제거');
    S.route.stops.splice(i, 1);
    renderPanel(); drawRoute();
    return;
  }

  const stop = S.byId.get(id);
  if (!stop) return;
  const entry = { id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng };

  snapshot('정류장 추가');
  const pinned = S.insertAfter !== null;
  const at = pinned ? S.insertAfter + 1 : bestInsertIndex(S.route.stops, entry);
  S.route.stops.splice(at, 0, entry);
  clearInsertPoint();

  renderPanel(); drawRoute();

  if (at === S.route.stops.length - 1) {
    toast(`${stop.name} 맨 뒤에 추가`);
  } else {
    toast(`${stop.name} → ${at}번과 ${at + 1}번 사이에 넣었습니다 (⌘Z로 취소)`, 3000);
  }
}

/** 목록에서 "이 뒤에 넣기"를 눌러 위치를 고정한다 */
function setInsertPoint(index) {
  S.insertAfter = index;
  renderPanel();
  toast(`다음에 고르는 정류장을 ${index + 1}번 뒤에 넣습니다 — Esc로 취소`, 4000);
}

function clearInsertPoint() {
  if (S.insertAfter === null) return;
  S.insertAfter = null;
  renderPanel();
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

  input.addEventListener('focus', ensureStops);
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) return close();
    if (!S.stops.length) { ensureStops(); return close(); }
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
  $('compose').hidden = !on;
  $('list').hidden = on || S.overlay;
  $('routes-list').hidden = on || !S.overlay;
  $('foot-default').hidden = on;
  $('foot-compose').hidden = !on;
  $('tool-compose').querySelector('span').textContent = on ? '자동 만들기 끝내기' : '코스 자동 만들기';
  S.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  if (on && innerWidth < 768) setSheet('half');   // 슬라이더가 보이게
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
  const had = S.route.stops.length;
  $('btn-wp-apply').disabled = n === 0;
  $('btn-wp-apply').textContent = had ? '기존 노선 교체' : '이대로 확정';
  $('btn-wp-append').hidden = !had;
  $('btn-wp-append').disabled = n === 0;
  $('compose-status').textContent = S.waypoints.length < 2
    ? '출발 → 경유 → 도착 순으로 2곳 이상 찍으면 사이 정류장이 자동으로 채워집니다.'
    : `지점 ${S.waypoints.length}개 · 정류장 ${n}개 · ${fmtKm(km)}km — 지점을 더 찍을수록 실제 도로를 잘 따라갑니다.`;
}

function applyWaypoints({ append = false } = {}) {
  if (!S.preview.length) return;
  const had = S.route.stops.length;

  if (!append && had) {
    const ok = confirm(
      `지금 노선의 정류장 ${had}개를 새로 찾은 ${S.preview.length}개로 바꿉니다.\n\n` +
      `저장된 노선은 그대로 남고, 되돌리기(⌘Z)도 됩니다.\n계속할까요?`);
    if (!ok) return;
  }

  snapshot(append ? '자동 코스 이어 붙이기' : '자동 코스로 교체');
  S.route.stops = append
    ? S.route.stops.concat(S.preview.map(s => ({ ...s })))
    : S.preview.map(s => ({ ...s }));

  renderPanel(); drawRoute({ fit: true });
  toast(append
    ? `정류장 ${S.preview.length}개를 뒤에 이어 붙였습니다 (⌘Z로 되돌리기)`
    : `정류장 ${S.preview.length}개로 바꿨습니다 (⌘Z로 되돌리기)`, 3200);
  setComposing(false);
}

/* ───────────────────────── 저장 / 불러오기 ───────────────────────── */

function refreshRouteSelect() {
  const items = [{ value: '', label: '새 노선' }];
  if (S.store.routes.length) items.push({ divider: true });
  S.store.routes.forEach(r =>
    items.push({ value: r.id, label: r.name, meta: `${r.stops.length}개`, color: colorOf(r) }));
  S.pickers.route.setItems(items, false);
  S.pickers.route.setValue(S.route.id || '');
}

function loadRoute(id) {
  if (!id) { newBlankRoute(); return; }
  const r = S.store.routes.find(x => x.id === id);
  if (!r) return;
  snapshot('다른 노선 불러오기');
  S.route = {
    id: r.id, name: r.name, region: r.region, color: colorOf(r),
    stops: r.stops.map(s => ({ ...s })),
  };
  renderPanel(); repaintRoute(); drawRoute({ fit: true }); refreshRouteSelect();
  if (S.overlay) { renderRoutesList(); drawAllRoutes(); }
}

function newBlankRoute() {
  if (S.route.stops.length) snapshot('새 노선 시작');
  S.route = {
    id: null, name: '새 노선', region: S.region || null,
    color: nextColor(S.store), stops: [],
  };
  renderPanel(); repaintRoute(); drawRoute(); refreshRouteSelect();
  if (S.overlay) { renderRoutesList(); drawAllRoutes(); }
}

function saveRoute() {
  if (!S.route.stops.length) return toast('정류장을 먼저 추가하세요');
  const name = uniqueName(S.store, (S.route.name || '새 노선').trim(), S.route.id);
  const route = S.route.id
    ? { ...S.route, name, stops: S.route.stops, region: S.region || S.route.region,
        color: currentColor() }
    : newRoute(name, S.region || null, S.route.stops, currentColor());
  upsertRoute(S.store, route);
  try {
    saveToBrowser(S.store);
  } catch {
    return toast('저장 공간이 부족합니다. 노선을 내보낸 뒤 일부를 지워주세요');
  }
  S.route.id = route.id; S.route.name = name;
  refreshRouteSelect(); renderPanel();
  if (S.overlay) { renderRoutesList(); drawAllRoutes(); }
  toast(`"${name}" 저장됨`);
}

function deleteRoute() {
  if (!S.route.id) return toast('저장된 노선을 먼저 불러오세요');
  const target = S.store.routes.find(r => r.id === S.route.id);
  const count = target ? target.stops.length : S.route.stops.length;
  const ok = confirm(
    `저장된 노선 "${S.route.name}"(정류장 ${count}개)을 지웁니다.\n\n` +
    `되돌릴 수 없습니다. 필요하면 먼저 "내보내기"로 백업하세요.`);
  if (!ok) return;
  removeRoute(S.store, S.route.id);
  saveToBrowser(S.store);
  newBlankRoute();
  toast('저장된 노선을 삭제했습니다');
}

/** 지울 저장 노선이 없으면 삭제 버튼을 비활성화한다 */
function updateDeleteButton() {
  const btn = $('tool-delete');
  if (btn) btn.disabled = !S.route.id;
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
  const token = await encodeRoute({ name: S.route.name, stops: S.route.stops });
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

  let name = '', ids = [], coords = null, names = null, stops = null;

  if (token) {
    const decoded = await decodeRoute(token);
    if (!decoded) return toast('공유 링크를 읽을 수 없습니다');
    ({ name, ids, coords, names } = decoded);
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

  enterViewerMode();

  if (!stops && coords) {
    // 좌표가 링크에 들어 있다 -> 정류장 데이터를 기다리지 않고 바로 그린다
    stops = ids.map((id, i) => ({
      id, lat: coords[i].lat, lng: coords[i].lng,
      name: (names && names[i]) || `정류장 ${i + 1}`,
    }));
    S.route = { id: null, name, region: null, color: S.route.color, stops };
    renderPanel(); drawRoute({ fit: true });

    if (!names) fillNamesWhenReady(ids);       // 이름만 나중에 채운다
    return;
  }

  // 좌표가 없는 예전 링크 -> 정류장 데이터가 있어야 푼다
  if (!stops) {
    ensureStops();
    await S.dataReady;
    const resolved = resolveIds(ids, S.byId);
    stops = resolved.stops;
    if (resolved.missing.length) {
      toast(`정류장 ${resolved.missing.length}개는 현재 데이터에 없어 건너뛰었습니다`, 4000);
    }
  }

  S.route = { id: null, name, region: null, color: S.route.color, stops };
  renderPanel(); drawRoute({ fit: true });
}

/** 이름이 빠진 링크는 데이터가 오면 조용히 채운다 */
function fillNamesWhenReady(ids) {
  ensureStops();
  showDataPending(true, '정류장 이름 불러오는 중…');
  S.dataReady
    .then(() => {
      S.route.stops = S.route.stops.map((s, i) => {
        const found = S.byId.get(ids[i]);
        return found ? { ...s, name: found.name } : s;
      });
      showDataPending(false);
      renderPanel();
    })
    .catch(() => showDataPending(false));
}

function enterViewerMode() {
  S.viewer = true;
  document.body.classList.add('viewer');
  if (innerWidth < 768) setSheet('peek');
  $('rename-btn').hidden = true;
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

/* ───────────────────────── 노선 이름 ───────────────────────── */

function startRename() {
  const input = $('route-name'), title = $('route-title');
  input.value = S.route.name;
  input.hidden = false;
  title.hidden = true;
  $('rename-btn').hidden = true;
  input.focus();
  input.select();
}

function endRename({ commit = true } = {}) {
  const input = $('route-name');
  if (input.hidden) return;

  if (commit) {
    const name = input.value.trim();
    if (name && name !== S.route.name) {
      if (S.route.id) {
        const applied = renameRoute(S.store, S.route.id, name);
        if (applied) {
          S.route.name = applied;
          saveToBrowser(S.store);
          refreshRouteSelect();
          if (S.overlay) { renderRoutesList(); drawAllRoutes(); }
          toast(`이름을 "${applied}"로 바꿨습니다`);
        }
      } else {
        S.route.name = name;      // 아직 저장 전인 노선
      }
    }
  }

  input.hidden = true;
  $('route-title').hidden = false;
  $('rename-btn').hidden = S.viewer;
  renderPanel();
}

function bindRename() {
  $('rename-btn').addEventListener('click', startRename);
  $('route-title').addEventListener('click', () => { if (!S.viewer) startRename(); });
  $('route-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); endRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); endRename({ commit: false }); }
  });
  $('route-name').addEventListener('blur', () => endRename());
}

/* ───────────────────────── 전체 노선 보기 ───────────────────────── */

function setOverlay(on) {
  S.overlay = on;
  $('routes-list').hidden = !on;
  $('list').hidden = on || S.composing;
  $('tool-overlay').setAttribute('aria-pressed', String(on));
  if (on) {
    renderRoutesList();
    if (innerWidth < 768) setSheet('half');
  }
  drawAllRoutes();
}

/** 지도에 딱 한 개만 보이고 그게 편집 중인 노선이면 그 id를 돌려준다 */
function soloedRouteId() {
  const shown = S.store.routes.filter(r => !S.overlayHidden.has(r.id));
  if (shown.length !== 1) return null;
  return shown[0].id === S.route.id ? shown[0].id : null;
}

function renderRoutesList() {
  const box = $('routes-list');
  const routes = S.store.routes;

  if (!routes.length) {
    box.innerHTML = '<div class="routes-empty">저장된 노선이 없습니다.<br>노선을 만들고 저장하면 여기에 모입니다.</div>';
    return;
  }

  const soloId = soloedRouteId();
  const rows = routes.map(r => {
    const on = !S.overlayHidden.has(r.id);
    const km = totalDistance(r.stops);
    const current = r.id === S.route.id ? ' current' : '';
    const isSolo = soloId === r.id;
    return `<div class="route-row${current}" data-id="${r.id}">
      <input type="checkbox" ${on ? 'checked' : ''} data-toggle="${r.id}"
             aria-label="${escapeHtml(r.name)} 지도에 표시">
      <span class="dot" style="background:${colorOf(r)}"></span>
      <span class="rname">${escapeHtml(r.name)}</span>
      <span class="rmeta">${r.stops.length}개 · ${fmtKm(km)}km</span>
      <button class="solo${isSolo ? ' on' : ''}" data-solo="${r.id}"
              title="${isSolo ? '다시 전체 보기' : '이 노선만 보기'}">${isSolo ? '모두' : '이것만'}</button>
      <button class="rename" data-rename="${r.id}" title="이름 변경">✎</button>
    </div>`;
  }).join('');

  const shown = routes.length - S.overlayHidden.size;
  box.innerHTML = `
    <div class="routes-head">저장된 노선 ${routes.length}개 · 표시 중 ${shown}개</div>
    <div class="routes-actions">
      <button data-all="on">모두 켜기</button>
      <button data-all="off">모두 끄기</button>
      <button data-fit="1">전체 맞춤</button>
    </div>${rows}`;
}

function fitAllRoutes() {
  const bounds = new maplibregl.LngLatBounds();
  let any = false;
  const add = stops => stops.forEach(s => { bounds.extend([s.lng, s.lat]); any = true; });
  visibleRoutes().forEach(r => add(r.stops));
  if (S.route.stops.length) add(S.route.stops);
  if (!any) return toast('표시할 노선이 없습니다');
  const narrow = innerWidth < 768;
  S.map.fitBounds(bounds, {
    padding: narrow ? { top: 80, bottom: 220, left: 30, right: 30 }
                    : { top: 110, bottom: 90, left: 80, right: 400 },
    duration: 700,
  });
}

function bindRoutesList() {
  $('routes-list').addEventListener('click', e => {
    const all = e.target.closest('[data-all]');
    if (all) {
      S.overlayHidden = all.dataset.all === 'off'
        ? new Set(S.store.routes.map(r => r.id)) : new Set();
      renderRoutesList(); drawAllRoutes();
      return;
    }
    if (e.target.closest('[data-fit]')) return fitAllRoutes();

    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.dataset.toggle;
      S.overlayHidden.has(id) ? S.overlayHidden.delete(id) : S.overlayHidden.add(id);
      renderRoutesList(); drawAllRoutes();
      return;
    }

    const solo = e.target.closest('[data-solo]');
    if (solo) {
      const id = solo.dataset.solo;
      if (soloedRouteId() === id) {              // 이미 혼자 보고 있으면 전체로 되돌린다
        S.overlayHidden = new Set();
        renderRoutesList(); drawAllRoutes();
        toast('모든 노선을 표시합니다');
      } else {
        S.overlayHidden = new Set(S.store.routes.filter(r => r.id !== id).map(r => r.id));
        if (S.route.id !== id) loadRoute(id);    // 그 노선을 편집 상태로 올려 지도에 띄운다
        renderRoutesList(); drawAllRoutes();
        const route = S.store.routes.find(r => r.id === id);
        if (route) fitToStops(route.stops);
        toast(`"${route ? route.name : ''}" 만 표시합니다`);
      }
      return;
    }

    const ren = e.target.closest('[data-rename]');
    if (ren) {
      const id = ren.dataset.rename;
      const route = S.store.routes.find(r => r.id === id);
      const name = prompt('노선 이름', route.name);
      if (name === null) return;
      const applied = renameRoute(S.store, id, name);
      if (!applied) return toast('이름을 입력해주세요');
      saveToBrowser(S.store);
      if (S.route.id === id) { S.route.name = applied; renderPanel(); }
      refreshRouteSelect(); renderRoutesList(); drawAllRoutes();
      toast(`이름을 "${applied}"로 바꿨습니다`);
      return;
    }

    const row = e.target.closest('[data-id]');
    if (row) { loadRoute(row.dataset.id); renderRoutesList(); }
  });
}

function bindPalette() {
  const box = $('palette');
  box.innerHTML = ROUTE_COLORS.map(col =>
    `<button data-color="${col}" style="background:${col}" aria-label="${col}"></button>`).join('');

  $('color-btn').addEventListener('click', () => {
    box.hidden = !box.hidden;
    syncPalette();
  });

  syncPalette();

  box.addEventListener('click', e => {
    const btn = e.target.closest('[data-color]');
    if (!btn) return;
    S.route.color = btn.dataset.color;
    if (S.route.id) {                       // 저장된 노선이면 색을 바로 저장한다
      setRouteColor(S.store, S.route.id, S.route.color);
      saveToBrowser(S.store);
      if (S.overlay) renderRoutesList();
    }
    repaintRoute();
    syncPalette();
    box.hidden = true;
  });
}

function syncPalette() {
  if (!$('palette').children.length) return;
  const col = currentColor();
  $('palette').querySelectorAll('[data-color]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.color === col)));
  $('color-btn').style.background = col;
}

/* ───────────────────────── 더보기 메뉴 ───────────────────────── */

function openMenu() {
  const menu = $('menu'), btn = $('menu-btn');
  menu.hidden = false;
  $('menu-backdrop').hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  if (innerWidth >= 768) {
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 8}px`;
    menu.style.left = `${Math.max(12, r.right - menu.offsetWidth)}px`;
  } else {
    menu.style.top = menu.style.left = '';
  }
}

function closeMenu() {
  $('menu').hidden = true;
  $('menu-backdrop').hidden = true;
  $('menu-btn').setAttribute('aria-expanded', 'false');
}

const isMenuOpen = () => !$('menu').hidden;

/* ───────────────────────── 모바일 바텀시트 ───────────────────────── */

const SHEET_STATES = ['peek', 'half', 'full'];

/** 요약 상태 높이를 머리 영역 실제 높이에 맞춘다 (문구가 잘리지 않게) */
function syncPeekHeight() {
  if (innerWidth >= 768) return;
  const head = document.querySelector('.panel-head');
  const handle = $('sheet-handle');
  if (!head || !handle) return;
  const h = Math.ceil(handle.offsetHeight + head.offsetHeight) + 6;
  document.documentElement.style.setProperty('--sheet-peek', `${h}px`);
}

function setSheet(state) {
  syncPeekHeight();
  const panel = $('panel');
  panel.classList.remove('half', 'full');
  if (state !== 'peek') panel.classList.add(state);
  S.sheet = state;
}

function bindSheet() {
  const panel = $('panel');
  const handle = $('sheet-handle');
  if (!handle) return;
  S.sheet = 'peek';

  // 탭하면 단계를 올리고, 맨 위에서는 다시 내린다
  handle.addEventListener('click', () => {
    if (innerWidth >= 768) return;
    const i = SHEET_STATES.indexOf(S.sheet);
    setSheet(SHEET_STATES[(i + 1) % SHEET_STATES.length]);
  });

  // 손가락으로 끌어서 조절
  let startY = 0, startTop = 0, dragging = false;
  handle.addEventListener('pointerdown', e => {
    if (innerWidth >= 768) return;
    dragging = true; startY = e.clientY;
    startTop = panel.getBoundingClientRect().top;
    panel.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const top = Math.max(innerHeight * 0.12, startTop + (e.clientY - startY));
    panel.style.transform = `translateY(${top - (innerHeight - panel.offsetHeight)}px)`;
  });
  handle.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    const moved = e.clientY - startY;
    const i = SHEET_STATES.indexOf(S.sheet);
    if (moved < -40) setSheet(SHEET_STATES[Math.min(i + 1, 2)]);
    else if (moved > 40) setSheet(SHEET_STATES[Math.max(i - 1, 0)]);
  });
}

/* ───────────────────────── 시작 ───────────────────────── */

function bindUI() {
  $('theme-btn').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('tool-undo').addEventListener('click', undo);

  // 드롭다운은 데이터 로딩 전에 만들어 둔다 (loadStops가 바로 채운다)
  
  $('btn-save').addEventListener('click', saveRoute);
  $('btn-export').addEventListener('click', exportRoutes);
  $('btn-share').addEventListener('click', shareLink);
  $('btn-copy-mine').addEventListener('click', copyToMine);

  $('tool-compose').addEventListener('click', () => setComposing(!S.composing));

  // 더보기 메뉴
  $('menu-btn').addEventListener('click', () => (isMenuOpen() ? closeMenu() : openMenu()));
  $('menu-backdrop').addEventListener('click', closeMenu);
  $('menu').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn && btn.id !== 'theme-btn') closeMenu();   // 테마는 켠 채로 확인할 수 있게 둔다
  });
  $('tool-new').addEventListener('click', newBlankRoute);
  $('tool-overlay').addEventListener('click', () => setOverlay(!S.overlay));
  $('tool-delete').addEventListener('click', deleteRoute);
  $('tool-print').addEventListener('click', printRoute);
  $('tool-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importRoutes(e.target.files[0]);
    e.target.value = '';
  });

  $('gap').addEventListener('input', applyGap);
  $('btn-wp-apply').addEventListener('click', () => applyWaypoints({ append: false }));
  $('btn-wp-append').addEventListener('click', () => applyWaypoints({ append: true }));
  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' &&
        !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault(); undo();
    }
  });
  $('btn-wp-clear').addEventListener('click', clearWaypoints);
  $('btn-wp-undo').addEventListener('click', () => {
    S.waypoints.pop(); drawWaypoints(); recomputePreview();
  });

  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (isMenuOpen()) return closeMenu();
    clearInsertPoint();
    if (S.composing) setComposing(false);
  });

  bindPanelEvents(); bindSearch(); bindSheet(); bindRoutesList(); bindPalette(); bindRename();
  addEventListener('resize', syncPeekHeight);
}

/** 정류장 데이터를 (아직 안 받았다면) 받기 시작한다 */
function ensureStops() {
  if (S.dataReady) return S.dataReady;
  showDataPending(true, '정류장 불러오는 중…');
  S.dataReady = loadStops()
    .then(() => {
      showDataPending(false);
      performance.mark('stops-ready');
      populateStopLayer();
    })
    .catch(err => {
      showDataPending(true, '정류장 데이터를 불러오지 못했습니다');
      console.error(err);
      throw err;
    });
  return S.dataReady;
}

function showDataPending(on, msg) {
  const el = $('data-pending');
  if (!el) return;
  el.hidden = !on;
  if (msg) el.textContent = msg;
}

async function main() {
  applyTheme(currentTheme(), { redraw: false });

  S.pickers.region = createSelect($('region-picker'), {
    placeholder: '전국',
    onChange: value => {
      S.region = value;
      $('region-picker').classList.toggle('is-filtered', !!value);
      if (!VIEWER_INTENT && S.map?.getSource('stops')) {
        S.map.getSource('stops').setData(stopsFeatureCollection());
      }
      if (S.composing) recomputePreview();
    },
  });
  S.pickers.route = createSelect($('route-picker'), {
    placeholder: '새 노선',
    onChange: id => loadRoute(id),
  });
  S.store = loadFromBrowser();

  // 지도를 먼저 띄우고, 6만 개 정류장은 뒤이어 받는다.
  // 데이터를 기다렸다가 지도를 그리면 흰 화면이 몇 초씩 이어진다.
  $('loading-msg').textContent = '지도를 준비하는 중…';
  initMap();
  bindUI();
  refreshRouteSelect();
  renderPanel();

  // 공유 링크로 들어왔다면 정류장 6만 개는 필요 없을 수도 있다. 필요할 때 받는다.
  if (!VIEWER_INTENT) ensureStops();
  S.api = { toggleStop, undo, setInsertPoint, bestInsertIndex, setOverlay, fitAllRoutes };
  window.__app = S;   // 스모크 테스트용
}

main();
