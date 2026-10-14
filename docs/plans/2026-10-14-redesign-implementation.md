# 마라톤 노선 관리 리뉴얼 구현 계획

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 지도·디자인·노선 작성 방식을 전면 교체하고, 보기 전용 공유 링크와 함께 Vercel에 배포한다.

**Architecture:** 단일 페이지 정적 앱이다. 순수 로직(거리·자동채우기·링크 코덱·저장소)은 `src/*.js`
ES 모듈로 분리해 Node 단위 테스트로 검증하고, 화면은 `index.html` 하나가 그 모듈들을 import 한다.
정류장 데이터는 빌드 스크립트가 CSV를 압축 배열 JSON으로 바꿔 `data/stops.json`으로 내보낸다.

**Tech Stack:** MapLibre GL 4.7 + CARTO 벡터 타일, Vanilla ES 모듈, Pretendard, Toss 디자인 토큰,
Node 18 `node:test`(단위) + 헤드리스 Chrome CDP(스모크), Python 3 빌드 스크립트, Vercel 정적 배포.

---

## 사전 조건

- 설계 문서: `docs/plans/2026-10-14-redesign-design.md`를 먼저 읽는다.
- 기존 자산을 그대로 쓴다.
  - `filtered_bus_stops.csv` — 전국 64,347개(서울/경기/인천) 원본
  - `backups/marathon-routes-latest.json` — 사용자 실데이터. 노선 2개(29개 / 190개 정류장)
  - 현 `index.html` — 저장 스키마와 인쇄 레이아웃의 참고 구현. **작업 중 건드리지 않는다.**
  - `mockups/redesign-concept.html` — 확정된 화면 구성과 Toss 토큰. 레이아웃의 기준.
- 수용 조건 1순위: 기존 노선 2개가 새 앱에서 그대로 열린다. 저장 스키마를 바꾸지 않는다.
- 로컬 서버는 이미 8765 포트에서 돌고 있다. 없으면 `python3 -m http.server 8765`.

---

### Task 0: 작업 브랜치와 테스트 러너

**Files:**
- Create: `package.json`
- Create: `tests/.gitkeep`

**Step 1: 브랜치를 만든다**

```bash
cd /Users/heesangchae/forlabs-busstopmap
git checkout -b redesign
```

**Step 2: `package.json`을 만든다** (의존성 없음, 테스트 러너만)

```json
{
  "name": "marathon-route-manager",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/",
    "build": "python3 build.py"
  }
}
```

**Step 3: 러너가 도는지 확인한다**

Run: `npm test`
Expected: `tests/`에 파일이 없으므로 "no test files found"로 끝난다. 오류가 아니면 통과.

**Step 4: 커밋**

```bash
git add package.json tests/.gitkeep
git commit -m "chore: add node:test runner for redesign"
```

---

### Task 1: 데이터 빌드 스크립트

CSV 4.6MB를 필드명 없는 배열 JSON으로 줄인다. `[id, name, lat, lng, city]` 순서다.

**Files:**
- Create: `build.py`
- Output: `data/stops.json`

**Step 1: `build.py`를 쓴다**

```python
#!/usr/bin/env python3
"""filtered_bus_stops.csv -> data/stops.json (압축 배열)

사용법:
  python3 build.py            # data/stops.json 생성
  python3 build.py --single   # dist/index.html (데이터 인라인) 생성
"""
import csv, json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(ROOT, 'filtered_bus_stops.csv')
OUT_PATH = os.path.join(ROOT, 'data', 'stops.json')

def load_stops():
    stops = []
    with open(CSV_PATH, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            try:
                lat, lng = round(float(r['위도']), 6), round(float(r['경도']), 6)
            except (ValueError, KeyError):
                continue
            stops.append([r['정류장번호'], r['정류장명'], lat, lng, r['도시명']])
    return stops

def main():
    stops = load_stops()
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(stops, f, ensure_ascii=False, separators=(',', ':'))
    size = os.path.getsize(OUT_PATH) / 1024 / 1024
    print(f'{len(stops):,}개 정류장 -> {OUT_PATH} ({size:.1f}MB)')

    if '--single' in sys.argv:
        src = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
        data = open(OUT_PATH, encoding='utf-8').read()
        src = src.replace('</head>', f'<script id="stops-inline" type="application/json">{data}</script>\n</head>', 1)
        os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
        out = os.path.join(ROOT, 'dist', 'index.html')
        open(out, 'w', encoding='utf-8').write(src)
        print(f'배포용 단일 파일 -> {out} ({os.path.getsize(out)/1024/1024:.1f}MB)')

if __name__ == '__main__':
    main()
```

