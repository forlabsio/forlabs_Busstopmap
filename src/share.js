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

/**
 * 링크가 자체 완결되면 받는 쪽은 5MB 정류장 데이터를 받지 않아도 된다.
 * 그래서 좌표를 같이 싣고, 너무 길어지면 이름부터 뺀다.
 */
const MAX_WITH_NAMES = 2400;   // 이름까지 넣어도 이 길이 안이면 그대로 쓴다

const r5 = n => Number(n).toFixed(5);

async function pack(lines) {
  return b64urlEncode(await squeeze(lines.join('\n'), 'deflate'));
}

/** 노선 -> URL 토큰 */
export async function encodeRoute(route) {
  const stops = route.stops;
  const ids = stops.map(s => s.id).join(',');
  const coords = stops.map(s => `${r5(s.lat)},${r5(s.lng)}`).join(';');
  const names = stops.map(s => String(s.name).replace(/[|\n]/g, ' ')).join('|');

  const withNames = await pack(['2', route.name, ids, coords, names]);
  if (withNames.length <= MAX_WITH_NAMES) return withNames;
  return pack(['2', route.name, ids, coords]);     // 이름은 받는 쪽에서 채운다
}

/**
 * URL 토큰 -> { name, ids, coords?, names? }. 실패하면 null.
 * 예전(v1) 링크도 계속 읽는다.
 */
export async function decodeRoute(token) {
  try {
    const bytes = await squeeze(b64urlDecode(token), 'inflate');
    const text = new TextDecoder().decode(bytes);
    const lines = text.split('\n');

    if (lines[0] === '2') {
      const [, name, idLine, coordLine, nameLine] = lines;
      const ids = (idLine || '').split(',').filter(Boolean);
      if (!ids.length) return null;
      const coords = (coordLine || '').split(';').filter(Boolean)
        .map(pair => {
          const [lat, lng] = pair.split(',').map(Number);
          return { lat, lng };
        });
      const names = nameLine ? nameLine.split('|') : null;
      return { name, ids, coords: coords.length === ids.length ? coords : null, names };
    }

    // v1: 이름 + ID만
    const nl = text.indexOf('\n');
    if (nl < 0) return null;
    const ids = text.slice(nl + 1).split(',').filter(Boolean);
    if (!ids.length) return null;
    return { name: text.slice(0, nl), ids, coords: null, names: null };
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
