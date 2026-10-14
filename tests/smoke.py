#!/usr/bin/env python3
"""헤드리스 Chrome으로 앱을 실제 조작하는 스모크 테스트.

사용법: python3 tests/smoke.py [URL] [--mobile]
전제:  python3 -m http.server 8765 가 저장소 루트에서 돌고 있어야 한다.
       헤드리스에서 WebGL을 쓰려면 swiftshader 플래그가 필요하다.
"""
import base64, json, os, shutil, subprocess, sys, time, urllib.request
import websocket

URL = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'http://127.0.0.1:8765/index-v2.html'
MOBILE = '--mobile' in sys.argv
SIZE = '390,844' if MOBILE else '1440,900'
TMP = '/private/tmp/claude-501/-Users-heesangchae/8be8e20b-32cd-4960-a784-8ea0df17f58f/scratchpad'
PROF = f'{TMP}/smoke-prof'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


class Page:
    def __init__(self, url, size, profile):
        shutil.rmtree(profile, ignore_errors=True)
        subprocess.run(['pkill', '-f', 'remote-debugging-port=9444'], capture_output=True)
        time.sleep(1)
        self.proc = subprocess.Popen([
            CHROME, '--headless=new', '--hide-scrollbars', '--enable-unsafe-swiftshader',
            '--use-gl=angle', '--use-angle=swiftshader', f'--window-size={size}',
            '--remote-debugging-port=9444', '--remote-allow-origins=*',
            f'--user-data-dir={profile}', url,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ws_url = None
        for _ in range(60):
            try:
                for t in json.load(urllib.request.urlopen('http://127.0.0.1:9444/json')):
                    if t.get('type') == 'page' and 'http' in t.get('url', ''):
                        ws_url = t['webSocketDebuggerUrl']
                if ws_url:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        self.ws = websocket.create_connection(ws_url, timeout=120)
        self.mid = 0
        self.errors = []
        self.send('Runtime.enable')
        self.send('Page.enable')

    def send(self, method, params=None):
        self.mid += 1
        self.ws.send(json.dumps({'id': self.mid, 'method': method, 'params': params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('method') == 'Runtime.exceptionThrown':
                d = m['params']['exceptionDetails']
                self.errors.append((d.get('exception') or {}).get('description') or d.get('text'))
            if m.get('method') == 'Page.javascriptDialogOpening':
                self.send('Page.handleJavaScriptDialog', {'accept': True})
            if m.get('id') == self.mid:
                return m.get('result', {})

    def ev(self, expr):
        r = self.send('Runtime.evaluate',
                      {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in r:
            return 'ERROR: ' + json.dumps(r['exceptionDetails'].get('exception', {}).get('description', ''))[:200]
        return r.get('result', {}).get('value')

    def shot(self, path):
        r = self.send('Page.captureScreenshot', {'format': 'png'})
        open(path, 'wb').write(base64.b64decode(r['data']))

    def close(self):
        self.ws.close()
        self.proc.terminate()


def main():
    ok, fail = [], []

    def check(name, cond, detail=''):
        (ok if cond else fail).append(name)
        print(f"  {'PASS' if cond else 'FAIL'}  {name}{'  — ' + str(detail) if detail else ''}")

    p = Page(URL, SIZE, PROF)
    # confirm 창을 자동 수락하고 alert은 삼킨다
    p.ev("window.confirm = () => true; window.__alerts = []; window.alert = m => window.__alerts.push(m);")
    time.sleep(16)

    print(f'\n== 로딩 ({"모바일" if MOBILE else "데스크톱"}) ==')
    check('정류장 데이터 64,347개', p.ev('__app.stops.length') == 64347, p.ev('__app.stops.length'))
    check('지도 로드 완료', p.ev('!!(window.__app && __app.map && __app.map.loaded())'))
    check('로딩 오버레이 사라짐', p.ev("document.getElementById('loading').classList.contains('hidden')"))
    check('클러스터 레이어 존재', p.ev("!!__app.map.getLayer('clusters')"))
    ko_layers = p.ev("""(() => {
      const ls = __app.map.getStyle().layers.filter(l => l.type === 'symbol');
      return ls.filter(l => JSON.stringify(__app.map.getLayoutProperty(l.id, 'text-field') || '')
                             .includes('name:ko')).length;
    })()""")
    check('한글 라벨 적용', (ko_layers or 0) >= 20, f'{ko_layers}개 레이어')

    print('\n== 거점 자동 채우기 ==')
    p.ev("document.getElementById('tool-compose').click()")
    p.ev("""
      const wp = [[37.56675,126.89618],[37.54958,126.91383],[37.53817,126.90060],
                  [37.53195,126.90960],[37.52953,126.92789]];
      for (const [lat,lng] of wp) {
        const ll = new maplibregl.LngLat(lng, lat);
        __app.map.fire('click', { lngLat: ll, point: __app.map.project(ll), originalEvent: new MouseEvent('click') });
      }
      'fired';
    """)
    time.sleep(3)
    n_preview = p.ev('__app.preview.length')
    check('거점 5개 등록', p.ev('__app.waypoints.length') == 5)
    check('미리보기 12~30개', 12 <= (n_preview or 0) <= 30, f'{n_preview}개')
    p.ev("document.getElementById('gap').value = 800; document.getElementById('gap').dispatchEvent(new Event('input'))")
    time.sleep(1)
    sparse = p.ev('__app.preview.length')
    check('간격 늘리면 줄어듦', (sparse or 0) < (n_preview or 0), f'{n_preview} -> {sparse}')
    p.ev("document.getElementById('gap').value = 250; document.getElementById('gap').dispatchEvent(new Event('input'))")
    time.sleep(1)
    p.ev("document.getElementById('btn-wp-apply').click()")
    time.sleep(2)
    n_route = p.ev('__app.route.stops.length')
    check('노선에 반영됨', 12 <= (n_route or 0) <= 30, f'{n_route}개')
    check('패널 목록 렌더', (p.ev("document.querySelectorAll('#list .item').length") or 0) == n_route)
    check('총거리 표시', 'km' in (p.ev("document.getElementById('stat-km').textContent") or ''),
          p.ev("document.getElementById('stat-km').textContent"))

    print('\n== 저장 / 내보내기 ==')
    p.ev("document.getElementById('route-name').value='스모크 코스'; "
         "document.getElementById('route-name').dispatchEvent(new Event('input'))")
    p.ev("document.getElementById('btn-save').click()")
    time.sleep(1)
    saved = p.ev("JSON.parse(localStorage.getItem('marathon-routes')||'{\"routes\":[]}').routes.length")
    check('localStorage 저장', (saved or 0) >= 1, f'{saved}개')
    check('저장 스키마 유지', p.ev(
        "(() => { const r = JSON.parse(localStorage.getItem('marathon-routes')).routes[0]; "
        "return ['id','name','region','stops','createdAt'].every(k => k in r) "
        "&& ['id','name','lat','lng'].every(k => k in r.stops[0]); })()"))

    print('\n== 공유 링크 ==')
    token = p.ev("""(async () => {
      const m = await import('./src/share.js');
      return await m.encodeRoute({ name: __app.route.name, stops: __app.route.stops });
    })()""")
    check('토큰 생성', isinstance(token, str) and len(token) > 10, f'{len(token) if token else 0}자')

    print('\n== 기존 사용자 데이터 호환 ==')
    backup = open('backups/marathon-routes-latest.json', encoding='utf-8').read()
    p.ev(f"localStorage.setItem('marathon-routes', {json.dumps(backup)}); 'set'")
    p.ev('location.reload()')
    time.sleep(16)
    p.ev("window.confirm = () => true; window.alert = () => {};")
    names = p.ev("Array.from(document.getElementById('route-select').options).map(o=>o.textContent).join(' | ')")
    check('기존 노선 2개 드롭다운 노출', '풀코스' in (names or ''), names)
    p.ev("""(() => { const s = document.getElementById('route-select');
      const o = Array.from(s.options).find(o => o.textContent.includes('풀코스'));
      s.value = o.value; s.dispatchEvent(new Event('change')); })()""")
    time.sleep(3)
    check('풀코스 190개 로드', p.ev('__app.route.stops.length') == 190, p.ev('__app.route.stops.length'))
    check('지도에 노선 그려짐', (p.ev("__app.map.getSource('route')._data.features.length") or 0) == 191)

    p.shot(f'{TMP}/smoke-{"mobile" if MOBILE else "desktop"}.png')
    before = p.ev("document.documentElement.dataset.theme")
    p.ev("document.getElementById('theme-btn').click()")
    time.sleep(5)
    after = p.ev("document.documentElement.dataset.theme")
    p.shot(f'{TMP}/smoke-{"mobile" if MOBILE else "desktop"}-{after}.png')
    check('테마 토글', before != after and after in ('light', 'dark'), f'{before} -> {after}')
    check('테마 전환 후 노선 유지', p.ev('__app.route.stops.length') == 190,
          p.ev('__app.route.stops.length'))

    real_errors = [e for e in p.errors if e and 'favicon' not in str(e)]
    check('JS 예외 없음', not real_errors, real_errors[:2])
    p.close()

    print(f'\n결과: {len(ok)}개 통과 / {len(fail)}개 실패')
    if fail:
        print('실패:', ', '.join(fail))
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
