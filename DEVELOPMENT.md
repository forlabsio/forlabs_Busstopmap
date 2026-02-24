# 마라톤 노선 관리 애플리케이션 - 개발 문서

## 프로젝트 개요

전국 버스 정류장 위치정보를 활용하여 마라톤 노선을 시각적으로 관리하는 웹 애플리케이션입니다.
마라톤 전단지를 붙이기 위한 정류장 위치를 찾고, 노선을 계획하고, 인쇄하여 현장에서 사용할 수 있습니다.

**개발 기간**: 2026-02-24
**개발 환경**: Single HTML File (4.6 MB)
**데이터**: 64,347개 버스 정류장 (서울/경기/인천)

---

## 주요 기능

### 1. 지도 기반 노선 관리
- 🗺️ Leaflet.js + OpenStreetMap 기반 인터랙티브 지도
- 📍 64,347개 버스 정류장 데이터 시각화
- 🎯 지역별 필터링 (서울특별시, 경기도, 인천광역시)
- 🔗 클릭으로 정류장 선택 및 노선 연결

### 2. 노선 저장 및 관리
- 💾 localStorage를 사용한 영구 저장
- 🔄 여러 노선 저장/불러오기/수정/삭제
- 📝 노선명 자동 중복 처리 (예: "노선 A" → "노선 A (2)")

### 3. 인쇄 기능 (핵심 기능)
- 📄 PDF 출력 지원
- 🗺️ 현재 지도 뷰 이미지 포함
- ✓ 정류장 목록 (순서, 정류장명, 완료 체크박스)
- 📍 선택된 마커(빨간 원) + 연결선(파란 선) 캡처

---

## 기술 스택

### Frontend
- **Leaflet.js 1.9.4**: 지도 렌더링 및 마커/폴리라인 표시
- **OpenStreetMap**: 무료 지도 타일 제공
- **Tailwind CSS 3.x**: UI 스타일링
- **PapaParse 5.x**: CSV 데이터 파싱
- **dom-to-image 2.6.0**: 지도 캡처 (SVG 지원)

### Data & Storage
- **CSV (임베디드)**: 64,347개 정류장 데이터 (4.6 MB)
- **localStorage**: 노선 데이터 영구 저장 (~50개 노선)

### Architecture
- **Single HTML File**: 모든 리소스 포함 (CSS, JS, Data)
- **Vanilla JavaScript**: 프레임워크 없이 순수 JS

---

## 개발 과정 및 트러블슈팅

### Phase 1: 초기 설정 및 기본 기능 (2026-02-24 오전)

#### 문제 1: 로딩 화면 무한 루프
**증상**: "데이터를 불러오는중..." 로딩 화면이 계속 표시됨

**원인**:
```javascript
// DOMContentLoaded에서 try-catch 블록 오류
// hideLoading()이 호출되지 않음
```

**해결**:
```javascript
document.addEventListener('DOMContentLoaded', function() {
    showLoading();
    try {
        initMap();
        allBusStopsData = parseCSVData();
        // ... 초기화 코드
        hideLoading(); // ✓ 성공 시 호출
    } catch (e) {
        console.error('초기화 오류:', e);
        hideLoading(); // ✓ 에러 시에도 호출
    }
});
```

**커밋**: `fix: add proper error handling and hideLoading calls in DOMContentLoaded`

---

### Phase 2: 인쇄 기능 구현 (2026-02-24 오후)

#### 요구사항
사용자가 현장에서 전단지를 붙이기 위해 종이로 인쇄할 수 있는 출력물 필요:
- 노선 정보 (노선명, 날짜, 정류장 수)
- 지도 이미지 (마커 + 연결선 포함)
- 정류장 목록 테이블 (순서, 정류장명, 완료 체크박스)

#### 문제 2: leaflet-image 라이브러리 누락
**증상**: `leafletImage is not defined`

**해결**:
```html
<script src="https://unpkg.com/leaflet-image@0.4.0/leaflet-image.js"></script>
```

**커밋**: `fix: add missing leaflet-image script tag`

---

#### 문제 3: 템플릿 리터럴 인코딩 오류
**증상**: `Uncaught SyntaxError: Unexpected identifier '노선명'`

**원인**:
- 한글이 포함된 템플릿 리터럴이 파일 인코딩(CP949)과 충돌
- Python regex로 코드 수정 시 발생한 인코딩 문제

**해결**: 모든 템플릿 리터럴을 문자열 연결로 변경
```javascript
// Before (에러 발생)
`노선명: ${routeName}`

// After (정상 작동)
'노선명: ' + routeName
```

**커밋**: `fix: replace all template literals with string concatenation`

---

#### 문제 4: AppState 구조 불일치
**증상**: `Cannot read properties of undefined (reading 'length')`

**원인**:
```javascript
// 잘못된 경로
AppState.selectedStops.length

// 올바른 경로
AppState.currentRoute.stops.length
```

