import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { haversine, totalDistance, cumulativeDistances, autoFill } from '../src/geo.js';

const stops = JSON.parse(readFileSync('data/stops.json', 'utf8'))
  .map(([id, name, lat, lng, city]) => ({ id, name, lat, lng, city }));

test('haversine: 합정역에서 여의도공원까지 약 2.6km', () => {
  const d = haversine({ lat: 37.54958, lng: 126.91383 }, { lat: 37.52953, lng: 126.92789 });
  assert.ok(d > 2.4 && d < 2.8, `실제 ${d}`);
});

test('totalDistance: 빈 배열과 1개는 0', () => {
  assert.equal(totalDistance([]), 0);
  assert.equal(totalDistance([{ lat: 37.5, lng: 127 }]), 0);
});

test('cumulativeDistances: 길이가 입력과 같고 단조 증가한다', () => {
  const pts = [{ lat: 37.5, lng: 127 }, { lat: 37.51, lng: 127 }, { lat: 37.52, lng: 127 }];
  const cum = cumulativeDistances(pts);
  assert.equal(cum.length, 3);
  assert.equal(cum[0], 0);
  assert.ok(cum[1] < cum[2]);
});

test('autoFill: 상암→여의도 거점 5개로 12~30개 정류장을 뽑는다', () => {
  const waypoints = [
    { lat: 37.56675, lng: 126.89618 },
    { lat: 37.54958, lng: 126.91383 },
    { lat: 37.53817, lng: 126.90060 },
    { lat: 37.53195, lng: 126.90960 },
    { lat: 37.52953, lng: 126.92789 },
  ];
  const picked = autoFill(stops, waypoints, { corridor: 160, minGap: 250 });
  assert.ok(picked.length >= 12 && picked.length <= 30, `실제 ${picked.length}개`);
  assert.match(picked[0].name, /월드컵/);
  assert.match(picked.at(-1).name, /여의도공원/);
});

test('autoFill: minGap을 키우면 정류장이 줄어든다', () => {
  const wp = [{ lat: 37.56675, lng: 126.89618 }, { lat: 37.52953, lng: 126.92789 }];
  const dense = autoFill(stops, wp, { corridor: 160, minGap: 250 });
  const sparse = autoFill(stops, wp, { corridor: 160, minGap: 1000 });
  assert.ok(sparse.length < dense.length, `${dense.length} vs ${sparse.length}`);
});

test('autoFill: 거점이 1개 이하면 빈 배열', () => {
  assert.deepEqual(autoFill(stops, [{ lat: 37.5, lng: 127 }], {}), []);
  assert.deepEqual(autoFill(stops, [], {}), []);
});

test('autoFill: 거점을 촘촘히 찍으면 도로를 더 잘 따라가 정류장이 늘어난다', () => {
  const coarse = [
    { lat: 37.56675, lng: 126.89618 }, { lat: 37.54958, lng: 126.91383 },
  ];
  const fine = [
    { lat: 37.56675, lng: 126.89618 }, { lat: 37.56490, lng: 126.90230 },
    { lat: 37.55611, lng: 126.90994 }, { lat: 37.54958, lng: 126.91383 },
  ];
  const a = autoFill(stops, coarse, { corridor: 160, minGap: 250 });
  const b = autoFill(stops, fine, { corridor: 160, minGap: 250 });
  assert.ok(b.length > a.length, `coarse ${a.length} / fine ${b.length}`);
});
