// 거리 계산과 거점 기반 자동 채우기.
// 좁은 영역(수도권)만 다루므로 평면 투영으로 충분하다.

const R = 6371;        // km
const LAT0 = 37.53;    // 투영 기준 위도 (서울)
const toRad = d => d * Math.PI / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** 점들을 순서대로 이은 총 거리 (km) */
export function totalDistance(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversine(points[i - 1], points[i]);
  return sum;
}

/** 각 지점까지의 누적 거리 배열 (km). 첫 원소는 0. */
export function cumulativeDistances(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + haversine(points[i - 1], points[i]));
  return out;
}

/**
 * 새 정류장을 어디에 끼울지 고른다.
 * 각 구간에 넣었을 때 늘어나는 거리를 재고, 맨 앞/맨 뒤에 붙이는 경우까지 같이 비교한다.
 * 코스 중간에 빠뜨린 정류장은 그 자리에, 코스를 이어 그리는 중이면 맨 뒤에 들어간다.
 */
export function bestInsertIndex(stops, stop) {
  if (stops.length < 2) return stops.length;

  let bestIndex = stops.length;                       // 맨 뒤에 붙이기
  let bestCost = haversine(stops.at(-1), stop);

  const front = haversine(stop, stops[0]);            // 맨 앞에 붙이기
  if (front < bestCost) { bestCost = front; bestIndex = 0; }

  for (let i = 0; i < stops.length - 1; i++) {        // 구간 사이에 끼우기
    const detour = haversine(stops[i], stop) + haversine(stop, stops[i + 1])
                 - haversine(stops[i], stops[i + 1]);
    if (detour < bestCost) { bestCost = detour; bestIndex = i + 1; }
  }
  return bestIndex;
}

/** 위경도 -> 미터 평면 */
function project(p) {
  return [toRad(p.lng) * R * 1000 * Math.cos(toRad(LAT0)), toRad(p.lat) * R * 1000];
}

/**
 * 거점을 이은 경로에서 corridor(m) 이내 정류장을 찾아 경로 순서대로 돌려준다.
 * 슬라이더로 간격만 다시 계산할 수 있도록 솎아내기 전 결과를 준다.
 */
export function corridorCandidates(stops, waypoints, corridor = 160) {
  if (!waypoints || waypoints.length < 2) return [];

  const path = waypoints.map(project);
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }

  const hits = [];
  for (const s of stops) {
    const p = project(s);
    let best = Infinity, along = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, ay] = path[i], [bx, by] = path[i + 1];
      const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - ay) * vy) / len2));
      const d = Math.hypot(p[0] - (ax + t * vx), p[1] - (ay + t * vy));
      if (d < best) { best = d; along = cum[i] + t * Math.sqrt(len2); }
    }
    if (best <= corridor) hits.push({ stop: s, offset: best, along, xy: p });
  }
  hits.sort((a, b) => a.along - b.along);
  return hits;
}

/** 후보를 최소 간격(m)으로 솎아낸다. 양방향 정류장 쌍과 밀집 구간을 걸러낸다. */
export function thin(candidates, minGap = 250) {
  const kept = [];
  for (const c of candidates) {
    const last = kept.at(-1);
    if (!last || Math.hypot(c.xy[0] - last.xy[0], c.xy[1] - last.xy[1]) >= minGap) kept.push(c);
  }
  return kept.map(c => ({ id: c.stop.id, name: c.stop.name, lat: c.stop.lat, lng: c.stop.lng }));
}

/** 거점 -> 노선 정류장 목록 */
export function autoFill(stops, waypoints, { corridor = 160, minGap = 250 } = {}) {
  return thin(corridorCandidates(stops, waypoints, corridor), minGap);
}
