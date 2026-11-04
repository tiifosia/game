# 우리 반 MBTI 추리

수업 참여자 전원(약 30명)이 휴대폰으로 함께하는 5분짜리 자기소개 게임입니다.
전원이 입력한 MBTI로 "우리 반 MBTI"를 만들고, 스크린의 힌트 6개를 보며 추리해 맞힙니다.

배포 주소(예: `https://tiifosia.github.io/game/`) 아래에 네 화면이 있습니다.

| 주소 | 용도 | 어디에 띄우나 |
|---|---|---|
| `screen/` | **진행 화면**: QR·인원·힌트·결과 + 아래쪽 진행자 조작 바 | 노트북 화면을 그대로 프로젝터에 미러링 (1920×1080) |
| `host/` | (선택) 따로 쓰는 진행자 화면: 입력자 명단, 정답 미리보기 | 휴대폰 등 프로젝터에 안 비치는 기기 |
| `me/` | 첫 번째 QR: 이름과 내 MBTI | 학생 휴대폰 |
| `guess/` | 두 번째 QR: 우리 반 MBTI 예측 | 학생 휴대폰 |

QR 코드는 접속한 주소를 바탕으로 스크린에서 자동으로 만들어집니다.

## 구조

**GitHub Pages(화면) + Supabase(데이터·실시간)** — 이전 프로젝트(generated-world)와 같은 방식입니다.

- 게임 규칙(힌트 계산, 채점, 단계 전환, 진행자 비밀번호 확인)은 모두 `supabase/schema.sql`의 Postgres 함수가 처리합니다.
- 원본 데이터 테이블은 RLS로 막혀 있어 접속자가 읽거나 쓸 수 없습니다. 접속자는 `mbti_*` RPC 함수로만 제출합니다.
- 화면에 보여도 되는 내용만 `mbti_live` 테이블 두 줄에 담아 Supabase Realtime으로 내보냅니다.
  - `state`: 진행 단계, 공개된 힌트, 공개된 글자 → 스크린·휴대폰 모두 구독
  - `counts`: 입력·제출 인원 → 스크린·진행자만 구독 (휴대폰은 안 받아서 실시간 메시지 사용량이 적음)
- 정답과 정답 여부는 공개 단계가 되기 전까지 어떤 API 응답이나 실시간 메시지에도 들어가지 않습니다. 휴대폰은 공개된 글자와 내 예측을 비교해 정답 여부를 표시합니다.
- 실시간 연결이 끊기면 3초마다 상태를 직접 가져오고, 다시 연결되면 자동으로 맞춥니다. 새로고침해도 현재 단계로 돌아옵니다.
- 이름은 화면에 항상 텍스트로만 넣어(`textContent`) HTML로 해석되지 않습니다.

```
supabase/schema.sql   테이블·권한·게임 규칙 함수 (SQL Editor에서 한 번 실행)
public/               배포되는 화면 (screen / host / me / guess)
.github/workflows/    main에 올리면 GitHub Pages로 자동 배포
test/                 힌트·채점 테스트, SQL 함수 테스트
scripts/simulate.mjs  가상 플레이어 30명 전체 흐름 검증 (실제 Realtime 사용)
```

## 배포하기 (처음 한 번)

### 1. Supabase 프로젝트 만들기
1. https://supabase.com/dashboard 에서 **New project** 를 누릅니다.
   - 이름: 아무거나 (예: `mbti-class-game`)
   - Database Password: 아무거나 (이 게임에서는 쓰지 않음)
   - Region: **Northeast Asia (Seoul)**
2. 프로젝트가 준비되면 왼쪽 **SQL Editor** → **New query** 에 `supabase/schema.sql` 내용을 전부 붙여 넣고 **Run**.
3. 같은 SQL Editor에서 진행자 비밀번호를 정합니다. 따옴표 안을 바꿔서 실행하세요.
   ```sql
   select public.mbti_set_host_password('원하는-비밀번호');
   ```
4. **Project Settings → API Keys** (또는 상단 **Connect**)에서 두 값을 복사해 둡니다.
   - Project URL (`https://xxxx.supabase.co`)
   - Publishable key (`sb_publishable_...`) 또는 Legacy의 `anon` key

### 2. GitHub 설정
1. 저장소 **Settings → Secrets and variables → Actions → New repository secret** 에 두 개를 등록합니다.
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = Publishable key(또는 anon key)
2. 저장소 **Settings → Pages → Build and deployment → Source** 를 **GitHub Actions** 로 바꿉니다.
3. 이 브랜치를 `main`에 합칩니다. **Actions** 탭에서 배포가 끝나면 주소는 `https://tiifosia.github.io/game/` 입니다.

이후 `main`에 새 커밋을 올리면 자동으로 다시 배포됩니다. `schema.sql`을 고쳤다면 SQL Editor에서 다시 한 번 실행하면 됩니다(데이터는 유지).

> **무료 플랜 주의:** Supabase 무료 프로젝트는 7일 동안 사용이 없으면 일시 정지됩니다. 수업 전날 리허설을 하면서 대시보드에서 프로젝트가 **Active** 인지 확인하고, 정지돼 있으면 **Restore** 를 누르세요.

## 수업 당일 진행

1. 노트북을 프로젝터에 연결하고 화면을 **미러링(복제)** 합니다.
2. `screen/` 을 열고 전체 화면(F11, 맥은 `Ctrl+Cmd+F`)으로 만듭니다.
3. 오른쪽 아래 **진행자 로그인** 을 눌러 비밀번호를 넣으면, 화면 아래에 조작 바가 생깁니다. (한 번 로그인하면 이 브라우저에서는 기억합니다.)
4. 조작 바에서 **총인원** 을 실제 인원으로 맞춥니다. 가운데 숫자를 누르면 바로 입력할 수 있고, − / + 로 하나씩 바꿀 수도 있습니다.
5. 오른쪽 보라색 버튼(또는 → / Space / PageDown, 발표용 리모컨 가능)으로 진행합니다.
6. 조작 바를 화면에서 치우고 싶으면 **숨기기** 또는 `H` 키. 숨겨도 키보드·리모컨으로 계속 진행할 수 있고, `H` 를 다시 누르면 나타납니다.

