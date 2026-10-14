#!/usr/bin/env python3
"""노선을 고정 주소로 발행한다.

사용법:
  python3 publish.py <내보낸파일.json>                  # 파일 안의 모든 노선을 발행
  python3 publish.py <파일.json> --only "풀코스"         # 특정 노선만
  python3 publish.py <파일.json> --slug mapo-2026       # 주소 이름 지정 (노선 1개일 때)
  python3 publish.py --list                             # 발행된 노선 보기
  python3 publish.py --remove mapo-2026                 # 발행 취소
  python3 publish.py <파일.json> --deploy               # 발행 후 커밋·배포까지

발행하면 https://run.forlabs.io/?w=<주소이름> 으로 누구나 볼 수 있다.
파일은 published/ 에 들어가며, 저장소에 커밋되어야 실제로 보인다.
"""
import json, os, re, subprocess, sys, unicodedata
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
PUB_DIR = os.path.join(ROOT, 'published')
INDEX = os.path.join(PUB_DIR, 'index.json')
SITE = 'https://run.forlabs.io'


def slugify(name):
    """한글 이름에서 쓸 만한 주소 이름을 만든다. 영문/숫자가 없으면 날짜로 대체."""
    text = unicodedata.normalize('NFKD', name)
    text = re.sub(r'[^a-zA-Z0-9가-힣\s-]', '', text).strip().lower()
    text = re.sub(r'[\s_]+', '-', text)
    ascii_only = re.sub(r'[^a-z0-9-]', '', text).strip('-')
    return ascii_only or 'route-' + datetime.now().strftime('%Y%m%d-%H%M')


def load_routes(path):
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    routes = data.get('routes') if isinstance(data, dict) else data
    if not isinstance(routes, list):
        sys.exit('노선 목록을 찾을 수 없습니다. 앱의 "내보내기"로 받은 파일을 넣어주세요.')
    return routes


def write_route(route, slug):
    """받는 쪽이 정류장 데이터 없이 바로 그릴 수 있도록 좌표까지 담는다."""
    stops = [{'id': s['id'], 'name': s['name'], 'lat': s['lat'], 'lng': s['lng']}
             for s in route['stops']]
    payload = {
        'id': route.get('id'),                 # 다시 가져올 때 같은 노선으로 인식되도록
        'name': route['name'],
        'color': route.get('color'),
        'region': route.get('region'),
        'stops': stops,
        'createdAt': route.get('createdAt'),
        'publishedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    }
    os.makedirs(PUB_DIR, exist_ok=True)
    path = os.path.join(PUB_DIR, f'{slug}.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    return path, payload


def rebuild_index():
    items = []
    for fn in sorted(os.listdir(PUB_DIR)) if os.path.isdir(PUB_DIR) else []:
        if not fn.endswith('.json') or fn == 'index.json':
            continue
        with open(os.path.join(PUB_DIR, fn), encoding='utf-8') as f:
            d = json.load(f)
        items.append({
            'slug': fn[:-5], 'name': d.get('name', fn[:-5]),
            'stops': len(d.get('stops', [])), 'publishedAt': d.get('publishedAt'),
            'color': d.get('color'),
        })
    with open(INDEX, 'w', encoding='utf-8') as f:
        json.dump({'routes': items}, f, ensure_ascii=False, indent=2)
    return items


def deploy():
    subprocess.run(['git', 'add', 'published'], cwd=ROOT, check=True)
    subprocess.run(['git', 'commit', '-m', 'chore: publish routes'], cwd=ROOT, check=True)
    subprocess.run(['git', 'push', 'origin', 'main'], cwd=ROOT, check=True)
    subprocess.run(['npx', '--yes', 'vercel@latest', '--prod', '--yes'], cwd=ROOT, check=True)


def main():
    args = sys.argv[1:]
    if not args or '--help' in args or '-h' in args:
        print(__doc__); return

    if '--list' in args:
        for it in rebuild_index():
            print(f"  {SITE}/?w={it['slug']:<22} {it['name']} ({it['stops']}개 정류장)")
        return

    if '--remove' in args:
        slug = args[args.index('--remove') + 1]
        path = os.path.join(PUB_DIR, f'{slug}.json')
        if not os.path.exists(path):
            sys.exit(f'발행된 적 없는 주소입니다: {slug}')
        os.remove(path); rebuild_index()
        print(f'발행 취소: {slug} (배포해야 실제로 사라집니다)')
        return

    src = args[0]
    only = args[args.index('--only') + 1] if '--only' in args else None
    slug_arg = args[args.index('--slug') + 1] if '--slug' in args else None

    routes = load_routes(src)
    if only:
        routes = [r for r in routes if r['name'] == only]
        if not routes:
            sys.exit(f'"{only}" 노선을 파일에서 찾지 못했습니다.')
    if slug_arg and len(routes) > 1:
        sys.exit('--slug 는 노선이 하나일 때만 쓸 수 있습니다. --only 로 하나를 골라주세요.')

    for route in routes:
        slug = slug_arg or slugify(route['name'])
        path, payload = write_route(route, slug)
        print(f"발행: {route['name']} ({len(payload['stops'])}개 정류장)")
        print(f"   파일  {os.path.relpath(path, ROOT)}")
        print(f"   주소  {SITE}/?w={slug}")

    rebuild_index()

    if '--deploy' in args:
        print('\n커밋하고 배포합니다…')
        deploy()
        print('배포 완료')
    else:
        print('\n아직 저장소에만 있습니다. 실제로 보이게 하려면:')
        print('   git add published && git commit -m "publish" && git push && npx vercel --prod')
        print('   (또는 같은 명령에 --deploy 를 붙이세요)')


if __name__ == '__main__':
    main()
