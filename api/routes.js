// 노선 저장소 — Vercel Blob
//   GET  /api/routes            모든 노선을 읽는다 (누구나)
//   GET  /api/routes?check=1    편집 키 확인
//   PUT  /api/routes            노선을 저장한다 (x-edit-key 필요)
//
// 같은 경로를 덮어쓰면 메타데이터는 바로 바뀌는데 본문 전파가 늦어
// 저장 직후 읽기가 옛 내용을 돌려준다(실측 10초 이상). 그래서 저장할 때마다
// routes/<판번호>.json 이라는 "새 경로"를 쓴다. 새 경로에는 옛 사본이 없으므로
// 항상 방금 쓴 내용이 그대로 읽힌다. 오래된 판은 몇 개만 남기고 지운다.
import { put, list, del } from '@vercel/blob';

const PREFIX = 'routes/';
const KEEP = 5;

const versionOf = pathname => {
  const m = /routes\/(\d+)\.json$/.exec(pathname || '');
  return m ? Number(m[1]) : 0;
};

/** 가장 최근 판을 찾는다. 메타데이터 목록은 즉시 갱신된다. */
async function latestBlob() {
  const { blobs } = await list({ prefix: PREFIX, limit: 100 });
  if (!blobs.length) return null;
  return blobs
    .map(b => ({ ...b, version: versionOf(b.pathname) }))
    .sort((a, b) => b.version - a.version)[0];
}

async function readStore() {
  const newest = await latestBlob();
  if (!newest) return { routes: [], version: 0 };
  try {
    const res = await fetch(newest.url, { cache: 'no-store' });
    if (!res.ok) return { routes: [], version: newest.version };
    const data = await res.json();
    return { routes: data.routes || [], version: newest.version };
  } catch {
    return { routes: [], version: newest.version };
  }
}

/** 최근 몇 개만 남기고 정리한다 */
async function prune() {
  try {
    const { blobs } = await list({ prefix: PREFIX, limit: 100 });
    const old = blobs
      .map(b => ({ ...b, version: versionOf(b.pathname) }))
      .sort((a, b) => b.version - a.version)
      .slice(KEEP);
    if (old.length) await del(old.map(b => b.url));
  } catch { /* 정리는 실패해도 저장에는 영향이 없다 */ }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-edit-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    if (req.query && req.query.check !== undefined) {
      const key = process.env.EDIT_KEY;
      const ok = !!key && req.headers['x-edit-key'] === key;
      return res.status(ok ? 200 : 401).json({ valid: ok });
    }
    const store = await readStore();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(store);
  }

  if (req.method !== 'PUT') return res.status(405).json({ error: 'method_not_allowed' });

  const editKey = process.env.EDIT_KEY;
  if (!editKey) return res.status(500).json({ error: 'edit_key_not_configured' });
  if (req.headers['x-edit-key'] !== editKey) {
    return res.status(401).json({ error: 'bad_edit_key', message: '편집 권한이 없습니다' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body || !Array.isArray(body.routes)) {
    return res.status(400).json({ error: 'bad_payload', message: 'routes 배열이 필요합니다' });
  }

  const newest = await latestBlob();
  const currentVersion = newest ? newest.version : 0;
  if (body.baseVersion !== undefined && currentVersion > body.baseVersion) {
    return res.status(409).json({
      error: 'version_conflict',
      message: '다른 기기에서 먼저 저장했습니다. 새로고침 후 다시 시도하세요',
      serverVersion: currentVersion,
    });
  }

  const version = Math.max(Date.now(), currentVersion + 1);
  await put(`${PREFIX}${version}.json`, JSON.stringify({ routes: body.routes }), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  });
  await prune();

  return res.status(200).json({ ok: true, version, count: body.routes.length });
}