조작 바에는 학생에게 보여도 되는 내용(다음 단계 이름, 총인원, 마감·초기화 버튼)만 있습니다. 정답 미리보기와 입력자 명단은 `host/` 에서만 볼 수 있으니, 필요하면 휴대폰으로 `host/` 를 따로 여세요.

| 단계 | 진행자 버튼 | 스크린 |
|---|---|---|
| 대기 | 게임 시작 · 첫 번째 QR 띄우기 | 제목 (QR은 이 버튼을 누르면 나타남) |
| 1 내 MBTI | 입력 마감하고 힌트 1 공개 | 첫 번째 QR, 입력 인원 |
| 2 힌트 | 힌트 2~6 공개 → 두 번째 QR 띄우기 | 힌트 누적 |
| 3 예측 | 예측 마감하고 정답 공개 화면으로 | 두 번째 QR, 제출 인원, 힌트 목록 |
| 4 정답 | E/I → S/N → T/F → J/P 결과 공개 → 정답자 발표 → 유형별 명단 | 글자별 결과, 정답자, 전원 명단 |

- 전원이 입력하지 않아도 마감할 수 있습니다. 실수로 마감했다면 힌트로 넘어가기 전에 **입력 다시 열기** 를 누르면 됩니다.
- 정답과 힌트 6개를 미리 보고 싶으면 휴대폰으로 `host/` 를 열어 **진행자 미리보기** 를 펼치세요. 프로젝터에 비추지 마세요.

### 수업 전 데이터 초기화

리허설 데이터는 수업 전에 꼭 지워 주세요.

1. 진행 화면 조작 바의 **초기화** (또는 `host/` 맨 아래 **게임 초기화**) → 확인 창에 `초기화` 입력.
2. 모든 입력·예측·결과가 지워지고, 스크린과 학생 휴대폰도 자동으로 대기 화면으로 돌아갑니다(휴대폰에 남아 있던 이전 기록도 함께 지워짐). 총인원 설정은 유지됩니다.

진행자 화면에 들어갈 수 없을 때는 Supabase SQL Editor에서 비밀번호를 다시 정할 수 있습니다(3번 단계 명령).

## 게임 규칙 요약

- 이름이 같으면 같은 사람으로 봅니다(동명이인 없음 전제, 대소문자·띄어쓰기는 무시).
- 첫 번째 입력은 마감 전까지 같은 이름으로 다시 제출하면 수정됩니다.
- 예측은 1인 1회, 제출 후 수정할 수 없습니다. 첫 입력에 없는 이름이면 확인을 한 번 더 받은 뒤 제출합니다(첫 입력을 놓친 사람도 참여 가능).
- 한 휴대폰으로 여러 명이 제출할 수 있고, 그 휴대폰에서 각자의 결과를 볼 수 있습니다.
- 힌트는 입력을 마감할 때 한 번 계산해 저장하므로 새로고침해도 바뀌지 않습니다.
- 영역이 동점이면 그 글자는 X이고, 무엇을 골라도 정답입니다.
- 네 글자 정답자가 없으면 세 글자 정답자를 발표합니다.

## 배포 후 자동 점검

`main`에 올라가면 GitHub Actions가 배포한 뒤 **verify** 단계에서 다음을 확인합니다(데이터는 바꾸지 않음).
- 실제 Supabase 프로젝트의 게임 함수가 모두 정상 응답하는지, `mbti_live`가 Realtime에 등록됐는지, 진행자 비밀번호가 설정됐는지
- 휴대폰과 같은 방식으로 Realtime 구독이 준비되는지
- 배포된 페이지(`screen/`, `me/`, `guess/` 등)가 모두 열리는지

verify가 빨간색이면 Actions 로그의 `FAIL` 줄에 원인과 할 일이 적혀 있습니다. `schema.sql`이 바뀐 뒤에는 SQL Editor에서 다시 한 번 실행해야 합니다.

## 개발과 테스트

```bash
npm install
```

```bash
npm test
```
힌트·채점 기준 구현 테스트입니다. `DATABASE_URL`(Postgres 슈퍼유저 주소)을 주면 `schema.sql` 함수도 실제 DB에서 검증합니다(임시 DB를 만들었다 지움). SQL 힌트 계산이 기준 구현과 무작위 데이터 500개에서 완전히 같은지도 확인합니다.

```bash
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_KEY=<publishable key> npm run serve
```
`public/`을 http://localhost:8080 으로 띄웁니다. (`public/config.example.js` 를 `config.js` 로 복사해 값을 넣어도 됩니다.)

```bash
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_KEY=<publishable key> HOST_PASSWORD=<진행자 비밀번호> npm run simulate
```
가상 플레이어 30명 + 스크린 1대가 실제 Realtime에 연결해 처음부터 끝까지 검증합니다. 인원은 `PLAYERS=20` 처럼 바꿀 수 있습니다. **게임 데이터를 초기화**하므로 수업 중에는 실행하지 마세요. 리허설 때 한 번 돌려 보고, 끝나면 그대로 대기 상태가 됩니다.

외부 라이브러리 `public/vendor/qrcode.js`(qrcode-generator, MIT)와 `public/vendor/supabase.js`(@supabase/supabase-js 2.118.0 UMD, MIT)는 파일로 포함되어 있습니다.
