// 서버(Vercel Blob)와 노선을 주고받는다.
// 서버가 기준이고 localStorage는 오프라인 대비 사본이다.

const API = '/api/routes';
const KEY_NAME = 'route-edit-key';

export const getEditKey = () => {
  try { return localStorage.getItem(KEY_NAME) || ''; } catch { return ''; }
};

export const setEditKey = key => {
  try { key ? localStorage.setItem(KEY_NAME, key) : localStorage.removeItem(KEY_NAME); } catch { /* 무시 */ }
};

/** 편집 키가 맞는지 서버에 물어본다 */
export async function checkEditKey(key) {
  try {
    const res = await fetch(`${API}?check=1`, { headers: { 'x-edit-key': key } });
    return res.ok;
  } catch {
    return false;
  }
}

/** 서버에서 노선을 읽는다. 실패하면 null (호출한 쪽이 사본을 쓴다) */
export async function fetchRoutes() {
  try {
    const res = await fetch(API, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.routes)) return null;
    return { routes: data.routes, version: data.version || 0 };
  } catch {
    return null;
  }
}

/**
 * 서버에 저장한다.
 * @returns {{ok:true, version:number} | {ok:false, reason:'auth'|'conflict'|'offline'|'error', message?:string, serverVersion?:number}}
 */
export async function saveRoutes(routes, baseVersion, key) {
  if (!key) return { ok: false, reason: 'auth' };
  try {
    const res = await fetch(API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-edit-key': key },
      body: JSON.stringify({ routes, baseVersion }),
    });
    if (res.status === 401) return { ok: false, reason: 'auth' };
    if (res.status === 409) {
      const d = await res.json().catch(() => ({}));
      return { ok: false, reason: 'conflict', serverVersion: d.serverVersion };
    }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return { ok: false, reason: 'error', message: d.message };
    }
    const d = await res.json();
    return { ok: true, version: d.version };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}
