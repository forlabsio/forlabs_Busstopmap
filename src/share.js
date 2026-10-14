// 노선을 URL 토큰으로 압축한다. 정류장 ID만 담으므로 190개 코스도 1KB 아래다.

const b64urlEncode = bytes => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDecode = s => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('invalid token');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

async function squeeze(input, mode) {
  const stream = mode === 'deflate'
    ? new CompressionStream('deflate')
    : new DecompressionStream('deflate');
  const bytes = mode === 'deflate' ? new TextEncoder().encode(input) : input;
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** 노선 -> URL 토큰 */
export async function encodeRoute(route) {
  const payload = route.name + '\n' + route.stops.map(s => s.id).join(',');
  return b64urlEncode(await squeeze(payload, 'deflate'));
}

/** URL 토큰 -> {name, ids}. 실패하면 null */
export async function decodeRoute(token) {
  try {
    const bytes = await squeeze(b64urlDecode(token), 'inflate');
    const text = new TextDecoder().decode(bytes);
    const nl = text.indexOf('\n');
    if (nl < 0) return null;
    const ids = text.slice(nl + 1).split(',').filter(Boolean);
    if (!ids.length) return null;
    return { name: text.slice(0, nl), ids };
  } catch {
    return null;
  }
}

/**
 * 공유받은 ID 목록을 정류장 데이터로 되살린다.
 * 데이터가 갱신되어 사라진 ID는 건너뛰고 몇 개가 빠졌는지 알려준다.
 */
export function resolveIds(ids, stopsById) {
  const stops = [], missing = [];
  for (const id of ids) {
    const s = stopsById.get(id);
    if (s) stops.push({ id: s.id, name: s.name, lat: s.lat, lng: s.lng });
    else missing.push(id);
  }
  return { stops, missing };
}