**Step 2: 실행한다**

Run: `python3 build.py`
Expected: `64,347개 정류장 -> .../data/stops.json (약 3.5MB)`

**Step 3: 형식을 확인한다**

Run: `python3 -c "import json;d=json.load(open('data/stops.json'));print(len(d), d[0])"`
Expected: `64347 ['GGB165000061', '한국가스공사', 37.405433, 126.68755, '인천광역시']`

**Step 4: 커밋**

```bash
git add build.py data/stops.json
git commit -m "feat: add build script producing compact stops.json"
```

---

### Task 2: 거리와 자동 채우기 로직

앱의 핵심이다. 거점 몇 개로 코스를 만드는 알고리즘을 순수 함수로 짠다.

**Files:**
- Create: `src/geo.js`
- Test: `tests/geo.test.js`

**Step 1: 실패하는 테스트를 쓴다**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { haversine, totalDistance, autoFill } from '../src/geo.js';

const stops = JSON.parse(readFileSync('data/stops.json', 'utf8'))
  .map(([id, name, lat, lng, city]) => ({ id, name, lat, lng, city }));

test('haversine: 합정역에서 여의도공원까지 약 3km', () => {
  const d = haversine({ lat: 37.54958, lng: 126.91383 }, { lat: 37.52953, lng: 126.92789 });
  assert.ok(d > 2.4 && d < 2.8, `실제 ${d}`);
});

test('totalDistance: 빈 배열과 1개는 0', () => {
  assert.equal(totalDistance([]), 0);
  assert.equal(totalDistance([{ lat: 37.5, lng: 127 }]), 0);
});

test('autoFill: 상암→여의도 거점 5개로 20~35개 정류장을 뽑는다', () => {
  const waypoints = [
    { lat: 37.56675, lng: 126.89618 },  // 상암월드컵공원
    { lat: 37.54958, lng: 126.91383 },  // 합정역
    { lat: 37.53817, lng: 126.90060 },  // 양화대교 남단
    { lat: 37.53195, lng: 126.90960 },  // 여의하류IC
    { lat: 37.52953, lng: 126.92789 },  // 여의도공원
  ];
  const picked = autoFill(stops, waypoints, { corridor: 160, minGap: 250 });
  assert.ok(picked.length >= 20 && picked.length <= 35, `실제 ${picked.length}개`);
  assert.match(picked[0].name, /월드컵/);
  assert.match(picked.at(-1).name, /여의도공원/);
});

test('autoFill: minGap을 키우면 정류장이 줄어든다', () => {
  const wp = [{ lat: 37.56675, lng: 126.89618 }, { lat: 37.52953, lng: 126.92789 }];
  const dense = autoFill(stops, wp, { corridor: 160, minGap: 250 });
  const sparse = autoFill(stops, wp, { corridor: 160, minGap: 1000 });
  assert.ok(sparse.length < dense.length);
});

test('autoFill: 거점이 1개 이하면 빈 배열', () => {
  assert.deepEqual(autoFill(stops, [{ lat: 37.5, lng: 127 }], {}), []);
});
```

**Step 2: 실패를 확인한다**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/geo.js'`