**해결**: AppState 구조 확인 후 수정
```javascript
const AppState = {
    map: null,
    currentRegion: null,
    currentRoute: {
        id: null,
        name: "새 노선",
        stops: [] // ✓ 여기에 정류장 저장됨
    },
    savedRoutes: [],
    markers: new Map(),
    polyline: null
};
```

**커밋**: `fix: use AppState.currentRoute.stops instead of selectedStops`

---

#### 문제 5: leaflet-image가 SVG 캡처 못함
**증상**:
- 지도 타일은 캡처되지만 마커와 연결선이 안 보임
- Leaflet의 마커와 polyline은 SVG로 렌더링됨

**시도 1**: html2canvas로 교체
```javascript
html2canvas(document.getElementById('map'), {
    useCORS: true,
    allowTaint: true
})
```
**결과**: 여전히 SVG 캡처 안 됨

**시도 2**: dom-to-image로 재교체
```javascript
domtoimage.toPng(document.getElementById('map'), {
    quality: 0.95
})
```
**결과**: SVG 지원 개선되었으나 외부 마커 이미지 CORS 에러 발생

**커밋**:
- `fix: replace leaflet-image with html2canvas to capture markers and polylines`
- `fix: replace html2canvas with dom-to-image for better SVG support`

---

#### 문제 6: 마커 아이콘 CORS 에러
**증상**:
```
cannot fetch resource: https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png
ERR_INSUFFICIENT_RESOURCES
```

**원인**:
- Leaflet 기본 마커 아이콘이 외부 CDN에서 로드됨
- dom-to-image가 CORS로 인해 외부 이미지 캡처 실패

**해결**: L.marker → L.circleMarker로 변경
```javascript
// Before: 외부 이미지 필요
L.marker([lat, lng])

// After: SVG로 그려짐 (외부 리소스 불필요)
L.circleMarker([lat, lng], {
    radius: 6,
    fillColor: '#3b82f6',  // 파란색 (기본)
    color: '#1e40af',
    weight: 2,
    opacity: 1,
    fillOpacity: 0.8
})

// 선택 시 빨간색으로 변경
marker.setStyle({
    fillColor: '#ef4444',
    color: '#dc2626'
});
```

**장점**:
- ✓ CORS 문제 완전히 해결
- ✓ 외부 리소스 의존성 제거
- ✓ SVG로 그려져서 캡처 가능
- ✓ 색상으로 선택/미선택 구분 명확

**커밋**: `fix: use CircleMarker instead of Marker to avoid CORS issues`

---

### Phase 3: UI/UX 개선 (2026-02-24 저녁)

#### 문제 7: 인쇄물 테이블 정렬
**요구사항**: 출력물의 모든 내용을 가운데 정렬

**해결**:
```css
.print-table th, .print-table td {
    text-align: center; /* left → center */
}
```

```javascript
// JavaScript에서도 명시적으로 설정
cell2.style.textAlign = 'center';
```

**커밋**: `style: center-align all table content in print output`

---

#### 문제 8: 지도 뷰 자동 확대 문제
**증상**:
- 사용자가 설정한 지도 뷰와 인쇄 시 캡처되는 뷰가 다름
- `fitBounds`가 자동으로 지도를 확대/축소함

**해결**: fitBounds 제거, 현재 뷰 그대로 캡처
```javascript
// Before: 자동 확대
var bounds = L.latLngBounds(AppState.currentRoute.stops.map(...));
AppState.map.fitBounds(bounds, {padding: [50, 50]});

// After: 현재 뷰 유지
// 사용자가 직접 조정한 지도 뷰를 그대로 캡처
setTimeout(function() {
    domtoimage.toPng(document.getElementById('map'))...
}, 500);
```

**커밋**: `fix: remove fitBounds to capture current map view as-is`

---

## 최종 아키텍처

### 데이터 구조

#### AppState
```javascript
const AppState = {
    map: null,              // Leaflet Map 인스턴스
    currentRegion: null,    // 현재 선택된 지역
    allBusStops: [],        // 전체 버스 정류장 데이터
    currentRoute: {
        id: null,           // UUID
        name: "새 노선",    // 노선명
        region: null,       // 지역
        stops: [            // 선택된 정류장들
            {
                id: "GGB123000289",
                name: "가락시장역4번출구",
                lat: 37.4932333,
                lng: 127.1198
            }
        ]
    },
    savedRoutes: [],        // localStorage에 저장된 노선들
    markers: new Map(),     // 정류장번호 → L.CircleMarker 매핑
    polyline: null          // L.Polyline 인스턴스 (연결선)
};
```

#### localStorage 구조
```javascript
{
    "routes": [
        {
            "id": "uuid-1234",
            "name": "마라톤 A",
            "region": "서울특별시",
            "stops": [...],
            "createdAt": "2026-02-24T10:30:00"
        }
    ]
}
```

### 핵심 함수

