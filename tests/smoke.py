#!/usr/bin/env python3
"""헤드리스 Chrome으로 앱을 실제 조작하는 스모크 테스트.

사용법: python3 tests/smoke.py [URL] [--mobile]
전제:  python3 -m http.server 8765 가 저장소 루트에서 돌고 있어야 한다.
       헤드리스에서 WebGL을 쓰려면 swiftshader 플래그가 필요하다.
"""
import base64, json, os, shutil, subprocess, sys, time, urllib.request
import websocket

URL = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'http://127.0.0.1:8765/index.html'
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
        # about:blank으로 띄운 뒤 직접 이동한다. URL을 인자로 주면 다른 탭에 붙는 일이 생긴다.
        self.proc = subprocess.Popen([
            CHROME, '--headless=new', '--hide-scrollbars', '--enable-unsafe-swiftshader',
            '--use-gl=angle', '--use-angle=swiftshader', f'--window-size={size}',
            '--remote-debugging-port=9444', '--remote-allow-origins=*',
            '--no-first-run', '--no-default-browser-check',
            f'--user-data-dir={profile}', 'about:blank',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ws_url = None
        for _ in range(80):
            try:
                targets = json.load(urllib.request.urlopen('http://127.0.0.1:9444/json'))
                pages = [t for t in targets if t.get('type') == 'page']
                if pages:
                    ws_url = pages[0]['webSocketDebuggerUrl']
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if not ws_url:
            raise RuntimeError('헤드리스 Chrome 페이지 타깃을 찾지 못했습니다')
        self.ws = websocket.create_connection(ws_url, timeout=120)
        self.mid = 0
        self.errors = []
        self.eval_errors = []
        self.send('Runtime.enable')
        self.send('Page.enable')
        self.send('Page.navigate', {'url': url})
        time.sleep(1)

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
            desc = (r['exceptionDetails'].get('exception') or {}).get('description', '')
            self.eval_errors.append(desc[:200])
            return None
        return r.get('result', {}).get('value')

    def wait_for(self, expr, timeout=60, label=''):
        """앱이 준비될 때까지 기다린다. 고정 sleep은 느린 날 깨진다."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.ev(expr):
                return True
            time.sleep(0.5)
        print(f'  (대기 시간 초과: {label or expr})')
        print('    현재 URL:', self.ev('location.href'),
              '| readyState:', self.ev('document.readyState'),
              '| 로딩 메시지:', self.ev("(document.getElementById('loading-msg')||{}).textContent"))
        return False

    def ready(self, timeout=60):
        self.eval_errors.clear()
        if not self.wait_for("!!document.getElementById('route-select')", 15, '앱 마크업'):
            print('    페이지가 앱이 아닙니다. URL을 확인하세요:', self.ev('location.href'))
            return False
        return self.wait_for('!!(window.__app && __app.map && __app.map.loaded() && __app.stops.length)',
                             timeout, '앱 초기화')

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
    started = time.time()
    booted = p.ready()

    print(f'\n== 로딩 ({"모바일" if MOBILE else "데스크톱"}) ==')
    check('앱 초기화 완료', booted, f'{time.time() - started:.1f}초')
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
    p.ev("""(() => {
      const wp = [[37.56675,126.89618],[37.54958,126.91383],[37.53817,126.90060],
                  [37.53195,126.90960],[37.52953,126.92789]];
      for (const [lat,lng] of wp) {
        const ll = new maplibregl.LngLat(lng, lat);
        __app.map.fire('click', { lngLat: ll, point: __app.map.project(ll), originalEvent: new MouseEvent('click') });
      }
      return 'fired';
    })()""")
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
    time.sleep(2)
    p.ready()
    p.ev("window.confirm = () => true; window.alert = () => {};")
    names = p.ev("Array.from(document.getElementById('route-select').options).map(o=>o.textContent).join(' | ')")
    check('기존 노선 2개 드롭다운 노출', '풀코스' in (names or ''), names)
    p.ev("""(() => { const s = document.getElementById('route-select');
      const o = Array.from(s.options).find(o => o.textContent.includes('풀코스'));
      s.value = o.value; s.dispatchEvent(new Event('change')); })()""")
    time.sleep(3)
    check('풀코스 190개 로드', p.ev('__app.route.stops.length') == 190, p.ev('__app.route.stops.length'))
    check('지도에 노선 그려짐', (p.ev("__app.map.getSource('route')._data.features.length") or 0) == 191)

    print('\n== 실수 복구 (되돌리기 / 이어붙이기) ==')
    # 거점을 찍어 자동 채우기 -> 기존 190개에 "이어 붙이기"
    p.ev("document.getElementById('tool-compose').click()")
    p.ev("""(() => {
      const wp = [[37.56675,126.89618],[37.54958,126.91383],[37.52953,126.92789]];
      for (const [lat,lng] of wp) {
        const ll = new maplibregl.LngLat(lng, lat);
        __app.map.fire('click', { lngLat: ll, point: __app.map.project(ll), originalEvent: new MouseEvent('click') });
      }
      return wp.length;
    })()""")
    time.sleep(3)
    added = p.ev('__app.preview.length') or 0
    check('이어붙이기 버튼 노출', p.ev("!document.getElementById('btn-wp-append').hidden"))
    check('교체 버튼 문구가 경고성으로 바뀜',
          p.ev("document.getElementById('btn-wp-apply').textContent") == '기존 노선 교체',
          p.ev("document.getElementById('btn-wp-apply').textContent"))
    p.ev("document.getElementById('btn-wp-append').click()")
    time.sleep(2)
    check('이어붙이면 기존 정류장이 유지됨', p.ev('__app.route.stops.length') == 190 + added,
          f'{p.ev("__app.route.stops.length")} (190+{added})')
    check('편집 중 표시 노출', p.ev("!document.getElementById('dirty').hidden"))

    # 되돌리기
    p.ev("document.getElementById('tool-undo').click()")
    time.sleep(2)
    check('되돌리기로 190개 복원', p.ev('__app.route.stops.length') == 190, p.ev('__app.route.stops.length'))

    # 거점 교체 후 되돌리기 (가장 위험한 동작)
    p.ev("document.getElementById('tool-compose').click()")
    p.ev("""(() => {
      const wp = [[37.56675,126.89618],[37.52953,126.92789]];
      for (const [lat,lng] of wp) {
        const ll = new maplibregl.LngLat(lng, lat);
        __app.map.fire('click', { lngLat: ll, point: __app.map.project(ll), originalEvent: new MouseEvent('click') });
      }
      return wp.length;
    })()""")
    time.sleep(3)
    p.ev("document.getElementById('btn-wp-apply').click()")   # confirm은 자동 수락
    time.sleep(2)
    replaced = p.ev('__app.route.stops.length') or 0
    check('교체되면 정류장이 줄어듦', 0 < replaced < 190, f'{replaced}개')
    check('교체해도 저장본은 그대로',
          p.ev("JSON.parse(localStorage.getItem('marathon-routes')).routes"
               ".find(r => r.name === '풀코스').stops.length") == 190)
    # 합성 이벤트를 두 번 쏘면 두 단계가 되돌려진다. 실제 키 입력으로 한 번만 보낸다.
    p.ev("document.body.focus()")
    for phase in ('rawKeyDown', 'keyUp'):
        p.send('Input.dispatchKeyEvent', {'type': phase, 'key': 'z', 'code': 'KeyZ',
                                          'windowsVirtualKeyCode': 90, 'nativeVirtualKeyCode': 90,
                                          'modifiers': 4})
    time.sleep(2)
    check('⌘Z로 190개 복원', p.ev('__app.route.stops.length') == 190, p.ev('__app.route.stops.length'))
    p.ev("document.getElementById('route-name').focus()")
    for phase in ('rawKeyDown', 'keyUp'):
        p.send('Input.dispatchKeyEvent', {'type': phase, 'key': 'z', 'code': 'KeyZ',
                                          'windowsVirtualKeyCode': 90, 'nativeVirtualKeyCode': 90,
                                          'modifiers': 4})
    time.sleep(1)
    check('입력창에서는 ⌘Z가 노선을 건드리지 않음', p.ev('__app.route.stops.length') == 190,
          p.ev('__app.route.stops.length'))
    p.ev("document.getElementById('route-name').blur()")

    p.shot(f'{TMP}/smoke-{"mobile" if MOBILE else "desktop"}.png')
    before = p.ev("document.documentElement.dataset.theme")
    p.ev("document.getElementById('theme-btn').click()")
    time.sleep(5)
    after = p.ev("document.documentElement.dataset.theme")
    p.shot(f'{TMP}/smoke-{"mobile" if MOBILE else "desktop"}-{after}.png')
    check('테마 토글', before != after and after in ('light', 'dark'), f'{before} -> {after}')
    check('테마 버튼이 전환될 상태를 표시', p.ev("document.getElementById('theme-btn').textContent")
          == ('☀' if after == 'dark' else '☾'),
          p.ev("document.getElementById('theme-btn').textContent + ' / ' "
               "+ document.getElementById('theme-btn').title"))
    check('테마 전환 후 노선 유지', p.ev('__app.route.stops.length') == 190,
          p.ev('__app.route.stops.length'))

    real_errors = [e for e in p.errors + p.eval_errors if e and 'favicon' not in str(e)]
    check('JS 예외 없음', not real_errors, real_errors[:2])
    p.close()

    print(f'\n결과: {len(ok)}개 통과 / {len(fail)}개 실패')
    if fail:
        print('실패:', ', '.join(fail))
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
