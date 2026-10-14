// localStorage 저장소. 기존 스키마를 그대로 유지한다.
// { routes: [ { id, name, region, stops: [{id,name,lat,lng}], createdAt } ] }

export const STORAGE_KEY = 'marathon-routes';

/** 노선 색상 팔레트. 밝은 테마와 어두운 테마 모두에서 선이 보이는 값으로 고른다. */
export const ROUTE_COLORS = [
  '#3182f6', // 파랑
  '#f04452', // 빨강
  '#03b26c', // 초록
  '#fe9800', // 주황
  '#a234c7', // 보라
  '#18a5a5', // 청록
  '#e0317f', // 분홍
  '#6b7684', // 회색
];

/** 색이 없는(예전) 노선은 id로 항상 같은 색을 갖게 한다. */
export function colorOf(route) {
  if (route && route.color) return route.color;
  const key = String((route && route.id) || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 997;
  return ROUTE_COLORS[h % ROUTE_COLORS.length];
}

/** 아직 안 쓴 색을 먼저 돌려준다. */
export function nextColor(store) {
  const used = new Set((store.routes || []).map(r => r.color).filter(Boolean));
  return ROUTE_COLORS.find(c => !used.has(c)) || ROUTE_COLORS[(store.routes || []).length % ROUTE_COLORS.length];
}

/** 저장된 노선의 이름을 바꾼다. 중복이면 번호를 붙인다. */
export function renameRoute(store, id, name) {
  const route = store.routes.find(r => r.id === id);
  if (!route) return null;
  const clean = String(name || '').trim();
  if (!clean) return null;
  route.name = uniqueName(store, clean, id);
  return route.name;
}

/** 노선 색을 바꾼다. */
export function setRouteColor(store, id, color) {
  const route = store.routes.find(r => r.id === id);
  if (route) route.color = color;
  return route;
}

export function emptyStore() {
  return { routes: [] };
}

/** 어떤 입력이 와도 유효한 저장소 객체를 돌려준다. */
export function parseStore(raw) {
  if (!raw || typeof raw !== 'string') return emptyStore();
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.routes)) return emptyStore();
    const routes = data.routes.filter(r => r && r.name && Array.isArray(r.stops));
    return { ...data, routes };
  } catch {
    return emptyStore();
  }
}

export function serializeStore(store) {
  return JSON.stringify(store);
}

/** 같은 id면 덮어쓰고 없으면 추가한다. */
export function upsertRoute(store, route) {
  const i = store.routes.findIndex(r => r.id === route.id);
  if (i >= 0) store.routes[i] = route;
  else store.routes.push(route);
  return store;
}

export function removeRoute(store, id) {
  store.routes = store.routes.filter(r => r.id !== id);
  return store;
}

/** 중복 이름이면 "(2)", "(3)"을 붙인다. */
export function uniqueName(store, name, exceptId = null) {
  const taken = store.routes.filter(r => r.id !== exceptId).map(r => r.name);
  if (!taken.includes(name)) return name;
  let n = 2;
  while (taken.includes(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}

/** 같은 밀리초에 여러 개를 만들어도 겹치지 않는 id */
function newId() {
  return `route-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function newRoute(name, region, stops, color = ROUTE_COLORS[0]) {
  return {
    id: newId(),
    name,
    region: region || null,
    color,
    stops: stops.map(s => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng })),
    createdAt: new Date().toISOString(),
  };
}

/** 브라우저 전용 헬퍼. Node 테스트에서는 쓰지 않는다. */
export function loadFromBrowser() {
  try { return parseStore(localStorage.getItem(STORAGE_KEY)); } catch { return emptyStore(); }
}

export function saveToBrowser(store) {
  localStorage.setItem(STORAGE_KEY, serializeStore(store));
}
