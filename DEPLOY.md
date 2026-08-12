# 라이브 배포 체크리스트

로컬에서는 이미 전부 동작한다. 실제로 띄우려면 아래 4개를 순서대로 하면 된다.
**계정·키가 필요한 단계는 사용자만 할 수 있다.** 각 단계에 누가 하는지 표시했다.

소요시간: 처음이면 20~30분. 전부 무료 티어로 가능하다.

---

## 0. 사전 확인

이 저장소에는 이미 들어있다:

- `supabase/schema.sql` — 붙여넣기만 하면 되는 스키마
- `render.yaml` — Render Blueprint (서비스 정의)
- `deploy/github-pages.yml` — Pages 자동 배포 워크플로 (아래 4번에서 설치)
- `public/config.js` — 프런트가 바라볼 API 주소

현재 CLI 인증 상태:

| | 상태 |
|---|---|
| GitHub (`gh`) | ✅ `JakesSong` 으로 인증됨 |
| Supabase CLI | ❌ 미설치 |
| Render CLI | ❌ 미설치 |

CLI 없이 웹 대시보드만으로 전부 가능하다. 아래는 대시보드 기준으로 적었다.

---

## 1. Supabase — DB 만들기 〔사용자〕

1. <https://supabase.com/dashboard> → **New project**
   - Name: `gaunde`
   - Region: **Northeast Asia (Seoul)** — 한국 사용자 기준으로 가장 빠르다
   - Database Password: 새로 만들어 안전한 곳에 보관 (아래 연결 문자열에 들어간다)
   - Plan: **Free**
2. 프로젝트가 뜨면 좌측 **SQL Editor** → `supabase/schema.sql` 내용을 통째로 붙여넣고 **Run**
   - `meetings`, `participants` 두 테이블과 인덱스, RLS 가 만들어진다
3. **Project Settings → Database → Connection string → URI** 를 복사해 둔다
   - `[YOUR-PASSWORD]` 부분을 1번에서 만든 비밀번호로 바꿀 것
   - **Connection pooling** 탭의 **Transaction** 모드 문자열(포트 `6543`)을 쓰는 걸 권한다.
     Render 무료 티어는 인스턴스가 자주 재기동되어 직접 연결(5432)보다 풀러 쪽이 안정적이다.
   - 형태: `postgresql://postgres.xxxx:비밀번호@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`

> anon key / service_role key 는 **필요 없다.** 이 앱은 브라우저에서 Supabase 를 직접 부르지 않고
> 백엔드가 Postgres 연결 문자열로만 접근한다. 그래서 `schema.sql` 은 RLS 를 켜고 정책을 하나도 만들지 않는다
> (= anon 키로는 아무것도 못 읽는 상태가 의도된 것).

---

## 2. Render — 백엔드 띄우기 〔사용자〕

1. <https://dashboard.render.com> → **New → Blueprint**
2. 이 저장소(`JakesSong/gaunde`)를 연결하면 `render.yaml` 을 읽어 `gaunde-api` 서비스를 제안한다
3. **환경변수 입력** — Blueprint 가 물어보는 값은 하나뿐이다

   | 키 | 값 |
   |---|---|
   | `DATABASE_URL` | 1-3 에서 복사한 Supabase 연결 문자열 |

   (`NODE_VERSION=22`, `PUBLIC_BASE_URL` 은 `render.yaml` 에 이미 있다)
4. **Apply** → 빌드(`npm ci`) 후 `node server/index.mjs` 로 뜬다
5. 배포되면 주소가 나온다: `https://gaunde-api.onrender.com` (이름이 겹치면 뒤에 접미사가 붙는다)
6. 확인:
   ```bash
   curl https://<실제-주소>/api/health
   # {"ok":true,"db":"postgres","stations":658}
   ```
   `"db":"postgres"` 가 나와야 Supabase 에 제대로 붙은 것이다. `sqlite` 로 나오면 `DATABASE_URL` 이 안 들어갔다.

> **무료 티어 주의** — 15분간 요청이 없으면 잠들고, 다음 첫 요청이 30~50초 걸린다.
> 수요 검증용으로는 감수할 만하지만, 링크를 뿌리기 직전에 한 번 깨워두면 첫 사용자가 덜 기다린다.

---

## 3. 프런트 — API 주소 연결 〔사용자 또는 나〕

Render 주소가 `render.yaml` 의 기본값(`https://gaunde-api.onrender.com`)과 다르면
`public/config.js` 를 고쳐야 한다.

```js
if (h.endsWith('github.io')) {
  return 'https://<실제-Render-주소>';   // ← 여기
}
```

주소를 알려주면 내가 고쳐서 푸시하겠다.

---

## 4. GitHub Pages — 프런트 띄우기 〔사용자〕

먼저 워크플로 파일을 설치해야 한다. 지금 `gh` 토큰에 `workflow` 스코프가 없어서
`deploy/github-pages.yml` 로 올려두었다. 둘 중 하나를 고르면 된다.

**방법 A — 스코프 추가 후 내가 옮기기** (권장, 10초)
```bash
gh auth refresh -s workflow
```
실행했다고 알려주면 내가 `.github/workflows/pages.yml` 로 옮겨 푸시하겠다.

**방법 B — 직접 옮기기**
```bash
mkdir -p .github/workflows
git mv deploy/github-pages.yml .github/workflows/pages.yml
git commit -m "Pages 워크플로 설치" && git push
```

그 다음:

1. 저장소 → **Settings → Pages**
2. **Source** 를 **GitHub Actions** 로 바꾼다 (기본값인 "Deploy from a branch" 아님)
3. `main` 에 푸시되면 워크플로가 `public/` 을 배포한다
   - 수동 실행: **Actions → Deploy frontend to GitHub Pages → Run workflow**
4. 완료되면 <https://jakessong.github.io/gaunde/> 에서 열린다

---

## 5. 마지막 확인

```bash
curl https://<Render-주소>/api/health          # {"ok":true,"db":"postgres",...}
```

브라우저에서 <https://jakessong.github.io/gaunde/> 를 열고:

1. 모임 이름 입력 → **링크 만들기** → 링크가 나오는지
2. 그 링크를 다른 브라우저(또는 시크릿 창)에서 열어 이름·출발역 등록
3. 2명 이상 등록 후 **결과 보기** → 중간지점과 각자 소요시간이 나오는지

CORS 오류가 나면 `public/config.js` 의 주소와 실제 Render 주소가 다른 것이다 (3번 확인).

---

## 운영 메모

- **비용** — Supabase Free(500MB), Render Free, GitHub Pages 전부 무료. 카드 등록 없이 가능하다.
- **데이터 갱신** — 새 노선이 개통하면:
  ```bash
  bash scripts/fetch-osm.sh      # OSM 원본 재수집
  npm run build:graph && npm test
  ```
  푸시하면 Render 가 자동 재배포한다. `station_id` 가 밀려도 서버가 역 이름으로 다시 찾으므로
  기존 참여 기록은 깨지지 않는다.
- **오래된 모임 정리** — `supabase/schema.sql` 맨 아래에 pg_cron 예시를 주석으로 넣어두었다.
- **기존 목업** — <https://jakessong.github.io/gaunde-mockup/> 은 그대로 둬도 되고,
  새 주소로 옮긴 뒤 리포를 아카이브해도 된다.
