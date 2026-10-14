// localStorage 저장소. 기존 스키마를 그대로 유지한다.
// { routes: [ { id, name, region, stops: [{id,name,lat,lng}], createdAt } ] }

export const STORAGE_KEY = 'marathon-routes';

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

export function newRoute(name, region, stops) {
  return {
    id: `route-${Date.now()}`,
    name,
    region: region || null,
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
