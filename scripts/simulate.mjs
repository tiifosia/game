// 가상 플레이어 30명으로 전체 흐름을 처음부터 끝까지 검증한다.
// 사용법: (다른 터미널에서 npm run dev 실행 후)
//   HOST_PASSWORD=test1234 npm run simulate
//   BASE_URL=https://배포주소 HOST_PASSWORD=... npm run simulate   ← 배포 서버도 가능(데이터가 초기화됨!)

import assert from 'node:assert/strict';
import { AXES, computeHints, computeRoster, computeWinners, scoreGuess } from '../src/logic.js';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const PASSWORD = process.env.HOST_PASSWORD || 'test1234';
const WS_BASE = BASE.replace(/^http/, 'ws');
const PLAYERS = 30;

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// 재현 가능한 난수
let seed = 20261104;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
}
const randomType = (bias) =>
  AXES.map((ax, i) => (rand() < bias[i] ? ax.a : ax.b)).join('');

async function request(path, { method = 'GET', body, host = false, password = PASSWORD } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (host) headers.Authorization = `Bearer ${password}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const host = (action, extra = {}) => request('/api/host/action', { method: 'POST', body: { action, ...extra }, host: true });
const publicState = async () => (await request('/api/state')).data;

/** 실시간 연결 하나 = 휴대폰(또는 스크린) 한 대 */
class Client {
  constructor(label) {
    this.label = label;
    this.state = null;
    this.messages = 0;
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_BASE}/ws`);
      this.ws.addEventListener('message', (ev) => {
        if (ev.data === 'pong') return;
        const msg = JSON.parse(ev.data);
        if (msg.type !== 'state') return;
        this.messages += 1;
        this.state = msg.state;
        this.waiters = this.waiters.filter((w) => {
          if (w.pred(this.state)) {
            w.resolve(this.state);
            return false;
          }
          return true;
        });
      });
      this.ws.addEventListener('open', () => resolve(this), { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }
  waitFor(pred, ms = 5000) {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: 시간 초과`)), ms);
      this.waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
    });
  }
  close() {
    this.ws.close();
  }
}

const allSee = (clients, pred) => Promise.all(clients.map((c) => c.waitFor(pred)));
const leaks = (obj) => /"(answer|preview|letter|countA|countB|correct)"/.test(JSON.stringify(obj));

async function main() {
  console.log(`대상: ${BASE}`);

  console.log('\n[0] 진행자 보호');
  assert.equal((await request('/api/host/state', { host: true, password: 'wrong' })).status, 401);
  assert.equal((await request('/api/host/action', { method: 'POST', body: { action: 'reset' } })).status, 401);
  ok('비밀번호 없이·틀린 비밀번호로는 진행자 기능을 쓸 수 없음');

  await host('reset');
  await host('setTotal', { total: PLAYERS });
  const screen = await new Client('스크린').connect();
  const phones = await Promise.all(Array.from({ length: PLAYERS }, (_, i) => new Client(`휴대폰${i + 1}`).connect()));
  const everyone = [screen, ...phones];
  await allSee(everyone, (s) => s.phase === 'lobby' && s.total === PLAYERS);
  ok(`스크린 1대 + 휴대폰 ${PLAYERS}대 실시간 연결`);

  // 가상 플레이어: 30번은 첫 입력을 놓치고 예측만 한다. 7번은 이름에 HTML을 넣는다.
  const players = Array.from({ length: PLAYERS }, (_, i) => ({
    name: i === 6 ? '<b>민수</b>&"' : `학생${String(i + 1).padStart(2, '0')}`,
    mbti: randomType([0.55, 0.3, 0.5, 0.45]),
    guess: null,
  }));

  console.log('\n[1] 첫 번째 QR: 이름과 내 MBTI');
  await host('next');
  await allSee(everyone, (s) => s.phase === 'input' && s.entryOpen);
  ok('진행자 버튼 → 모든 화면이 입력 단계로 전환');

  const bad = await Promise.all([
    request('/api/entry', { method: 'POST', body: { name: '', mbti: 'ENFP' } }),
    request('/api/entry', { method: 'POST', body: { name: '가'.repeat(21), mbti: 'ENFP' } }),
    request('/api/entry', { method: 'POST', body: { name: '홍길동', mbti: 'EXFP' } }),
    request('/api/entry', { method: 'POST', body: { name: '홍길동' } }),
    request('/api/prediction', { method: 'POST', body: { name: '홍길동', guess: 'ENFP' } }),
  ]);
  assert.deepEqual(bad.map((r) => r.status), [400, 400, 400, 400, 400]);
  assert.deepEqual(bad.map((r) => r.data.code), ['bad_name', 'bad_name', 'bad_mbti', 'bad_mbti', 'closed']);
  ok('빈 이름·긴 이름·잘못된 MBTI·단계에 맞지 않는 제출 거부');

  const firstInputs = players.slice(0, PLAYERS - 1);
  const results = await Promise.all(
    firstInputs.map((p, i) => {
      // 3명은 처음에 다른 유형을 냈다가 나중에 고친다
      const mbti = i < 3 ? (p.mbti === 'ISTJ' ? 'ENFP' : 'ISTJ') : p.mbti;
      return request('/api/entry', { method: 'POST', body: { name: p.name, mbti } });
    }),
  );
  assert.ok(results.every((r) => r.status === 200 && r.data.ok), JSON.stringify(results.find((r) => !r.data.ok)));
  for (let i = 0; i < 3; i += 1) {
    const r = await request('/api/entry', { method: 'POST', body: { name: ` ${firstInputs[i].name} `, mbti: firstInputs[i].mbti } });
    assert.equal(r.data.updated, true);
  }
  ok(`${PLAYERS - 1}명 동시 제출, 3명은 같은 이름으로 다시 제출해 수정`);

  await allSee(everyone, (s) => s.entryCount === PLAYERS - 1);
  ok(`모든 화면에 ${PLAYERS - 1}/${PLAYERS} 실시간 반영`);

  const mbtiList = firstInputs.map((p) => p.mbti);
  const expected = computeHints(mbtiList, () => 0);
  const expectedAnswer = expected.answer;
  console.log(`    (가상 데이터 정답: ${expectedAnswer})`);

  let pub = await publicState();
  assert.ok(!leaks(pub) && pub.hints.length === 0);
  ok('입력 중 공개 상태에 집계·정답 없음');

  console.log('\n[2] 힌트 6단계');
  await host('next'); // 마감 + 힌트 1
  assert.equal((await request('/api/entry', { method: 'POST', body: { name: '늦은학생', mbti: 'ENFP' } })).data.code, 'closed');
  ok('마감 후 입력 거부');

  const hs = (await request('/api/host/state', { host: true })).data;
  assert.equal(hs.preview.answer, expectedAnswer);
  const hints = hs.preview.hints;
  assert.equal(hints[0], expected.hints[0]);
  assert.equal(hints[1], expected.hints[1]);
  assert.equal(hints[4], expected.hints[4]);
  assert.equal(hints[5], expected.hints[5]);
  // 3·4단계는 동률이면 무작위이므로 규칙을 만족하는지 확인
  const diffs = expected.axes.map((a) => Math.abs(a.countA - a.countB));
  const m3 = hints[2].match(/영역은 (.\/.)이고, (\d+)표 차이/);
  const i3 = AXES.findIndex((a) => a.axis === m3[1]);
  assert.equal(Number(m3[2]), Math.min(...diffs));
  assert.equal(diffs[i3], Math.min(...diffs));
  const m4 = hints[3].match(/영역은 (.\/.)입니다/);
  const i4 = AXES.findIndex((a) => a.axis === m4[1]);
  assert.notEqual(i3, i4);
  assert.equal(diffs[i4], Math.max(...diffs.filter((_, i) => i !== i3)));
  ok('서버 힌트가 규칙대로 계산됨');
  hints.forEach((t, i) => console.log(`    힌트 ${i + 1}: ${t}`));

  for (let step = 1; step <= 6; step += 1) {
    if (step > 1) await host('next');
    const states = await allSee(everyone, (s) => s.phase === 'hints' && s.hintStep === step);
    assert.ok(states.every((s) => s.hints.length === step && s.hints[step - 1] === hints[step - 1]));
    assert.ok(states.every((s) => !leaks(s)));
  }
  ok('힌트를 하나씩 공개, 모든 화면에 누적 반영, 정답 정보 없음');

  pub = await publicState();
  const again = (await request('/api/host/state', { host: true })).data.preview.hints;
  assert.deepEqual(again, hints);
  assert.deepEqual(pub.hints, hints);
  ok('새로고침해도 힌트가 바뀌지 않음');

  console.log('\n[3] 두 번째 QR: 우리 반 MBTI 예측');
  await host('next');
  await allSee(everyone, (s) => s.phase === 'predict' && s.predictionOpen);
  // 0~4번은 정답, 5~9번은 한 글자만 틀림, 나머지는 무작위
  const flip = { E: 'I', I: 'E', S: 'N', N: 'S', T: 'F', F: 'T', J: 'P', P: 'J' };
  const concrete = [...expectedAnswer].map((l, i) => (l === 'X' ? AXES[i].a : l)).join('');
  for (const p of players) p.guess = randomType([0.5, 0.5, 0.5, 0.5]);
  for (let i = 0; i < 5; i += 1) players[i].guess = concrete;
  for (let i = 5; i < 10; i += 1) {
    const j = i % 4;
    players[i].guess = [...concrete].map((l, k) => (k === j ? flip[l] : l)).join('');
  }

  const last = players[PLAYERS - 1];
  const unlinked = await request('/api/prediction', { method: 'POST', body: { name: last.name, guess: last.guess } });
  assert.equal(unlinked.data.code, 'confirm_unlinked');
  ok('첫 입력에 없는 이름은 확인 요청');

  const preds = await Promise.all(
    players.map((p, i) =>
      request('/api/prediction', { method: 'POST', body: { name: p.name, guess: p.guess, allowUnlinked: i === PLAYERS - 1 } }),
    ),
  );
  assert.ok(preds.every((r) => r.status === 200 && r.data.ok), JSON.stringify(preds.find((r) => !r.data.ok)));
  assert.equal(preds[PLAYERS - 1].data.linked, false);
  assert.ok(preds.slice(0, -1).every((r) => r.data.linked));
  ok(`${PLAYERS}명 동시 제출 (첫 입력을 못 한 1명 포함)`);

  for (const r of preds) assert.ok(!leaks(r.data) && !('score' in r.data));
  const dup = await request('/api/prediction', { method: 'POST', body: { name: players[0].name, guess: 'ISTJ' } });
  assert.equal(dup.data.code, 'already');
  assert.equal(dup.data.guess, players[0].guess);
  ok('같은 이름 두 번째 예측은 거부(수정 불가), 제출 응답에 정답 여부 없음');

  await allSee(everyone, (s) => s.predictionCount === PLAYERS);
  const mine = await request('/api/mine', { method: 'POST', body: { names: players.map((p) => p.name) } });
  assert.ok(!leaks(mine.data));
  pub = await publicState();
  assert.ok(!leaks(pub) && pub.reveal.length === 0 && pub.winners === null);
  ok('공개 전: 스크린·휴대폰·API 어디에도 정답과 정답 여부 없음');

  console.log('\n[4] 정답 공개');
  await host('next');
  await allSee(everyone, (s) => s.phase === 'reveal' && s.revealStep === 0 && !s.predictionOpen);
  assert.equal((await request('/api/prediction', { method: 'POST', body: { name: '늦은학생', guess: 'ENFP', allowUnlinked: true } })).data.code, 'closed');
  ok('예측 마감 후 제출 거부');

  for (let step = 1; step <= 4; step += 1) {
    await host('next');
    const states = await allSee(everyone, (s) => s.revealStep === step);
    for (const s of states) {
      assert.equal(s.reveal.length, step);
      assert.equal(s.reveal.map((r) => r.letter).join(''), expectedAnswer.slice(0, step));
      assert.equal(s.winners, null);
    }
    // 휴대폰 쪽 계산: 공개된 글자만으로 내 정답 여부와 맞힌 개수를 계산
    phones.forEach((phone, i) => {
      const s = phone.state;
      const right = s.reveal.filter((r, k) => r.letter === 'X' || r.letter === players[i].guess[k]).length;
      const truth = scoreGuess(expectedAnswer.slice(0, step) + '????', players[i].guess.slice(0, step) + '!!!!');
      assert.equal(right, truth);
    });
    const ax = states[0].reveal[step - 1];
    const correct = players.filter((p) => ax.letter === 'X' || p.guess[step - 1] === ax.letter).length;
    assert.equal(ax.correct, correct);
    ok(`${ax.axis} = ${ax.letter} (${ax.a} ${ax.countA} : ${ax.countB} ${ax.b}, ${correct}명 맞힘) → ${everyone.length}개 화면 동시 반영`);
  }

  await host('next');
  const winnerStates = await allSee(everyone, (s) => s.phase === 'winners');
  const expectedWinners = computeWinners(expectedAnswer, players.map((p) => ({ name: p.name, guess: p.guess })));
  assert.deepEqual(winnerStates[0].winners, expectedWinners);
  ok(`정답자 ${expectedWinners.names.length}명 (${expectedWinners.score}글자): ${expectedWinners.names.join(', ')}`);

  await host('next');
  const rosterStates = await allSee(everyone, (s) => s.phase === 'roster');
  const expectedRoster = computeRoster(firstInputs.map((p) => ({ name: p.name, mbti: p.mbti })));
  assert.deepEqual(rosterStates[0].roster, expectedRoster);
  assert.equal(rosterStates[0].roster.reduce((n, r) => n + r.names.length, 0), PLAYERS - 1);
  ok('유형별 명단에 첫 입력자 전원 표시');

  console.log('\n[5] 재접속 복구');
  phones[0].close();
  const back = await new Client('재접속').connect();
  const restored = await back.waitFor((s) => s.phase === 'roster');
  assert.equal(restored.roster.length, 16);
  const mineBack = await request('/api/mine', { method: 'POST', body: { names: [players[0].name] } });
  assert.deepEqual(mineBack.data.predictions, [{ name: players[0].name, guess: players[0].guess }]);
  ok('끊긴 휴대폰이 다시 접속하면 현재 단계와 내 제출 내용 복구');
  back.close();

  console.log('\n[6] 초기화');
  const beforeId = screen.state.gameId;
  await host('reset');
  const stillOpen = everyone.filter((c) => c !== phones[0]); // 1번 휴대폰은 [5]에서 끊었다
  const resetStates = await allSee(stillOpen, (s) => s.phase === 'lobby' && s.entryCount === 0);
  assert.ok(resetStates.every((s) => s.gameId !== beforeId));
  ok('초기화 → 모든 화면이 새 게임 대기 상태로 복귀');

  const totalMsgs = everyone.reduce((n, c) => n + c.messages, 0);
  everyone.forEach((c) => c.close());
  console.log(`\n모든 검증 통과: ${passed}개 (실시간 메시지 ${totalMsgs}건 수신)`);
}

main().catch((err) => {
  console.error('\n검증 실패:', err);
  process.exit(1);
});
