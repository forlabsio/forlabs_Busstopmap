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

test('190개 코스 토큰이 2,500자 미만이다', async () => {
  // 좌표를 함께 실어 받는 쪽이 5MB 데이터 없이 바로 그릴 수 있게 했다.
  // 그 대가로 링크가 길어지지만 메신저로 보내는 데는 문제없는 길이다.
  const token = await encodeRoute(full);
  assert.ok(token.length < 2500, `실제 ${token.length}자`);
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

test('v2: 좌표를 함께 실어 받는 쪽이 데이터 없이 그릴 수 있다', async () => {
  const short = backup.routes.find(r => r.name.includes('마라톤'));
  const back = await decodeRoute(await encodeRoute(short));
  assert.equal(back.name, short.name);
  assert.deepEqual(back.ids, short.stops.map(s => s.id));
  assert.equal(back.coords.length, short.stops.length);
  assert.equal(back.names.length, short.stops.length);
  assert.ok(Math.abs(back.coords[0].lat - short.stops[0].lat) < 0.00001);
  assert.equal(back.names[0], short.stops[0].name);
});

test('v2: 29개 코스 링크가 1,100자 미만', async () => {
  const short = backup.routes.find(r => r.name.includes('마라톤'));
  const token = await encodeRoute(short);
  assert.ok(token.length < 1100, `실제 ${token.length}자`);
});

test('v2: 긴 코스는 이름을 빼서 링크를 줄인다', async () => {
  const token = await encodeRoute(full);
  assert.ok(token.length < 2500, `실제 ${token.length}자`);
  const back = await decodeRoute(token);
  assert.equal(back.ids.length, 190);
  assert.equal(back.coords.length, 190);
  assert.equal(back.names, null);          // 이름은 받는 쪽에서 채운다
});

test('v1 예전 링크도 계속 읽힌다', async () => {
  const legacy = await (async () => {
    const payload = '옛날 노선\nSEB113000014,SEB113000015';
    const bytes = new TextEncoder().encode(payload);
    const cs = new CompressionStream('deflate');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  })();
  const back = await decodeRoute(legacy);
  assert.equal(back.name, '옛날 노선');
  assert.equal(back.ids.length, 2);
  assert.equal(back.coords, null);
});