#### 1. renderMarkers() - 마커 렌더링
```javascript
function renderMarkers(busStops) {
    // 기존 마커 제거
    AppState.markers.forEach(marker => marker.remove());
    AppState.markers.clear();

    // 새 마커 생성
    busStops.forEach(stop => {
        const marker = L.circleMarker([lat, lng], {...});
        marker.on('click', () => onMarkerClick(stop, marker));
        AppState.markers.set(stop.정류장번호, marker);
    });
}
```

#### 2. updatePolyline() - 연결선 업데이트
```javascript
function updatePolyline() {
    // 기존 polyline 제거
    if (AppState.polyline) {
        AppState.map.removeLayer(AppState.polyline);
    }

    // 2개 이상일 때만 선 그리기
    if (AppState.currentRoute.stops.length >= 2) {
        const latlngs = AppState.currentRoute.stops.map(s => [s.lat, s.lng]);
        AppState.polyline = L.polyline(latlngs, {
            color: 'blue',
            weight: 3,
            opacity: 0.7
        }).addTo(AppState.map);
    }
}
```

#### 3. printRoute() - 인쇄 기능
```javascript
function printRoute() {
    // 1. 테이블 내용 생성
    var tbody = document.getElementById('print-table-body');
    AppState.currentRoute.stops.forEach((stop, i) => {
        // 순서, 정류장명, 완료 체크박스
    });

    // 2. 지도 캡처 (500ms 대기 후)
    setTimeout(function() {
        domtoimage.toPng(document.getElementById('map'), {
            quality: 0.95
        }).then(function(dataUrl) {
            // 3. 이미지 설정
            document.getElementById('print-map-image').src = dataUrl;

            // 4. 인쇄 실행
            proceedToPrint();
        });
    }, 500);
}
```

---

## 사용 방법

### 1. 노선 만들기
1. 지역 선택 (서울특별시, 경기도, 인천광역시)
2. 지도에서 버스 정류장 클릭 (파란 원 → 빨간 원)
3. 파란 선으로 자동 연결됨
4. "노선 저장" 버튼 클릭 → 이름 입력

### 2. 노선 불러오기
1. "노선 선택" 드롭다운에서 선택
2. 지도에 자동으로 표시됨

### 3. 인쇄하기
1. 노선 생성 후 지도를 원하는 위치/확대 수준으로 조정
2. "📄 인쇄하기" 버튼 클릭
3. 지도 캡처 (마커 + 연결선 포함)
4. PDF로 저장 또는 직접 인쇄

**출력물 구성**:
- 노선 정보 (노선명, 날짜, 정류장 수)
- 지도 이미지
- 정류장 목록 표 (순서, 정류장명, 완료 체크박스)

---

## 제약사항 및 한계

### 1. 파일 크기
- **4.6 MB**: 서울/경기/인천 CSV 데이터 포함
- **초기 로딩 시간**: 2-4초 소요 가능

### 2. 데이터 저장
- **localStorage 사용**: 브라우저별로 독립적
- **용량**: 약 50개 노선까지 저장 가능
- **영구성**: 같은 브라우저에서만 접근, 캐시 삭제 시 소실

### 3. 구 단위 필터링 미지원
- 현재는 시 단위만 지원 (서울특별시, 경기도, 인천광역시)
- 서울특별시 구별 필터링은 미구현 (데이터에 구 정보 없음)

### 4. 브라우저 호환성
- Chrome, Firefox, Safari, Edge 최신 버전 권장
- localStorage 및 JavaScript 필수

---

## 향후 개선 아이디어

- [ ] 서울특별시 구별 필터링 (데이터 재가공 필요)
- [ ] 드래그 앤 드롭으로 정류장 순서 변경
- [ ] 노선 내보내기/가져오기 (JSON 파일)
- [ ] 정류장 검색 기능 (이름, 번호)
- [ ] 거리 계산 (총 노선 길이)
- [ ] 모바일 최적화 (터치 제스처)
- [ ] 전국 데이터 지원 (227,065개)
- [ ] 서버 기반 저장 (팀원 간 노선 공유)

---

## 커밋 히스토리

```
1cc7aa8 - style: center-align all table content in print output
152cc22 - fix: use CircleMarker instead of Marker to avoid CORS issues
ee49619 - fix: replace html2canvas with dom-to-image for better SVG support
4cab787 - fix: replace html2canvas with dom-to-image for better SVG support
ff97e29 - fix: remove fitBounds to capture current map view as-is
e58e270 - feat: zoom to selected route before capturing map image for print
39d5e12 - fix: change map.setView to AppState.map.setView
... (이전 커밋 생략)
```

---

## 라이선스

MIT License

---

## 개발자

Built with Claude Code - 2026-02-24

## 참고 자료

- [Leaflet.js Documentation](https://leafletjs.com/)
- [OpenStreetMap](https://www.openstreetmap.org/)
- [국토교통부 전국 버스정류장 위치정보](https://www.data.go.kr/data/15067528/fileData.do)
- [dom-to-image GitHub](https://github.com/tsayen/dom-to-image)
