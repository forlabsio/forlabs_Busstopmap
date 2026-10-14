import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeRoute, decodeRoute, resolveIds } from '../src/share.js';

const backup = JSON.parse(readFileSync('backups/marathon-routes-latest.json', 'utf8'));
const full = backup.routes.find(r => r.name === '풀코스');

test('encode/decode 왕복이 이름과 ID 순서를 보존한다', async () => {
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
  assert.equal(await decodeRoute(''), null);
  assert.equal(await decodeRoute('aGVsbG8'), null);
});

test('resolveIds: 사라진 ID는 건너뛰고 보고한다', () => {
  const byId = new Map(full.stops.map(s => [s.id, s]));
  const { stops, missing } = resolveIds([full.stops[0].id, '없는ID', full.stops[1].id], byId);
  assert.equal(stops.length, 2);
  assert.deepEqual(missing, ['없는ID']);
});
