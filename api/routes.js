// 노선 저장소 — Vercel Blob에 문서 하나로 보관한다.
//   GET  /api/routes            모든 노선을 읽는다 (누구나)
//   PUT  /api/routes            노선을 저장한다 (x-edit-key 필요)
// 동시에 두 기기에서 고치는 사고를 막기 위해 version을 함께 쓴다.
import { put, head } from '@vercel/blob';

const KEY = 'routes.json';
const EMPTY = { routes: [], version: 0 };

async function readStore() {
  try {
    const meta = await head(KEY);          // 공개 저장소라 URL로 바로 읽는다
    const res = await fetch(meta.url, { cache: 'no-store' });
    if (!res.ok) return EMPTY;
    const data = await res.json();
    return { routes: data.routes || [], version: data.version || 0 };
  } catch {
    return EMPTY;                           // 아직 한 번도 저장한 적 없음
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-edit-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    // 편집 키 확인용
    if (req.query && req.query.check !== undefined) {
      const key = process.env.EDIT_KEY;
      const ok = !!key && req.headers['x-edit-key'] === key;
      return res.status(ok ? 200 : 401).json({ valid: ok });
    }
    const store = await readStore();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(store);
  }

  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const editKey = process.env.EDIT_KEY;
  if (!editKey) return res.status(500).json({ error: 'edit_key_not_configured' });
  if (req.headers['x-edit-key'] !== editKey) {
    return res.status(401).json({ error: 'bad_edit_key', message: '편집 권한이 없습니다' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body || !Array.isArray(body.routes)) {
    return res.status(400).json({ error: 'bad_payload', message: 'routes 배열이 필요합니다' });
  }

  const current = await readStore();
  if (body.baseVersion !== undefined && body.baseVersion !== current.version) {
    return res.status(409).json({
      error: 'version_conflict',
      message: '다른 기기에서 먼저 저장했습니다. 새로고침 후 다시 시도하세요',
      serverVersion: current.version,
    });
  }

  const next = { routes: body.routes, version: Date.now() };
  await put(KEY, JSON.stringify(next), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });

  return res.status(200).json({ ok: true, version: next.version, count: next.routes.length });
}
