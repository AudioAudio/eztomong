# 랭킹 서버 배포 안내 (Cloudflare Workers + D1)

토몽이와 이지의 방 온라인 랭킹 서버입니다. Cloudflare 무료 플랜으로 충분합니다
(Workers 하루 10만 요청, D1 하루 읽기 500만·쓰기 10만).

> 한 번만 하면 됩니다. 15분 정도 걸려요. 명령은 **이 폴더(`server/rank-worker`)에서** 실행합니다.

## 0. 준비물
- Cloudflare 계정 (https://dash.cloudflare.com 무료 가입)
- Node.js 18 이상 (https://nodejs.org 에서 LTS 설치) — 설치 후 터미널(Windows는 PowerShell)에서 `node -v` 로 확인

## 1. 이 폴더로 이동해서 도구 설치
```
git clone https://github.com/AudioAudio/eztomong.git
cd eztomong/server/rank-worker
npm install
```

## 2. Cloudflare 로그인
```
npx wrangler login
```
브라우저가 열리면 **Allow** 를 누르세요.

## 3. 데이터베이스 만들기
```
npx wrangler d1 create tomong-rank
```
출력에 나오는 `database_id = "xxxxxxxx-xxxx-..."` 값을 복사해서, 이 폴더의 `wrangler.toml` 안
`database_id = "REPLACE_WITH_DATABASE_ID"` 의 따옴표 안에 붙여 넣고 저장합니다.

## 4. 표 만들기
```
npx wrangler d1 execute tomong-rank --remote --file=schema.sql
```

## 5. 관리자 비밀번호 넣기 (기록 삭제용)
```
npx wrangler secret put ADMIN_TOKEN
```
물어보면 아무도 모를 긴 문자열(예: 영문+숫자 30자)을 입력합니다. **따로 적어 두세요.**

## 6. 배포
```
npx wrangler deploy
```
마지막에 `https://tomong-rank.<계정이름>.workers.dev` 주소가 나옵니다.
브라우저로 `그주소/api/health` 를 열어 `{"ok":true}` 가 보이면 성공입니다.

## 7. 게임에 연결
이 주소를 개발 쪽(Claude)에 알려 주면 게임 설정에 넣고 다시 배포합니다.
직접 하려면 `js/config.js` 의 `rankServer: { url: '' ...` 따옴표 안에 주소를 넣으면 됩니다.

---

## 운영
### 기록 지우기 (부적절한 닉네임 등)
PowerShell:
```
Invoke-RestMethod -Method Delete -Uri "https://tomong-rank.<계정이름>.workers.dev/api/admin/entry?name=지울닉네임" -Headers @{Authorization="Bearer <ADMIN_TOKEN>"}
```
macOS/Linux:
```
curl -X DELETE "https://tomong-rank.<계정이름>.workers.dev/api/admin/entry?name=지울닉네임" -H "Authorization: Bearer <ADMIN_TOKEN>"
```

### 랭킹 전체 초기화 (시즌 리셋 등)
```
npx wrangler d1 execute tomong-rank --remote --command "DELETE FROM scores"
```

### 게임 주소가 바뀌면
`wrangler.toml` 의 `ALLOWED_ORIGINS` 에 새 주소(예: `https://내도메인.com`)를 쉼표로 추가하고 `npx wrangler deploy` 다시 실행.

### 금지어 추가
`src/index.js` 위쪽 `BAD_WORDS` 목록에 추가하고 `npx wrangler deploy`.

## 규칙 요약
- 닉네임당 최고 기록 1개 (더 높은 점수일 때만 갱신)
- 닉네임은 처음 등록한 기기만 사용 가능 (다른 기기에서 같은 닉네임 → "이미 다른 사람이 쓰고 있는 닉네임이에요")
- 닉네임: 1~10자, 한글·영문·숫자·일부 기호, 기본 금지어 차단
- 점수 1~99,999,999, 최고 진화 단계와 점수가 맞지 않으면 거절
- 같은 기기 5초에 1번, 같은 IP 10분에 30번까지 등록
- 서버에 연결이 안 되면 게임은 이 기기 랭킹을 보여주고, 등록은 기기에 저장했다가 다음에 자동으로 다시 보냄

## API
| 요청 | 설명 |
|---|---|
| `GET /api/health` | 서버 확인 |
| `GET /api/top?limit=10` | 상위 기록 |
| `GET /api/rank?score=N` | 이 점수의 예상 순위 |
| `GET /api/me?name=닉네임` | 닉네임의 최고 기록·순위 |
| `POST /api/submit` `{name, score, maxTier, device}` | 등록 |
| `DELETE /api/admin/entry?name=닉네임` | 삭제 (관리자 토큰) |

로컬 시험: `npm run db:init:local` → `npm run dev` (http://127.0.0.1:8787)
