# 공강밋 (Gonggang-Meet)

팀플 회의시간 잡기가 힘든 대학생을 위한 웹 서비스.
각자 **수업 시간표만 입력하면**, 팀 전원이 겹치는 공강을 자동 계산해 회의 시간 Top 3를 추천한다.

## 실행 방법

```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8377
# 브라우저에서 http://127.0.0.1:8377 접속
```

## 사용 흐름

1. 팀 이름 입력 → 방 생성 → 고유 링크 발급 (`/r/<랜덤토큰>`)
2. 링크를 팀 단톡에 공유
3. 각자 닉네임 입력 후, 주간 그리드(월~금 09:00~21:00, 30분 단위)에 **수업 시간을 드래그로 칠하고** 저장
4. 전원 공강 히트맵 + 60분 이상 연속 공강 기준 **추천 회의시간 Top 3** 자동 표시
5. 같은 닉네임으로 다시 저장하면 시간표 수정

## 기술 스택

- **백엔드**: Python 3.12, FastAPI, uvicorn
- **DB**: SQLite (파일 1개, `gonggang.db` — .gitignore 처리됨)
- **프론트**: 바닐라 HTML/CSS/JS (빌드 도구 없음)

## 프로젝트 구조

```
gonggang-meet/
├── BLUEPRINT.md        # 시장조사·BM·보안·MVP 범위 블루프린트
├── README.md
├── requirements.txt
├── .gitignore
└── app/
    ├── main.py         # FastAPI 앱: 방/시간표 API + 공강 교집합·추천 알고리즘
    └── static/
        ├── index.html  # 랜딩(방 생성)
        ├── room.html   # 방 페이지(그리드·히트맵·추천)
        ├── room.js     # 드래그 입력, 렌더링(XSS-safe textContent)
        └── style.css
```

## 보안 노트

- SQLite 파라미터 바인딩만 사용 (SQL 인젝션 방어)
- 닉네임/방제목 서버측 검증 (길이·문자 화이트리스트), 슬롯 인덱스 범위 검증
- 유저 입력은 항상 `textContent`로 렌더링 (XSS 방어)
- 방 ID는 `secrets.token_urlsafe(8)` — 추측 불가능한 링크
- 전역 예외 핸들러로 스택트레이스 등 내부 정보 비노출
- 수집 데이터: 닉네임(가명 가능) + 시간표 슬롯뿐 (최소 수집)