**Step 3: `src/geo.js`를 쓴다**

경로를 평면으로 투영해 각 정류장의 수직거리와 경로상 누적거리를 구하고, 코리도 안쪽만
누적거리 순으로 정렬한 뒤 최소 간격으로 솎아낸다. 이 알고리즘은 이미 실데이터로 검증했다.

```js
const R = 6371;                     // km
const LAT0 = 37.53;                 // 서울 기준 위도 (평면 투영 보정)
const toRad = d => d * Math.PI / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function totalDistance(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversine(points[i - 1], points[i]);
  return sum;
}

/** 위경도를 미터 평면으로 (좁은 영역 한정) */
function project(p) {
  return [toRad(p.lng) * R * 1000 * Math.cos(toRad(LAT0)), toRad(p.lat) * R * 1000];
}

/**
 * 거점을 이은 경로 주변 정류장을 순서대로 고른다.
 * @param {Array} stops  {id,name,lat,lng} 목록
 * @param {Array} waypoints  거점 {lat,lng} 2개 이상
 * @param {{corridor?:number, minGap?:number}} opts  미터 단위
 */
export function autoFill(stops, waypoints, { corridor = 160, minGap = 250 } = {}) {
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
    if (best <= corridor) hits.push({ stop: s, along, xy: p });
  }

  hits.sort((a, b) => a.along - b.along);

  const kept = [];
  for (const h of hits) {
    const last = kept.at(-1);
    if (!last || Math.hypot(h.xy[0] - last.xy[0], h.xy[1] - last.xy[1]) >= minGap) kept.push(h);
  }
  return kept.map(h => ({ id: h.stop.id, name: h.stop.name, lat: h.stop.lat, lng: h.stop.lng }));
}
```

**Step 4: 통과를 확인한다**

Run: `npm test`
Expected: 5개 테스트 PASS

**Step 5: 커밋**

```bash
git add src/geo.js tests/geo.test.js
git commit -m "feat: add distance and corridor auto-fill logic with tests"
```

---

### Task 3: 공유 링크 코덱

정류장 ID만 압축해 URL에 넣는다. 실측으로 190개 코스가 726자였다.

**Files:**
- Create: `src/share.js`
- Test: `tests/share.test.js`

**Step 1: 실패하는 테스트를 쓴다**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeRoute, decodeRoute } from '../src/share.js';

const backup = JSON.parse(readFileSync('backups/marathon-routes-latest.json', 'utf8'));
const full = backup.routes.find(r => r.name === '풀코스');

test('encode/decode 왕복이 ID 순서를 보존한다', async () => {
  const token = await encodeRoute(full);
  const back = await decodeRoute(token);
  assert.equal(back.name, full.name);
  assert.deepEqual(back.ids, full.stops.map(s => s.id));
});

test('190개 코스 토큰이 1,200자 미만이다', async () => {
  const token = await encodeRoute(full);
  assert.ok(token.length < 1200, `실제 ${token.length}자`);
});

