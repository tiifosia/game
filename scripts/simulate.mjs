// 가상 플레이어 30명으로 전체 흐름을 처음부터 끝까지 검증한다.
// 휴대폰 30대 + 스크린 1대가 각자 Supabase Realtime에 연결해 실시간 반영을 확인한다.
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_KEY=<anon 또는 publishable key> HOST_PASSWORD=<진행자 비밀번호> npm run simulate
// 주의: 게임 데이터를 초기화하므로 수업 중에는 실행하지 마세요.

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { AXES, computeHints, computeRoster, computeWinners, scoreGuess } from '../test/reference.js';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const PASSWORD = process.env.HOST_PASSWORD;
const PLAYERS = 30;
if (!URL_ || !KEY || !PASSWORD) {
  console.error('SUPABASE_URL, SUPABASE_KEY, HOST_PASSWORD 환경 변수를 넣어 주세요.');
  process.exit(1);
}
const newClient = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const api = newClient();

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

async function rpc(fn, args = {}) {
  const { data, error } = await api.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
const entry = (name, mbti) => rpc('mbti_submit_entry', { name, mbti });
const predict = (name, guess, allowUnlinked = false) => rpc('mbti_submit_prediction', { name, guess, allow_unlinked: allowUnlinked });
const host = (action, extra = {}) => rpc('mbti_host_action', { pw: PASSWORD, action, total: extra.total ?? null });
const hostState = () => rpc('mbti_host_state', { pw: PASSWORD });
const publicState = () => rpc('mbti_state');

/** Realtime 연결 하나 = 휴대폰(또는 스크린) 한 대. 실제 화면과 같은 방식으로 구독한다 */
class Client {
  constructor(label, withCounts) {
    this.label = label;
    this.withCounts = withCounts;
    this.state = {};
    this.messages = 0;
    this.waiters = [];
    this.db = newClient();
  }
  async connect() {
    Object.assign(this.state, await publicState());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: Realtime 연결 실패`)), 15000);
      this.channel = this.db
        .channel(`sim-${this.label}`)
        .on(
          'postgres_changes',
          this.withCounts
            ? { event: '*', schema: 'public', table: 'mbti_live' }
            : { event: '*', schema: 'public', table: 'mbti_live', filter: 'id=eq.state' },
          (payload) => {
            this.messages += 1;
            Object.assign(this.state, payload.new.data);
            this.check();
          },
        )
        // Realtime이 DB 변경 구독까지 마쳤다는 신호를 받으면 준비 완료
        .on('system', {}, (p) => {
          if (p.extension === 'postgres_changes' && p.status === 'ok') {
            clearTimeout(timer);
            resolve();
          } else if (p.status === 'error') {
            console.log(`    ${this.label} system:`, JSON.stringify(p));
          }
        })
        .subscribe((status, err) => {
          if (status !== 'SUBSCRIBED' && status !== 'CLOSED') console.log(`    ${this.label} 상태: ${status} ${err?.message || ''}`);
        });
    });
    return this;
  }
  check() {
    this.waiters = this.waiters.filter((w) => {
      if (w.pred(this.state)) {
        w.resolve({ ...this.state });
        return false;
      }
      return true;
    });
  }
  waitFor(pred, ms = 10000) {
    if (pred(this.state)) return Promise.resolve({ ...this.state });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: 실시간 반영 시간 초과`)), ms);
      this.waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
    });
  }
  async close() {
    await this.db.removeAllChannels();
  }
}

const allSee = (clients, pred) => Promise.all(clients.map((c) => c.waitFor(pred)));
const leaks = (obj) => /"(answer|preview|letter|countA|countB|correct)"/.test(JSON.stringify(obj));

