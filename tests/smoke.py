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
        if not self.wait_for("!!document.querySelector('#route-picker .select-trigger')", 15, '앱 마크업'):
            print('    페이지가 앱이 아닙니다. URL을 확인하세요:', self.ev('location.href'))
            return False
        # 공유/발행 링크로 열면 정류장 6만 개를 받지 않는다. 지도 준비까지만 기다린다.
        return self.wait_for(
            "!!(window.__app && __app.map && performance.getEntriesByName('map-ready').length)",
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
    check('지도 스타일 적용 완료',
          p.wait_for("!!(window.__app && __app.map && __app.map.isStyleLoaded())", 20, '스타일'))
    check('로딩 오버레이가 실제로 안 보임', p.ev("""(() => {
      const el = document.getElementById('loading');
      return el.offsetParent === null && getComputedStyle(el).display === 'none';
    })()"""))
    check('지도 캔버스가 화면을 채움', p.ev("""(() => {
      const c = document.querySelector('#map canvas');
      if (!c) return false;
      const r = c.getBoundingClientRect();
      return r.width > innerWidth * 0.8 && r.height > innerHeight * 0.5;
    })()"""))
    check('클러스터 레이어 존재', p.ev("!!__app.map.getLayer('clusters')"))
    ko_layers = p.ev("""(() => {
      const ls = __app.map.getStyle().layers.filter(l => l.type === 'symbol');
      return ls.filter(l => JSON.stringify(__app.map.getLayoutProperty(l.id, 'text-field') || '')
                             .includes('name:ko')).length;
    })()""")
    check('한글 라벨 적용', (ko_layers or 0) >= 20, f'{ko_layers}개 레이어')

    print('\n== 코스 자동 만들기 ==')
    check('자동 만들기가 메뉴 안에 있음',
          p.ev("!!document.querySelector('#menu #tool-compose')"))
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.4)
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

    print('\n== 더보기 메뉴 ==')
    # 빈 노선 상태에서 안내 버튼으로 바로 시작할 수 있어야 한다 (메뉴에 숨겼으므로 발견성 보완)
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.4)
    p.ev("document.getElementById('tool-new').click()")
    time.sleep(1)
    check('빈 노선 화면에 바로가기 버튼이 뜸', p.ev("!!document.getElementById('empty-compose')"))
    p.ev("document.getElementById('empty-compose').click()")
    time.sleep(1)
    check('바로가기로 자동 만들기 진입', p.ev("__app.composing") is True, p.ev('__app.composing'))
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.3)
    p.ev("document.getElementById('tool-compose').click()")       # 끝내기
    time.sleep(0.5)
    # "새 노선"으로 비운 것을 되돌려 이후 검사를 이어간다
    p.ev("document.getElementById('tool-undo').click()")
    time.sleep(1)
    check('새 노선으로 비운 것도 되돌려짐', p.ev('__app.route.stops.length') == n_route,
          f"{p.ev('__app.route.stops.length')} (기대 {n_route})")
    check('지도 위에 떠 있는 툴바가 없음', p.ev("!document.querySelector('.toolbar')"))
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.6)
    check('메뉴 열림', p.ev("!document.getElementById('menu').hidden"))
    items = p.ev("Array.from(document.querySelectorAll('#menu button')).map(b => b.id).join(',')")
    check('메뉴가 그룹으로 나뉘어 있음',
          (p.ev("Array.from(document.querySelectorAll('#menu .menu-group')).map(e=>e.textContent.trim()).join('/')") or '')
          == '만들기/보기/파일',
          p.ev("Array.from(document.querySelectorAll('#menu .menu-group')).map(e=>e.textContent.trim()).join('/')"))
    check('모든 항목에 아이콘이 있음', p.ev("""(() => {
      const items = Array.from(document.querySelectorAll('#menu button[role=menuitem]'));
      return items.length > 0 && items.every(b => b.querySelector('svg'));
    })()"""))
    check('테마 토글이 머리줄 오른쪽 아이콘으로 분리됨', p.ev("""(() => {
      const t = document.getElementById('theme-btn');
      const head = document.querySelector('#menu .menu-group--head');
      if (!t || !head || !head.contains(t)) return false;
      const hb = head.getBoundingClientRect(), tb = t.getBoundingClientRect();
      return tb.right <= hb.right + 1 && tb.left > hb.left + hb.width / 2;
    })()"""))
    check('메뉴에 관리 기능이 모여 있음',
          all(k in (items or '') for k in ['tool-compose', 'tool-new', 'tool-overlay',
                                           'btn-export', 'tool-import', 'tool-editkey',
                                           'tool-print', 'tool-delete']), items)
    if not MOBILE:
        check('메뉴가 ⋯ 버튼 아래에 뜸', p.ev("""(() => {
          const b = document.getElementById('menu-btn').getBoundingClientRect();
          const m = document.getElementById('menu').getBoundingClientRect();
          return m.top > b.top && Math.abs(m.right - b.right) < 24;
        })()"""))
    p.ev("document.getElementById('menu-backdrop').click()")
    time.sleep(0.4)
    check('바깥을 누르면 닫힘', p.ev("document.getElementById('menu').hidden"))

    if MOBILE:
        print('\n== 모바일 바텀시트 ==')
        # 앞선 조작으로 시트가 올라가 있을 수 있으니 요약 상태로 맞춘 뒤 검사한다
        for _ in range(3):
            if p.ev("__app.sheet") == 'peek':
                break
            p.ev("document.getElementById('sheet-handle').click()")
            time.sleep(0.5)
        check('요약(peek) 상태로 되돌릴 수 있음', p.ev("__app.sheet") == 'peek', p.ev('__app.sheet'))
        check('요약 상태에서도 거리/정류장 수가 보임', p.ev("""(() => {
          const r = document.getElementById('stat-km').getBoundingClientRect();
          return r.top > 0 && r.bottom < innerHeight;
        })()"""))
        p.ev("document.getElementById('sheet-handle').click()")
        time.sleep(0.6)
        check('탭하면 반쯤 올라옴', p.ev("__app.sheet") == 'half', p.ev('__app.sheet'))
        p.ev("document.getElementById('sheet-handle').click()")
        time.sleep(0.6)
        check('한 번 더 누르면 전체', p.ev("__app.sheet") == 'full', p.ev('__app.sheet'))
        check('자동 만들기에 들어가면 시트가 올라감', p.ev("""(() => {
          document.getElementById('sheet-handle').click();     // peek으로
          document.getElementById('menu-btn').click();
          document.getElementById('tool-compose').click();     // 자동 만들기 시작
          const s = __app.sheet;
          document.getElementById('menu-btn').click();
          document.getElementById('tool-compose').click();     // 끝내기
          return s === 'half' || s === 'full';
        })()"""))
        check('목록이 화면 안에 들어옴', p.ev("""(() => {
          const r = document.querySelector('#list .item').getBoundingClientRect();
          return r.top > 0 && r.top < innerHeight;
        })()"""))
        check('버튼 터치 영역 44px 이상', p.ev("""(() => {
          const h = document.getElementById('btn-save').getBoundingClientRect().height;
          return h >= 44;
        })()"""), )
        check('가로 스크롤 없음', p.ev("document.documentElement.scrollWidth <= innerWidth"))

    print('\n== 패널 접기 ==')
    if not MOBILE:
        before = p.ev("document.querySelector('.panel').getBoundingClientRect().left")
        p.ev("document.getElementById('panel-toggle').click()")
        time.sleep(1)
        after = p.ev("document.querySelector('.panel').getBoundingClientRect().left")
        check('접으면 패널이 화면 밖으로', (after or 0) > (before or 0) + 100, f'{before} -> {after}')
        check('접힌 상태에서도 버튼은 보임', p.ev("""(() => {
          const b = document.getElementById('panel-toggle').getBoundingClientRect();
          return b.right <= innerWidth + 1 && b.width > 0;
        })()"""))
        p.ev("document.getElementById('panel-toggle').click()")
        time.sleep(1)
        back = p.ev("document.querySelector('.panel').getBoundingClientRect().left")
        check('다시 펼쳐짐', abs((back or 0) - (before or 0)) < 2, f'{back} vs {before}')
        check('상태가 저장됨', p.ev("localStorage.getItem('route-panel-collapsed')") in ('', None),
              p.ev("localStorage.getItem('route-panel-collapsed')"))

    print('\n== 지도 순번 ==')
    check('순번 레이어 존재', p.ev("!!__app.map.getLayer('route-numbers')"))
    check('노선 점에 순번 속성', p.ev("""(() => {
      const pts = __app.map.getSource('route')._data.features.filter(f => f.geometry.type === 'Point');
      return pts.every((f, i) => f.properties.n === i + 1);
    })()"""))
    check('첫/마지막만 edge 표시', p.ev("""(() => {
      const pts = __app.map.getSource('route')._data.features.filter(f => f.geometry.type === 'Point');
      return pts[0].properties.edge === true && pts.at(-1).properties.edge === true
          && pts.slice(1, -1).every(f => f.properties.edge === false);
    })()"""))
    cur_len = p.ev("__app.route.stops.length") or 0
    check('목록 번호가 지도와 같은 1..N',
          p.ev("Array.from(document.querySelectorAll('#list .num')).map(e => e.textContent).join(',')")
          == ','.join(str(i + 1) for i in range(cur_len)), f'{cur_len}개 기준')
    check('출발/골인 꼬리표 표시',
          p.ev("Array.from(document.querySelectorAll('#list .edge-tag')).map(e => e.textContent).join('/')")
          == '출발/골인')

    print('\n== 저장 / 내보내기 ==')
    p.ev("""(() => {
      document.getElementById('rename-btn').click();
      const i = document.getElementById('route-name');
      i.value = '스모크 코스';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()""")
    time.sleep(0.6)
    check('연필로 제목을 바꾸면 제목에 반영', 
          p.ev("document.getElementById('route-title').textContent") == '스모크 코스',
          p.ev("document.getElementById('route-title').textContent"))
    check('편집이 끝나면 입력창은 숨고 제목이 보임',
          p.ev("document.getElementById('route-name').hidden") is True
          and p.ev("document.getElementById('route-title').hidden") is False)
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
    names = p.ev("""(() => {
      document.querySelector('#route-picker .select-trigger').click();
      return Array.from(document.querySelectorAll('#route-picker .select-option'))
        .map(o => o.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
    })()""")
    check('기존 노선 2개 드롭다운 노출', '풀코스' in (names or ''), names)
    check('드롭다운에 정류장 수 뱃지', '190개' in (names or ''), names)
    p.ev("""(() => {
      const o = Array.from(document.querySelectorAll('#route-picker .select-option'))
        .find(o => o.textContent.includes('풀코스'));
      o.click();
    })()""")
    time.sleep(3)
    check('풀코스 190개 로드', p.ev('__app.route.stops.length') == 190, p.ev('__app.route.stops.length'))
    check('지도에 노선 그려짐', (p.ev("__app.map.getSource('route')._data.features.length") or 0) == 191)

    print('\n== 노선 색상 ==')
    before_color = p.ev("__app.route.color")
    p.ev("document.getElementById('color-btn').click()")
    time.sleep(0.5)
    check('팔레트 열림', p.ev("!document.getElementById('palette').hidden"))
    swatches = p.ev("document.querySelectorAll('#palette [data-color]').length")
    check('색상 8개 제공', swatches == 8, swatches)
    p.ev("""(() => {
      const btns = Array.from(document.querySelectorAll('#palette [data-color]'));
      const other = btns.find(b => b.dataset.color !== __app.route.color);
      other.click();
    })()""")
    time.sleep(1)
    after_color = p.ev("__app.route.color")
    check('색이 바뀜', after_color != before_color, f'{before_color} -> {after_color}')
    check('지도 노선 색도 따라감',
          p.ev("__app.map.getPaintProperty('route-line', 'line-color')") == after_color,
          p.ev("__app.map.getPaintProperty('route-line', 'line-color')"))
    check('저장본에도 색이 반영됨', p.ev("""(() => {
      const r = JSON.parse(localStorage.getItem('marathon-routes')).routes.find(r => r.id === __app.route.id);
      return r && r.color === __app.route.color;
    })()"""))
    check('색을 바꾸면 결과를 알려줌',
          '색을' in (p.ev("document.getElementById('toast').textContent") or ''),
          p.ev("document.getElementById('toast').textContent"))
    check('드롭다운 색 점도 함께 바뀜', p.ev("""(() => {
      document.querySelector('#route-picker .select-trigger').click();
      const opt = Array.from(document.querySelectorAll('#route-picker .select-option'))
        .find(o => o.getAttribute('aria-selected') === 'true');
      const dot = opt && opt.querySelector('.opt-dot');
      const bg = dot ? dot.style.background : '';
      document.querySelector('#route-picker .select-trigger').click();
      const hex = __app.route.color.replace('#','');
      const rgb = 'rgb(' + [0,2,4].map(i => parseInt(hex.slice(i,i+2),16)).join(', ') + ')';
      return bg === rgb || bg === __app.route.color;
    })()"""))

    # 저장 전 노선에서 색을 바꾸면 안내가 나와야 한다
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.4)
    p.ev("document.getElementById('tool-new').click()")
    time.sleep(1)
    p.ev("document.getElementById('color-btn').click()")
    time.sleep(0.4)
    p.ev("""(() => {
      const b = Array.from(document.querySelectorAll('#palette [data-color]'))
        .find(b => b.dataset.color !== __app.route.color);
      b.click();
    })()""")
    time.sleep(1)
    check('저장 전 노선은 저장 안내를 보여줌',
          '노선 저장' in (p.ev("document.getElementById('toast').textContent") or ''),
          p.ev("document.getElementById('toast').textContent"))
    p.ev("document.getElementById('tool-undo').click()")
    time.sleep(1)

    print('\n== 제목으로 이름 변경 ==')
    p.ev("""(() => {
      document.getElementById('rename-btn').click();
      const i = document.getElementById('route-name');
      i.value = '제목에서 바꾼 이름';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()""")
    time.sleep(0.8)
    check('제목이 바뀜', p.ev("document.getElementById('route-title').textContent") == '제목에서 바꾼 이름',
          p.ev("document.getElementById('route-title').textContent"))
    check('저장된 노선이면 바로 저장됨', p.ev("""(() => {
      const r = JSON.parse(localStorage.getItem('marathon-routes')).routes
        .find(r => r.id === __app.route.id);
      return r && r.name === '제목에서 바꾼 이름';
    })()"""))
    # Esc로 취소하면 되돌아간다
    p.ev("""(() => {
      document.getElementById('rename-btn').click();
      const i = document.getElementById('route-name');
      i.value = '취소될 이름';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    })()""")
    time.sleep(0.6)
    check('Esc로 취소하면 이름이 그대로',
          p.ev("document.getElementById('route-title').textContent") == '제목에서 바꾼 이름',
          p.ev("document.getElementById('route-title').textContent"))

    print('\n== 전체 노선 보기 ==')
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.4)
    p.ev("document.getElementById('tool-overlay').click()")
    time.sleep(1.2)
    check('전체 노선 목록이 뜸', p.ev("!document.getElementById('routes-list').hidden"))
    check('메뉴에 켜진 상태로 표시',
          p.ev("document.getElementById('tool-overlay').getAttribute('aria-pressed')") == 'true')
    # 저장된 노선 수는 환경마다 다르다(로컬=테스트가 만든 것, 프로덕션=실제 데이터).
    # 고정값 대신 저장소의 실제 개수에서 기대값을 끌어낸다.
    saved = p.ev("__app.store.routes.length")
    rows = p.ev("document.querySelectorAll('#routes-list .route-row').length")
    check('저장된 노선이 모두 나열됨', rows == saved, f'{rows}개 / 저장 {saved}개')
    feats = p.ev("__app.map.getSource('routes-all')._data.features.filter(f => f.geometry.type === 'LineString').length")
    check('편집 중인 것 빼고 지도에 그려짐', feats == saved - 1, f'{feats}개 / 기대 {saved - 1}개')
    check('전체 보기에도 정류장 순번이 그려짐', p.ev("""(() => {
      if (!__app.map.getLayer('all-numbers')) return false;
      const feats = __app.map.getSource('routes-all')._data.features;
      const pts = feats.filter(f => f.geometry.type === 'Point');
      return pts.length > 0 && pts.every(f => typeof f.properties.n === 'number')
          && pts.every(f => !!f.properties.color);
    })()"""))

    # 멀리서도 순번이 빠지지 않아야 한다. 190개 노선을 낮은 배율로 보는 것이
    # "모두 켜기 했는데 숫자가 안 보인다"고 한 바로 그 상황이다.
    def placed_vs_viewport(layer):
        placed = p.ev("""(() => {
          const seen = new Set();
          for (const f of __app.map.queryRenderedFeatures({ layers: ['%s'] })) {
            seen.add((f.properties.rid || 'cur') + '#' + f.properties.n);
          }
          return seen.size;
        })()""" % layer)
        want = p.ev("""(() => {
          const b = __app.map.getBounds();
          const src = __app.map.getLayer('%s').source;
          return __app.map.getSource(src)._data.features
            .filter(f => f.geometry.type === 'Point')
            .filter(f => {
              const [lng, lat] = f.geometry.coordinates;
              return lng >= b.getWest() && lng <= b.getEast()
                  && lat >= b.getSouth() && lat <= b.getNorth();
            }).length;
        })()""" % layer)
        return placed, want

    p.ev("__app.api.fitAllRoutes()")
    time.sleep(2.0)
    p.ev("__app.map.jumpTo({ zoom: 10 })")
    time.sleep(2.5)
    z = p.ev("__app.map.getZoom()")
    pl, wn = placed_vs_viewport('route-numbers')
    check('190개 노선을 멀리서 봐도 순번이 다 보임', pl == wn and wn > 100,
          f'배율 {z:.1f} — {pl}개 / 화면 안 {wn}개')
    pl, wn = placed_vs_viewport('all-numbers')
    check('전체 보기 순번도 멀리서 다 보임', pl == wn and wn > 0,
          f'{pl}개 / 화면 안 {wn}개')
    check('순번 레이어에 배율 하한이 없음', all(
        p.ev("__app.map.getLayer('%s').minzoom" % l) in (0, None)
        for l in ('all-numbers', 'route-numbers')))
    # 색은 사용자가 고르는 값이라 겹칠 수 있다. 목록 점이 각 노선의 색과 맞는지만 본다.
    check('목록의 색 점이 각 노선 색과 일치', p.ev("""(() => {
      const toRgb = hex => {
        const h = hex.replace('#','');
        return 'rgb(' + [0,2,4].map(i => parseInt(h.slice(i,i+2),16)).join(', ') + ')';
      };
      return Array.from(document.querySelectorAll('#routes-list .route-row')).every(row => {
        const r = __app.store.routes.find(x => x.id === row.dataset.id);
        if (!r) return false;
        const bg = row.querySelector('.dot').style.background;
        const want = r.color || '';
        return !want || bg === toRgb(want) || bg === want;
      });
    })()"""))

    p.ev("""(() => {
      const other = Array.from(document.querySelectorAll('#routes-list [data-toggle]'))
        .find(c => c.dataset.toggle !== __app.route.id);
      other.click();
    })()""")
    time.sleep(0.8)
    check('체크를 끄면 지도에서 사라짐', p.ev("__app.map.getSource('routes-all')._data.features.filter(f => f.geometry.type === 'LineString').length") == saved - 2,
          f'기대 {saved - 2}개')
    p.ev("document.querySelector('#routes-list [data-all=\"on\"]').click()")
    time.sleep(0.8)
    check('모두 켜기로 되돌아옴', p.ev("__app.map.getSource('routes-all')._data.features.filter(f => f.geometry.type === 'LineString').length") == saved - 1,
          f'기대 {saved - 1}개')

    # 한 개만 보기
    other_id = p.ev("""(() => {
      const row = Array.from(document.querySelectorAll('#routes-list .route-row'))
        .find(r => r.dataset.id !== __app.route.id);
      const id = row.dataset.id;
      row.querySelector('[data-solo]').click();
      return id;
    })()""")
    time.sleep(2)
    check('"이것만"을 누르면 그 노선이 편집 대상이 됨', p.ev("__app.route.id") == other_id,
          f'{p.ev("__app.route.id")} vs {other_id}')
    check('다른 노선은 지도에서 사라짐', p.ev("__app.map.getSource('routes-all')._data.features.filter(f => f.geometry.type === 'LineString').length") == 0,
          p.ev("__app.map.getSource('routes-all')._data.features.filter(f => f.geometry.type === 'LineString').length"))
    check('버튼이 "모두"로 바뀜', p.ev("""(() => {
      const row = Array.from(document.querySelectorAll('#routes-list .route-row'))
        .find(r => r.dataset.id === __app.route.id);
      return row.querySelector('[data-solo]').textContent.trim();
    })()""") == '모두')
    p.ev("""(() => {
      const row = Array.from(document.querySelectorAll('#routes-list .route-row'))
        .find(r => r.dataset.id === __app.route.id);
      row.querySelector('[data-solo]').click();
    })()""")
    time.sleep(1)
    back = p.ev("__app.map.getSource('routes-all')._data.features.filter(f => f.geometry.type === 'LineString').length")
    check('한 번 더 누르면 전체 보기로 복귀', back == saved - 1, f'{back}개 / 기대 {saved - 1}개')
    # 이후 검사를 위해 190개 노선으로 되돌린다
    p.ev("""(() => {
      const row = Array.from(document.querySelectorAll('#routes-list .route-row'))
        .find(r => r.querySelector('.rmeta').textContent.startsWith('190'));
      row.click();
    })()""")
    time.sleep(2.5)
    check('190개 노선으로 복귀', p.ev('__app.route.stops.length') == 190,
          p.ev('__app.route.stops.length'))

    print('\n== 노선 이름 변경 ==')
    p.ev("window.prompt = () => '2026 서울 풀코스';")
    p.ev("""(() => {
      const target = Array.from(document.querySelectorAll('#routes-list [data-rename]'))
        .find(b => b.dataset.rename !== __app.route.id);
      target.click();
    })()""")
    time.sleep(1)
    check('목록에서 이름이 바뀜',
          '2026 서울 풀코스' in (p.ev("document.getElementById('routes-list').textContent") or ''))
    check('저장본에도 반영됨', p.ev("""(() => {
      return JSON.parse(localStorage.getItem('marathon-routes')).routes
        .some(r => r.name === '2026 서울 풀코스');
    })()"""))
    check('드롭다운에도 반영됨', p.ev("""(() => {
      document.querySelector('#route-picker .select-trigger').click();
      const t = document.getElementById('route-picker').textContent;
      document.querySelector('#route-picker .select-trigger').click();
      return t.includes('2026 서울 풀코스');
    })()"""))
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.3)
    p.ev("document.getElementById('tool-overlay').click()")   # 전체 보기 끄기
    time.sleep(0.6)
    check('전체 보기를 끄면 목록이 닫힘', p.ev("document.getElementById('routes-list').hidden"))

    print('\n== 노선 복사 · 구간 나누기 ==')
    # 어떤 노선이 열려 있든, 가장 긴 저장 노선을 직접 불러와 기준을 고정한다
    p.ev("""(() => {
      const longest = [...__app.store.routes].sort((a, b) => b.stops.length - a.stops.length)[0];
      if (longest) __app.api.loadRoute(longest.id);
    })()""")
    time.sleep(2.5)
    check('복사 대상 노선이 열림', (p.ev("__app.route.id") or '') != '',
          p.ev("__app.route.name"))
    base_count = p.ev("__app.store.routes.length")
    src_len = p.ev("__app.route.stops.length")
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.4)
    p.ev("document.getElementById('tool-copy').click()")
    time.sleep(1)
    check('복사 창이 뜸', p.ev("!document.getElementById('copy-modal').hidden"))
    check('원본 정보를 보여줌', '정류장' in (p.ev("document.getElementById('copy-source').textContent") or ''),
          p.ev("document.getElementById('copy-source').textContent"))
    check('기본 구간은 전체', p.ev("document.getElementById('copy-to').value") == str(src_len),
          p.ev("document.getElementById('copy-from').value + '~' + document.getElementById('copy-to').value"))

    # 앞 10개만 잘라 복사
    p.ev("""(() => {
      const to = document.getElementById('copy-to');
      to.value = 10; to.dispatchEvent(new Event('input', {bubbles:true}));
    })()""")
    time.sleep(0.6)
    check('구간을 줄이면 미리보기가 따라감',
          '10개' in (p.ev("document.getElementById('copy-preview').textContent") or ''),
          p.ev("document.getElementById('copy-preview').textContent"))
    check('이름도 구간에 맞게 제안됨',
          '~10' in (p.ev("document.getElementById('copy-name').value") or ''),
          p.ev("document.getElementById('copy-name').value"))
    p.ev("document.getElementById('copy-save').click()")
    time.sleep(3)
    check('노선이 하나 늘어남', p.ev("__app.store.routes.length") == (base_count or 0) + 1,
          p.ev("__app.store.routes.length"))
    check('복사본이 10개 정류장으로 열림', p.ev("__app.route.stops.length") == 10,
          p.ev("__app.route.stops.length"))
    check('원본은 그대로', p.ev(f"""(() => {{
      const src = __app.store.routes.find(r => r.stops.length === {src_len});
      return !!src;
    }})()"""))

    # 절반으로 나누기
    p.ev(f"""(() => {{
      const src = __app.store.routes.find(r => r.stops.length === {src_len});
      if (src) __app.api.loadRoute(src.id);
    }})()""")
    time.sleep(2.5)
    before_half = p.ev("__app.store.routes.length")
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.4)
    p.ev("document.getElementById('tool-copy').click()")
    time.sleep(1)
    p.ev("document.getElementById('copy-half').click()")
    grew = p.wait_for(f"__app.store.routes.length === {(before_half or 0) + 2}", 20, '절반 나누기')
    check('절반 나누기로 2개가 생김', grew,
          f'{before_half} -> {p.ev("__app.store.routes.length")}')
    check('두 구간 합이 원본과 같음', p.ev(f"""(() => {{
      const rs = __app.store.routes.filter(r => /1구간|2구간/.test(r.name));
      if (rs.length !== 2) return false;
      return rs[0].stops.length + rs[1].stops.length === {src_len};
    }})()"""))
    check('나눈 뒤 1구간이 열림', '1구간' in (p.ev("__app.route.name") or ''),
          p.ev("__app.route.name"))

    # 이 섹션이 노선을 늘리고 다른 노선을 열어둔다. 뒤 검사를 위해 원래 상태로 되돌린다.
    p.ev(f"localStorage.setItem('marathon-routes', {json.dumps(backup)})")
    p.ev('location.reload()')
    time.sleep(2)
    p.ready()
    p.ev("window.confirm = () => true; window.alert = () => {};")
    p.ev(f"""(() => {{
      const src = __app.store.routes.find(r => r.stops.length === {src_len});
      if (src) __app.api.loadRoute(src.id);
    }})()""")
    time.sleep(2)
    check('검사 후 원래 노선으로 복귀', p.ev('__app.route.stops.length') == src_len,
          p.ev('__app.route.stops.length'))

    print('\n== 실수 복구 (되돌리기 / 이어붙이기) ==')
    # 거점을 찍어 자동 채우기 -> 기존 190개에 "이어 붙이기"
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.4)
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
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.4)
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
    check('교체해도 저장본은 그대로', p.ev("""(() => {
      const saved = JSON.parse(localStorage.getItem('marathon-routes')).routes
        .find(r => r.id === __app.route.id);
      return !!saved && saved.stops.length === 190;
    })()"""))
    # 합성 이벤트를 두 번 쏘면 두 단계가 되돌려진다. 실제 키 입력으로 한 번만 보낸다.
    p.ev("document.body.focus()")
    for phase in ('rawKeyDown', 'keyUp'):
        p.send('Input.dispatchKeyEvent', {'type': phase, 'key': 'z', 'code': 'KeyZ',
                                          'windowsVirtualKeyCode': 90, 'nativeVirtualKeyCode': 90,
                                          'modifiers': 4})
    time.sleep(2)
    check('⌘Z로 190개 복원', p.ev('__app.route.stops.length') == 190, p.ev('__app.route.stops.length'))
    p.ev("document.getElementById('rename-btn').click()")   # 이름 편집 상태로
    time.sleep(0.4)
    for phase in ('rawKeyDown', 'keyUp'):
        p.send('Input.dispatchKeyEvent', {'type': phase, 'key': 'z', 'code': 'KeyZ',
                                          'windowsVirtualKeyCode': 90, 'nativeVirtualKeyCode': 90,
                                          'modifiers': 4})
    time.sleep(1)
    check('이름 편집 중에는 ⌘Z가 노선을 건드리지 않음', p.ev('__app.route.stops.length') == 190,
          p.ev('__app.route.stops.length'))
    p.ev("""document.getElementById('route-name')
           .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))""")
    time.sleep(0.4)

    print('\n== 중간에 정류장 끼우기 ==')
    # 5번과 6번 사이에 있는 정류장을 찾아 클릭했을 때 그 자리에 들어가는지
    pos = p.ev("""(() => {
      const r = __app.route.stops;
      const a = r[4], b = r[5];
      const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
      const used = new Set(r.map(s => s.id));
      let best = null, bestD = Infinity;
      for (const s of __app.stops) {
        if (used.has(s.id)) continue;
        const d = (s.lat - mid.lat) ** 2 + (s.lng - mid.lng) ** 2;
        if (d < bestD) { bestD = d; best = s; }
      }
      __app.api.toggleStop(best.id);
      return __app.route.stops.findIndex(s => s.id === best.id);
    })()""")
    time.sleep(1)
    check('빠뜨린 정류장이 5번과 6번 사이로 들어감', pos == 5, f'{pos}번째 자리')
    check('전체 191개', p.ev('__app.route.stops.length') == 191, p.ev('__app.route.stops.length'))
    check('안내 문구에 위치 표시', '사이에' in (p.ev("document.getElementById('toast').textContent") or ''),
          p.ev("document.getElementById('toast').textContent"))

    # ⊕ 로 위치를 고정했을 때는 그 자리에 강제로 들어가는지
    pinned = p.ev("""(() => {
      __app.api.setInsertPoint(0);                       // 1번 뒤에 넣기로 고정
      const used = new Set(__app.route.stops.map(s => s.id));
      const far = __app.stops.find(s => !used.has(s.id) && s.city === '인천광역시');
      __app.api.toggleStop(far.id);
      return __app.route.stops.findIndex(s => s.id === far.id);
    })()""")
    time.sleep(1)
    check('위치를 고정하면 멀리 있는 정류장도 그 자리에', pinned == 1, f'{pinned}번째 자리')
    check('고정 해제됨', p.ev('__app.insertAfter') is None, p.ev('__app.insertAfter'))

    p.ev("document.getElementById('tool-undo').click()")
    time.sleep(1)
    p.ev("document.getElementById('tool-undo').click()")
    time.sleep(1)
    check('두 번 되돌려 190개 복귀', p.ev('__app.route.stops.length') == 190,
          p.ev('__app.route.stops.length'))

    p.shot(f'{TMP}/smoke-{"mobile" if MOBILE else "desktop"}.png')
    before = p.ev("document.documentElement.dataset.theme")
    p.ev("document.getElementById('menu-btn').click()")
    time.sleep(0.5)
    p.ev("document.getElementById('theme-btn').click()")
    time.sleep(5)
    after = p.ev("document.documentElement.dataset.theme")
    p.shot(f'{TMP}/smoke-{"mobile" if MOBILE else "desktop"}-{after}.png')
    check('테마 토글', before != after and after in ('light', 'dark'), f'{before} -> {after}')
    check('테마를 눌러도 메뉴가 열려 있음', p.ev("!document.getElementById('menu').hidden"))
    check('테마 아이콘이 현재 상태를 표시',
          p.ev("document.getElementById('theme-btn').getAttribute('aria-pressed')")
          == ('true' if after == 'dark' else 'false'),
          p.ev("document.getElementById('theme-btn').getAttribute('aria-pressed')"))
    check('테마 전환 후 노선 유지', p.ev('__app.route.stops.length') == 190,
          p.ev('__app.route.stops.length'))

    print('\n== 고정 공유 링크 (?id=) ==')
    # 서버(/api/routes)가 있어야 동작한다. 로컬 정적 서버로 돌릴 때는 건너뛴다.
    has_api = p.ev("""(async () => {
      try { const r = await fetch('/api/routes', {cache:'no-store'}); return r.ok; }
      catch { return false; }
    })()""")
    target = p.ev("""(async () => {
      try {
        const d = await (await fetch('/api/routes', {cache:'no-store'})).json();
        return (d.routes[0] || {}).id || null;
      } catch { return null; }
    })()""") if has_api else None

    if not has_api:
        print('  (서버 API 없음 — 로컬 실행이라 건너뜀)')
    elif target:
        p.ev(f"location.href = location.origin + location.pathname + '?id={target}'")
        time.sleep(3)
        p.ready()
        p.wait_for("window.__app && __app.route.stops.length > 0", 40, '고정 링크')
        check('고정 링크로 노선이 열림', (p.ev('__app.route.stops.length') or 0) > 0,
              p.ev('__app.route.stops.length'))
        check('뷰어 모드로 뜸', p.ev("document.body.classList.contains('viewer')"))
        check('검색·지역 필터가 숨겨짐',
              p.ev("getComputedStyle(document.querySelector('.topbar')).display") == 'none')
        # display 값만 보면 부모가 숨겨진 경우를 놓친다. 실제로 보이는지로 판정한다.
        check('편집용 요소가 화면에 없음', p.ev("""(() => {
          const invisible = id => {
            const el = document.getElementById(id);
            if (!el) return true;
            const r = el.getBoundingClientRect();
            return el.offsetParent === null || r.width === 0 || r.height === 0;
          };
          return ['route-picker','menu-btn','btn-save','btn-share','search','tool-undo']
            .every(invisible);
        })()"""))
        check('인쇄 버튼만 남음',
              p.ev("getComputedStyle(document.getElementById('btn-print-viewer')).display") != 'none')
        check('정류장 목록은 보임',
              (p.ev("document.querySelectorAll('#list .item').length") or 0) > 0)
        check('항상 최신이라고 안내', '최신' in (p.ev("document.getElementById('viewer-badge').textContent") or ''),
              p.ev("document.getElementById('viewer-badge').textContent"))
        check('정류장 데이터는 받지 않음',
              p.ev("performance.getEntriesByType('resource').filter(r => r.name.includes('stops.json')).length") == 0)
    elif has_api:
        print('  (서버에 저장된 노선이 없어 건너뜀)')

    real_errors = [e for e in p.errors + p.eval_errors if e and 'favicon' not in str(e)]
    check('JS 예외 없음', not real_errors, real_errors[:2])
    p.close()

    print(f'\n결과: {len(ok)}개 통과 / {len(fail)}개 실패')
    if fail:
        print('실패:', ', '.join(fail))
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