test('URL 안전 문자만 쓴다', async () => {
  const token = await encodeRoute(full);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test('깨진 토큰은 null을 돌려준다', async () => {
  assert.equal(await decodeRoute('!!!not-a-token!!!'), null);
});
```

**Step 2: 실패를 확인한다**

Run: `npm test`
Expected: FAIL — 모듈 없음

**Step 3: `src/share.js`를 쓴다**

`CompressionStream`은 Node 18과 최신 브라우저 모두에 있다. 확인했다.

```js
const b64urlEncode = bytes => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = s => {
  const pad = s.length % 4 ? '='.repeat(4 - s.length % 4) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

async function squeeze(text, mode) {
  const stream = mode === 'deflate'
    ? new CompressionStream('deflate') : new DecompressionStream('deflate');
  const input = mode === 'deflate' ? new TextEncoder().encode(text) : text;
  const out = new Response(new Blob([input]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** 노선 -> URL 토큰. 이름과 정류장 ID만 담는다. */
export async function encodeRoute(route) {
  const payload = route.name + '\n' + route.stops.map(s => s.id).join(',');
  return b64urlEncode(await squeeze(payload, 'deflate'));
}

/** URL 토큰 -> {name, ids}. 실패하면 null. */
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
```

**Step 4: 통과를 확인한다**

Run: `npm test`
Expected: geo 5개 + share 4개 PASS

**Step 5: 커밋**

```bash
git add src/share.js tests/share.test.js
git commit -m "feat: add compressed share-link codec"
```

---

### Task 4: 저장소 어댑터

기존 스키마를 그대로 읽고 쓴다. 이 테스트가 호환성을 지킨다.

**Files:**
- Create: `src/store.js`
- Test: `tests/store.test.js`

**Step 1: 테스트를 쓴다** — 실데이터 백업을 그대로 먹여 본다.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStore, upsertRoute, serializeStore } from '../src/store.js';

const raw = readFileSync('backups/marathon-routes-latest.json', 'utf8');

test('기존 백업을 그대로 읽는다', () => {
  const store = parseStore(raw);
  assert.equal(store.routes.length, 2);
  assert.equal(store.routes.find(r => r.name === '풀코스').stops.length, 190);
});

test('깨진 입력은 빈 저장소가 된다', () => {
  assert.deepEqual(parseStore('{{{'), { routes: [] });
  assert.deepEqual(parseStore(null), { routes: [] });
});

test('같은 id는 덮어쓰고 새 id는 추가한다', () => {
  const store = parseStore(raw);
  const first = store.routes[0];
  upsertRoute(store, { ...first, name: '이름만 변경' });
  assert.equal(store.routes.length, 2);
  assert.equal(store.routes[0].name, '이름만 변경');
  upsertRoute(store, { id: 'route-new', name: '신규', region: '서울특별시', stops: first.stops });
  assert.equal(store.routes.length, 3);
});

test('직렬화 왕복이 정류장 수를 보존한다', () => {
  const store = parseStore(raw);
  assert.equal(parseStore(serializeStore(store)).routes[1].stops.length, 190);
});
```

**Step 2: 실패 확인 → `src/store.js` 구현 → 통과 확인**

`STORAGE_KEY`는 `'marathon-routes'`로 유지한다. 노선 객체는 `{id, name, region, stops[{id,name,lat,lng}], createdAt}`.
`parseStore`는 어떤 입력이든 `{routes: []}` 이상을 보장한다.

**Step 3: 커밋**

```bash
git add src/store.js tests/store.test.js
git commit -m "feat: add storage adapter preserving existing schema"
```

---

### Task 5: 앱 셸과 Toss 토큰

**Files:**
- Create: `index-v2.html`, `src/theme.css`
- Reference: `mockups/redesign-concept.html` (레이아웃과 토큰의 기준)

**Step 1:** 목업의 Toss 테마 값을 `src/theme.css`의 `:root` 변수로 옮긴다.
`@media (prefers-color-scheme: dark)`와 `:root[data-theme="dark"]`에 다크 값을 둔다.

```
라이트: primary #3182f6 / canvas #ffffff / surface #f2f4f6 / fg #191f28 / border #e5e8eb
다크  : primary #4593fc / canvas #17171c / surface #1f2026 / fg #f7f8fa / border #2b2d35
```

**Step 2:** `index-v2.html`에 목업과 같은 구조를 만든다. 검색바, 필터 칩, 노선 패널,
하단 툴바, 지도 컨테이너. 스크립트는 `<script type="module">`로 `src/*.js`를 import 한다.

**Step 3:** `http://127.0.0.1:8765/index-v2.html`을 열어 레이아웃만 확인한다(지도 없이).

**Step 4: 커밋** — `git commit -m "feat: add v2 app shell with Toss design tokens"`

---

### Task 6: 지도와 클러스터링

**Files:** Modify `index-v2.html`, Create `src/map.js`

**Step 1:** MapLibre를 띄우고 CARTO positron(라이트)/dark-matter(다크)를 연결한다.
`preserveDrawingBuffer: true`를 켠다(인쇄에 필요).

**Step 2:** 스타일 로드 후 한글 라벨을 적용한다. 확인된 방법이다.

```js
map.getStyle().layers.filter(l => l.type === 'symbol').forEach(l => {
  try { map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ko'], ['get', 'name']]); } catch {}
});
```

**Step 3:** `data/stops.json`을 받아 GeoJSON source(`cluster: true`, `clusterMaxZoom: 13`,
`clusterRadius: 50`)로 올린다. 클러스터 원 + 개수 라벨 + 개별 점 3개 레이어.

**Step 4: 스모크 테스트** — `tests/smoke.py`로 헤드리스 확인. 헤드리스에서 WebGL을 쓰려면
`--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader`가 필요하다. 확인된 사실이다.

측정: 첫 화면까지 2초 이내, 콘솔 예외 0건, 마커 소스 피처 64,347개.

**Step 5: 커밋** — `git commit -m "feat: replace Leaflet with MapLibre vector map and clustering"`

---

### Task 7: 노선 패널

**Files:** Modify `index-v2.html`, Create `src/panel.js`

정류장 목록(번호 배지, 출발/골인 표시, 누적거리), 드래그 순서 변경(HTML5 draggable),
총거리·정류장 수·예상 시간(10km/h), ✕ 제거. 거리는 `src/geo.js`의 함수를 쓴다.
패널에 "직선 거리 기준"이라고 적는다.

**커밋:** `feat: add route panel with drag reorder and distance`

---

### Task 8: 거점 자동 채우기

**Files:** Modify `index-v2.html`, Create `src/compose.js`

**Step 1:** 툴바의 "거점 찍기" 모드에서 지도 클릭마다 거점을 추가하고 번호 핀을 찍는다.

**Step 2:** 거점이 2개 이상이면 `autoFill()` 결과를 **회색 미리보기**로 그린다.

**Step 3:** 간격 슬라이더(100m~1km, 기본 250m)를 움직이면 즉시 다시 계산한다.
64,347개를 매번 훑으므로, 거점 변경 시에만 코리도 후보를 캐시하고 슬라이더는 솎아내기만 다시 한다.

**Step 4:** "이대로 확정"을 누르면 노선에 반영한다. "거점 지우기"로 초기화한다.

**Step 5: 스모크 테스트** — 거점 5개를 프로그램으로 찍어 12~30개가 선택되는지 확인한다.

**커밋:** `feat: add waypoint-based auto fill with preview`

---

### Task 9: 공유 링크와 뷰어 모드

**Files:** Modify `index-v2.html`, Create `src/viewer.js`

**Step 1:** "공유 링크 복사" 버튼 → `encodeRoute()` → `location.origin + '/?r=' + token` 복사.
복사 완료 토스트를 띄운다.

**Step 2:** 로드 시 `?r=`이 있으면 뷰어 모드로 뜬다.
- 편집 UI(툴바, 저장/삭제 버튼, 거점 모드)를 감춘다
- 노선·거리·정류장 목록만 보여준다
- "내 노선으로 복사" 버튼으로 localStorage에 담을 수 있게 한다
- ID는 `data/stops.json`에서 찾는다. **없는 ID는 건너뛰고, 몇 개가 빠졌는지 알린다**

**Step 3:** `?w=<슬러그>`면 `published/<슬러그>.json`을 읽어 같은 뷰어로 띄운다.

**Step 4: 스모크 테스트** — 풀코스 토큰을 만들어 새 프로필에서 열고 190개가 복원되는지 확인한다.

**커밋:** `feat: add share link and read-only viewer mode`

---

### Task 10: 인쇄

**Files:** Modify `index-v2.html`

dom-to-image를 제거하고 `map.getCanvas().toDataURL('image/png')`로 지도를 뽑는다.
기존 `index.html`의 인쇄 레이아웃(지도 + 정류장 표 + 가운데 정렬)을 가져오되 총거리를 추가한다.

**커밋:** `feat: print via maplibre canvas instead of dom-to-image`

---

### Task 11: 모바일과 다크모드

**Files:** Modify `index-v2.html`, `src/theme.css`

- 768px 미만에서 노선 패널을 바텀시트로 바꾼다(손잡이만 / 절반 / 전체 3단계, 드래그 전환).
- 하단 툴바는 아이콘만 남기고, 안전영역(`env(safe-area-inset-bottom)`)을 준다.
- 테마 토글(시스템/라이트/다크)을 두고 선택을 localStorage에 남긴다. 지도 스타일도 함께 바꾼다.
- 스모크 테스트를 390x844(아이폰 폭)로 한 번 더 돌려 가로 스크롤이 없는지 확인한다.

**커밋:** `feat: add mobile bottom sheet and dark mode`

---

### Task 12: 교체와 회귀 검증

**Files:** Modify `index.html`(교체), Create `legacy/index-v1.html`

**Step 1:** 구버전을 `legacy/index-v1.html`로 옮긴다(되돌릴 길을 남긴다).

**Step 2:** `index-v2.html`을 `index.html`로 옮긴다.

**Step 3: 회귀 검증** — 반드시 모두 통과해야 한다.

1. 기존 localStorage(노선 2개)를 그대로 둔 채 새 앱을 연다 → 드롭다운에 2개가 보인다
2. 풀코스를 불러온다 → 정류장 190개, 폴리라인이 그려진다
3. 내보내기 → 빈 프로필에서 불러오기 → 190개가 복원된다
4. `backups/marathon-routes-latest.json`을 불러오기로 넣어도 같은 결과다
5. 콘솔 예외 0건

**Step 4: 커밋** — `git commit -m "feat: promote v2 to index.html, keep v1 under legacy/"`

---

### Task 13: Vercel 배포

**Files:** Create `vercel.json`, `.vercelignore`

**Step 1:** `vercel.json`으로 캐시 헤더를 준다.

```json
{
  "headers": [
    { "source": "/data/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=604800, immutable" }] },
    { "source": "/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }] }
  ]
}
```

**Step 2:** `.vercelignore`에 `filtered_bus_stops.csv`, `backups/`, `mockups/`, `legacy/`, `tests/`를 넣는다.
원본 CSV는 저장소에만 두고 배포본에서 뺀다.

**Step 3:** 사용자가 Vercel에서 GitHub 저장소를 연결한다(CLI 설치 없이 웹에서 가능).
Framework Preset은 `Other`, Build Command 없음, Output Directory는 루트.

**Step 4:** 배포 후 확인한다.
- 휴대폰 폭에서 첫 화면까지 걸리는 시간
- `data/stops.json`이 brotli로 내려오는지: `curl -sI -H 'Accept-Encoding: br' <URL>/data/stops.json | grep -i content-encoding`
- 공유 링크를 휴대폰에서 열어 코스가 뜨는지

**Step 5: 커밋 후 푸시** — 푸시는 사용자 확인을 받고 한다.

```bash
git add vercel.json .vercelignore
git commit -m "chore: add vercel static deploy config"
```

---

## 완료 기준

- `npm test` 전부 통과
- 기존 노선 2개(29/190)가 새 앱에서 그대로 열린다
- 거점 5개로 상암→여의도 코스가 12~30개 정류장으로 재현된다 (실측 17개, 7.3km)
- 공유 링크가 다른 브라우저에서 같은 코스로 열린다
- 라이트/다크, 데스크톱/모바일 스크린샷에 깨짐이 없다
- 배포 주소를 휴대폰에서 열어 2초 안에 지도가 뜬다