async function main() {
  console.log(`대상: ${URL_}`);

  console.log('\n[0] 진행자 보호');
  assert.equal((await rpc('mbti_host_state', { pw: 'wrong' })).code, 'unauthorized');
  assert.equal((await rpc('mbti_host_action', { pw: 'wrong', action: 'reset', total: null })).code, 'unauthorized');
  for (const t of ['mbti_game', 'mbti_entries', 'mbti_predictions', 'mbti_secret']) {
    const { data } = await api.from(t).select('*');
    assert.equal((data || []).length, 0, t);
  }
  ok('틀린 비밀번호로는 진행자 기능 불가, 접속자는 원본 테이블을 읽을 수 없음');

  await host('reset');
  await host('setTotal', { total: PLAYERS });
  const screen = await new Client('스크린', true).connect();
  const phones = await Promise.all(Array.from({ length: PLAYERS }, (_, i) => new Client(`휴대폰${i + 1}`, false).connect()));
  const everyone = [screen, ...phones];
  ok(`스크린 1대 + 휴대폰 ${PLAYERS}대 Realtime 연결`);

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
    entry('', 'ENFP'),
    entry('가'.repeat(21), 'ENFP'),
    entry('홍길동', 'EXFP'),
    entry('홍길동', null),
    predict('홍길동', 'ENFP'),
  ]);
  assert.deepEqual(bad.map((r) => r.code), ['bad_name', 'bad_name', 'bad_mbti', 'bad_mbti', 'closed']);
  ok('빈 이름·긴 이름·잘못된 MBTI·단계에 맞지 않는 제출 거부');

  const firstInputs = players.slice(0, PLAYERS - 1);
  const phoneMsgsBefore = phones.reduce((n, c) => n + c.messages, 0);
  const results = await Promise.all(
    firstInputs.map((p, i) => entry(p.name, i < 3 ? (p.mbti === 'ISTJ' ? 'ENFP' : 'ISTJ') : p.mbti)),
  );
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.find((r) => !r.ok)));
  for (let i = 0; i < 3; i += 1) {
    const r = await entry(` ${firstInputs[i].name} `, firstInputs[i].mbti);
    assert.equal(r.updated, true);
  }
  ok(`${PLAYERS - 1}명 동시 제출, 3명은 같은 이름으로 다시 제출해 수정`);

  await screen.waitFor((s) => s.entryCount === PLAYERS - 1);
  ok(`스크린에 ${PLAYERS - 1}/${PLAYERS} 실시간 반영`);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(phones.reduce((n, c) => n + c.messages, 0), phoneMsgsBefore);
  ok('휴대폰은 인원 변화 메시지를 받지 않음 (Realtime 사용량 절약)');

  const mbtiList = firstInputs.map((p) => p.mbti);
  const expected = computeHints(mbtiList, () => 0);
  const expectedAnswer = expected.answer;
  console.log(`    (가상 데이터 정답: ${expectedAnswer})`);

  let pub = await publicState();
  assert.ok(!leaks(pub) && pub.hints.length === 0);
  ok('입력 중 공개 상태에 집계·정답 없음');

  console.log('\n[2] 힌트 6단계');
  await host('next');
  assert.equal((await entry('늦은학생', 'ENFP')).code, 'closed');
  ok('마감 후 입력 거부');

  const hs = await hostState();
  assert.equal(hs.preview.answer, expectedAnswer);
  const hints = hs.preview.hints;
  for (const i of [0, 1, 4, 5]) assert.equal(hints[i], expected.hints[i]);
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
  assert.deepEqual((await hostState()).preview.hints, hints);
  assert.deepEqual(pub.hints, hints);
  ok('새로고침해도 힌트가 바뀌지 않음');

  console.log('\n[3] 두 번째 QR: 우리 반 MBTI 예측');
  await host('next');
  await allSee(everyone, (s) => s.phase === 'predict' && s.predictionOpen);
  const flip = { E: 'I', I: 'E', S: 'N', N: 'S', T: 'F', F: 'T', J: 'P', P: 'J' };
  const concrete = [...expectedAnswer].map((l, i) => (l === 'X' ? AXES[i].a : l)).join('');
  for (const p of players) p.guess = randomType([0.5, 0.5, 0.5, 0.5]);
  for (let i = 0; i < 5; i += 1) players[i].guess = concrete;
  for (let i = 5; i < 10; i += 1) players[i].guess = [...concrete].map((l, k) => (k === i % 4 ? flip[l] : l)).join('');

  const last = players[PLAYERS - 1];
  assert.equal((await predict(last.name, last.guess)).code, 'confirm_unlinked');
  ok('첫 입력에 없는 이름은 확인 요청');

  const preds = await Promise.all(players.map((p, i) => predict(p.name, p.guess, i === PLAYERS - 1)));
  assert.ok(preds.every((r) => r.ok), JSON.stringify(preds.find((r) => !r.ok)));
  assert.equal(preds[PLAYERS - 1].linked, false);
  assert.ok(preds.slice(0, -1).every((r) => r.linked));
  ok(`${PLAYERS}명 동시 제출 (첫 입력을 못 한 1명 포함)`);

  for (const r of preds) assert.ok(!leaks(r) && !('score' in r));
  const dup = await predict(players[0].name, 'ISTJ');
  assert.equal(dup.code, 'already');
  assert.equal(dup.guess, players[0].guess);
  ok('같은 이름 두 번째 예측은 거부(수정 불가), 제출 응답에 정답 여부 없음');

  await screen.waitFor((s) => s.predictionCount === PLAYERS);
  const mine = await rpc('mbti_mine', { names: players.map((p) => p.name) });
  assert.ok(!leaks(mine));
  pub = await publicState();
  assert.ok(!leaks(pub) && pub.reveal.length === 0 && pub.winners === null);
  const { data: liveRows } = await api.from('mbti_live').select('*');
  assert.ok(!leaks(liveRows));
  ok('공개 전: 스크린·휴대폰·API·Realtime 테이블 어디에도 정답과 정답 여부 없음');

  console.log('\n[4] 정답 공개');
  await host('next');
  await allSee(everyone, (s) => s.phase === 'reveal' && s.revealStep === 0 && !s.predictionOpen);
  assert.equal((await predict('늦은학생', 'ENFP', true)).code, 'closed');
  ok('예측 마감 후 제출 거부');

  for (let step = 1; step <= 4; step += 1) {
    const t0 = Date.now();
    await host('next');
    const states = await allSee(everyone, (s) => s.revealStep === step);
    const ms = Date.now() - t0;
    for (const st of states) {
      assert.equal(st.reveal.length, step);
      assert.equal(st.reveal.map((r) => r.letter).join(''), expectedAnswer.slice(0, step));
      assert.equal(st.winners, null);
    }
    phones.forEach((phone, i) => {
      const st = phone.state;
      const right = st.reveal.filter((r, k) => r.letter === 'X' || r.letter === players[i].guess[k]).length;
      const truth = scoreGuess(expectedAnswer.slice(0, step) + '????', players[i].guess.slice(0, step) + '!!!!');
      assert.equal(right, truth);
    });
    const ax = states[0].reveal[step - 1];
    const correct = players.filter((p) => ax.letter === 'X' || p.guess[step - 1] === ax.letter).length;
    assert.equal(ax.correct, correct);
    ok(`${ax.axis} = ${ax.letter} (${ax.a} ${ax.countA} : ${ax.countB} ${ax.b}, ${correct}명 맞힘) → ${everyone.length}개 화면 ${ms}ms 안에 반영`);
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
  ok('유형별 명단에 첫 입력자 전원 표시');

  console.log('\n[5] 재접속 복구');
  await phones[0].close();
  const back = await new Client('재접속', false).connect();
  assert.equal(back.state.phase, 'roster');
  const mineBack = await rpc('mbti_mine', { names: [players[0].name] });
  assert.deepEqual(mineBack.predictions, [{ name: players[0].name, guess: players[0].guess }]);
  ok('끊긴 휴대폰이 다시 접속하면 현재 단계와 내 제출 내용 복구');
  await back.close();

  console.log('\n[6] 초기화');
  const beforeId = screen.state.gameId;
  await host('reset');
  const stillOpen = everyone.filter((c) => c !== phones[0]);
  const resetStates = await allSee(stillOpen, (s) => s.phase === 'lobby' && s.gameId !== beforeId);
  assert.ok(resetStates.every((s) => s.reveal.length === 0));
  await screen.waitFor((s) => s.entryCount === 0 && s.predictionCount === 0);
  ok('초기화 → 모든 화면이 새 게임 대기 상태로 복귀');

  const totalMsgs = everyone.reduce((n, c) => n + c.messages, 0);
  await Promise.all(stillOpen.map((c) => c.close()));
  console.log(`\n모든 검증 통과: ${passed}개 (Realtime 메시지 ${totalMsgs}건 수신)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n검증 실패:', err);
  process.exit(1);
});
