import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStore, serializeStore, upsertRoute, removeRoute, uniqueName, newRoute } from '../src/store.js';

const raw = readFileSync('backups/marathon-routes-latest.json', 'utf8');

test('기존 백업을 그대로 읽는다', () => {
  const store = parseStore(raw);
  assert.equal(store.routes.length, 2);
  assert.equal(store.routes.find(r => r.name === '풀코스').stops.length, 190);
  assert.equal(store.routes.find(r => r.name.includes('마라톤')).stops.length, 29);
});

test('깨진 입력은 빈 저장소가 된다', () => {
  assert.deepEqual(parseStore('{{{'), { routes: [] });
  assert.deepEqual(parseStore(null), { routes: [] });
  assert.deepEqual(parseStore('[]'), { routes: [] });
  assert.deepEqual(parseStore('{"routes":"nope"}'), { routes: [] });
});

test('정류장이 없는 항목은 걸러낸다', () => {
  const store = parseStore('{"routes":[{"name":"깨진것"},{"id":"a","name":"정상","stops":[]}]}');
  assert.equal(store.routes.length, 1);
  assert.equal(store.routes[0].name, '정상');
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

test('removeRoute: id로 지운다', () => {
  const store = parseStore(raw);
  removeRoute(store, store.routes[0].id);
  assert.equal(store.routes.length, 1);
});

test('uniqueName: 중복이면 번호를 붙인다', () => {
  const store = parseStore(raw);
  assert.equal(uniqueName(store, '새 이름'), '새 이름');
  assert.equal(uniqueName(store, '풀코스'), '풀코스 (2)');
  const self = store.routes.find(r => r.name === '풀코스');
  assert.equal(uniqueName(store, '풀코스', self.id), '풀코스');
});

test('직렬화 왕복이 정류장 수를 보존한다', () => {
  const store = parseStore(raw);
  const back = parseStore(serializeStore(store));
  assert.equal(back.routes.find(r => r.name === '풀코스').stops.length, 190);
});

test('newRoute: 필요한 필드만 남긴다', () => {
  const r = newRoute('테스트', '서울특별시', [{ id: 'A', name: '가', lat: 37.5, lng: 127, extra: '버려짐' }]);
  assert.deepEqual(r.stops, [{ id: 'A', name: '가', lat: 37.5, lng: 127 }]);
  assert.match(r.id, /^route-\d+$/);
  assert.ok(r.createdAt);
});
