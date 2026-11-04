import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  axisStats,
  computeAnswer,
  computeHints,
  computeRoster,
  computeWinners,
  createState,
  hostAction,
  hostState,
  lookupMine,
  nameKey,
  normalizeMbti,
  normalizeName,
  publicState,
  scoreGuess,
  submitEntry,
  submitPrediction,
} from './reference.js';

/** "ENFP×3, ISTJ" 처럼 유형별 인원으로 입력 목록을 만든다 */
function people(spec) {
  const out = [];
  for (const [type, n] of Object.entries(spec)) for (let i = 0; i < n; i += 1) out.push(type);
  return out;
}

/** 정해진 값을 순서대로 돌려주는 난수 */
function seq(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('입력 검증', () => {
  it('이름을 정리하고 길이를 제한한다', () => {
    assert.equal(normalizeName('  홍   길동 '), '홍 길동');
    assert.equal(normalizeName('a\u0000b\u200Bc'), 'abc');
    assert.equal(normalizeName(''), null);
    assert.equal(normalizeName('   '), null);
    assert.equal(normalizeName('가'.repeat(20)), '가'.repeat(20));
    assert.equal(normalizeName('가'.repeat(21)), null);
    assert.equal(normalizeName(123), null);
    assert.equal(normalizeName('<script>'), '<script>'); // 저장은 그대로, 표시할 때 이스케이프
  });

  it('이름 키는 대소문자와 공백을 무시한다', () => {
    assert.equal(nameKey('Kim Min'), nameKey('kimmin'));
  });

  it('MBTI는 네 영역 글자만 허용한다', () => {
    assert.equal(normalizeMbti('enfp'), 'ENFP');
    assert.equal(normalizeMbti('ENF'), null);
    assert.equal(normalizeMbti('EXFP'), null);
    assert.equal(normalizeMbti('ABCD'), null);
    assert.equal(normalizeMbti(null), null);
  });
});

describe('정답 계산', () => {
  it('영역별로 더 많은 글자를 모은다', () => {
    assert.equal(computeAnswer(people({ ENFP: 3, ISTJ: 2 })), 'ENFP');
  });

  it('영역 동점이면 X로 표시한다', () => {
    // E/I 2:2, S/N 1:3, T/F 2:2, J/P 1:3
    const list = ['ENFP', 'INFP', 'ESTJ', 'INTP'];
    assert.equal(computeAnswer(list), 'XNXP');
  });

  it('X 영역은 무엇을 골라도 정답이다', () => {
    assert.equal(scoreGuess('EXFP', 'ESFP'), 4);
    assert.equal(scoreGuess('EXFP', 'ENFP'), 4);
    assert.equal(scoreGuess('EXFP', 'ISFP'), 3);
    assert.equal(scoreGuess('XXXX', 'ISTJ'), 4);
    assert.equal(scoreGuess('ENFP', 'ISTJ'), 0);
  });
});

describe('힌트 6단계', () => {
  const list = people({ ENFP: 5, ENFJ: 3, INFP: 2, ESTJ: 1, ISTP: 1 });

  it('1·2단계: 있는 유형 수와 혼자뿐인 유형 수', () => {
    const { hints, detail } = computeHints(list, () => 0);
    assert.equal(detail.presentCount, 5);
    assert.equal(detail.singleCount, 2);
    assert.equal(hints[0], '우리 반에는 16개 유형 중 5개가 있습니다.');
    assert.equal(hints[1], '혼자뿐인 유형은 2개입니다.');
  });

  it('3·4단계: 영역 이름과 표 차이만 보여 주고 어느 글자가 많은지는 숨긴다', () => {
    // E/I 9:3(6) S/N 2:10(8) T/F 2:10(8) J/P 4:8(4)
    const { hints, detail } = computeHints(list, () => 0);
    assert.equal(detail.closestAxis, 'J/P');
    assert.equal(hints[2], '가장 치열한 영역은 J/P이고, 4표 차이입니다.');
    assert.equal(hints[3], `가장 압도적인 영역은 ${detail.dominantAxis}입니다.`);
    // 영역 이름을 빼면 어떤 MBTI 글자도 남지 않는다
    assert.doesNotMatch(hints[2].replace(detail.closestAxis, ''), /[EISNTFJP]/);
    assert.doesNotMatch(hints[3].replace(detail.dominantAxis, ''), /[EISNTFJP]|\d/);
  });

  it('5·6단계: 0명인 유형은 빼고, 인원수는 보여 주지 않는다', () => {
    const { hints } = computeHints(list, () => 0);
    assert.equal(hints[4], '가장 적은 유형은 ISTP, ESTJ입니다.');
    assert.equal(hints[5], '가장 많은 유형은 ENFP입니다.');
    assert.doesNotMatch(hints[4] + hints[5], /\d/);
  });

  it('최소·최대 유형이 여러 개면 모두 보여 준다', () => {
    const { detail, hints } = computeHints(people({ INTJ: 1, ESFP: 1, ENFP: 4, ISTJ: 4, INFJ: 2 }), () => 0);
    assert.deepEqual(detail.fewest, ['INTJ', 'ESFP']);
    assert.deepEqual(detail.most, ['ISTJ', 'ENFP']);
    assert.equal(hints[4], '가장 적은 유형은 INTJ, ESFP입니다.');
    assert.equal(hints[5], '가장 많은 유형은 ISTJ, ENFP입니다.');
  });

  it('모든 유형 인원이 같으면 최소와 최대가 같은 목록이다', () => {
    const { detail } = computeHints(['ENFP', 'ISTJ'], () => 0);
    assert.deepEqual(detail.fewest, ['ISTJ', 'ENFP']);
    assert.deepEqual(detail.most, ['ISTJ', 'ENFP']);
  });

  it('3단계 동률이면 동률 영역 중에서만 무작위로 고른다', () => {
    // E/I 3:3(0) S/N 3:3(0) T/F 6:0(6) J/P 5:1(4)
    const list2 = ['ESTJ', 'ESTJ', 'ENTJ', 'ISTJ', 'INTJ', 'INTP'];
    const stats = axisStats(list2).map((s) => s.diff);
    assert.deepEqual(stats, [0, 0, 6, 4]);
    const seen = new Set();
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const { detail } = computeHints(list2, seq(r, 0));
      assert.ok(['E/I', 'S/N'].includes(detail.closestAxis));
      assert.equal(detail.closestDiff, 0);
      seen.add(detail.closestAxis);
    }
    assert.deepEqual([...seen].sort(), ['E/I', 'S/N']);
  });

  it('4단계는 3단계 영역을 제외하고 가장 큰 차이를 고른다', () => {
    // E/I 0, S/N 0 동률 → 3단계가 E/I면 4단계는 T/F(6)
    const list2 = ['ESTJ', 'ESTJ', 'ENTJ', 'ISTJ', 'INTJ', 'INTP'];
    const { detail } = computeHints(list2, seq(0, 0));
    assert.equal(detail.closestAxis, 'E/I');
    assert.equal(detail.dominantAxis, 'T/F');
  });

  it('4단계 동률이면 3단계 영역이 아닌 동률 영역 중에서 무작위로 고른다', () => {
    // E/I 4:0(4) S/N 0:4(4) T/F 2:2(0) J/P 3:1(2)
    const list2 = ['ENTJ', 'ENFJ', 'ENTP', 'ENFJ'];
    assert.deepEqual(axisStats(list2).map((s) => s.diff), [4, 4, 0, 2]);
    const seen = new Set();
    for (const r of [0, 0.49, 0.5, 0.99]) {
      const { detail } = computeHints(list2, seq(0, r));
      assert.equal(detail.closestAxis, 'T/F');
      assert.ok(['E/I', 'S/N'].includes(detail.dominantAxis));
      seen.add(detail.dominantAxis);
    }
    assert.deepEqual([...seen].sort(), ['E/I', 'S/N']);
  });

  it('네 영역 차이가 모두 같아도 3단계와 4단계는 다른 영역이다', () => {
    // 모든 영역 2:2
    const list2 = ['ESTJ', 'INFP', 'ESTJ', 'INFP'];
    for (let i = 0; i < 200; i += 1) {
      const { detail } = computeHints(list2);
      assert.notEqual(detail.closestAxis, detail.dominantAxis);
    }
  });

  it('3단계 영역이 가장 큰 차이를 가져도 4단계에 다시 나오지 않는다', () => {
    // 모든 영역 차이 4 → 3단계에서 뽑힌 영역은 4단계 후보에서 빠져야 한다
    const list2 = ['ESTJ', 'ESTJ', 'ESTJ', 'ESTJ'];
    for (const r of [0, 0.3, 0.6, 0.9]) {
      const { detail } = computeHints(list2, seq(r, r));
      assert.notEqual(detail.closestAxis, detail.dominantAxis);
    }
  });

  it('입력이 없어도 오류 없이 힌트를 만든다', () => {
    const { hints, answer } = computeHints([], () => 0);
    assert.equal(hints.length, 6);
    assert.equal(answer, 'XXXX');
  });
});

describe('정답자', () => {
  it('네 글자 정답자를 고른다', () => {
    const w = computeWinners('ENFP', [
      { name: '나', guess: 'ENFP' },
      { name: '가', guess: 'ENFP' },
      { name: '다', guess: 'ENFJ' },
    ]);
    assert.deepEqual(w, { score: 4, names: ['가', '나'] });
  });

  it('네 글자 정답자가 없으면 세 글자 정답자를 보여 준다', () => {
    const w = computeWinners('ENFP', [
      { name: '가', guess: 'ENFJ' },
      { name: '나', guess: 'ISTJ' },
      { name: '다', guess: 'INFP' },
    ]);
    assert.deepEqual(w, { score: 3, names: ['가', '다'] });
  });

  it('세 글자 정답자도 없으면 빈 목록', () => {
    assert.deepEqual(computeWinners('ENFP', [{ name: '가', guess: 'ISTJ' }]), { score: 0, names: [] });
  });

  it('X 영역은 정답자 판정에서 모두 맞은 것으로 친다', () => {
    const w = computeWinners('EXFP', [
      { name: '가', guess: 'ESFP' },
      { name: '나', guess: 'ENFP' },
    ]);
    assert.deepEqual(w.names, ['가', '나']);
    assert.equal(w.score, 4);
  });

  it('유형별 명단은 16개 유형을 모두 담는다', () => {
    const r = computeRoster([
      { name: '나', mbti: 'ENFP' },
      { name: '가', mbti: 'ENFP' },
    ]);
    assert.equal(r.length, 16);
    assert.deepEqual(r.find((x) => x.type === 'ENFP').names, ['가', '나']);
  });
});

describe('게임 진행과 공개 범위', () => {
  function playToHints() {
    const s = createState(5);
    hostAction(s, { action: 'next' }); // input
    submitEntry(s, { name: '가', mbti: 'ENFP' });
    submitEntry(s, { name: '나', mbti: 'ENFJ' });
    submitEntry(s, { name: '다', mbti: 'INFP' });
    return s;
  }

  it('마감 전에는 같은 이름으로 다시 제출해 수정할 수 있다', () => {
    const s = playToHints();
    const r = submitEntry(s, { name: '가', mbti: 'ISTJ' });
    assert.equal(r.updated, true);
    assert.equal(Object.keys(s.entries).length, 3);
    assert.equal(s.entries[nameKey('가')].mbti, 'ISTJ');
  });

  it('마감 후에는 입력할 수 없고, 힌트는 마감 때 한 번만 계산된다', () => {
    const s = playToHints();
    hostAction(s, { action: 'closeEntry' }, () => 0);
    const saved = JSON.stringify(s.computed);
    assert.throws(() => submitEntry(s, { name: '라', mbti: 'ISTJ' }), { code: 'closed' });
    hostAction(s, { action: 'next' }, () => 0.99); // hints, 다시 계산하지 않음
    assert.equal(JSON.stringify(s.computed), saved);
    assert.equal(s.hintStep, 1);
  });

  it('공개 전에는 상태에 정답·집계가 들어가지 않는다', () => {
    const s = playToHints();
    hostAction(s, { action: 'next' }); // 마감 + 힌트 1
    let pub = publicState(s);
    assert.equal(pub.hints.length, 1);
    const text = JSON.stringify(pub);
    assert.doesNotMatch(text, /answer|countA|preview/);
    for (let i = 0; i < 5; i += 1) hostAction(s, { action: 'next' });
    assert.equal(publicState(s).hints.length, 6);
    hostAction(s, { action: 'next' }); // predict
    submitPrediction(s, { name: '가', guess: 'ENFP' });
    pub = publicState(s);
    assert.equal(pub.phase, 'predict');
    assert.deepEqual(pub.reveal, []);
    assert.equal(pub.winners, null);
    assert.equal(pub.roster, null);
    assert.doesNotMatch(JSON.stringify(pub), /answer|letter|countA|guess/);

    hostAction(s, { action: 'next' }); // reveal 0
    pub = publicState(s);
    assert.equal(pub.revealStep, 0);
    assert.deepEqual(pub.reveal, []);
    hostAction(s, { action: 'next' }); // E/I
    pub = publicState(s);
    assert.equal(pub.reveal.length, 1);
    assert.equal(pub.reveal[0].letter, 'E');
    assert.equal(pub.winners, null);
  });

  it('예측은 1인 1회이며 수정할 수 없다', () => {
    const s = playToHints();
    for (let i = 0; i < 7; i += 1) hostAction(s, { action: 'next' });
    assert.equal(s.phase, 'predict');
    submitPrediction(s, { name: '가', guess: 'ENFP' });
    assert.throws(() => submitPrediction(s, { name: ' 가 ', guess: 'ISTJ' }), (e) => e.code === 'already' && e.extra.guess === 'ENFP');
    assert.equal(s.predictions[nameKey('가')].guess, 'ENFP');
  });

  it('첫 입력에 없는 이름은 확인을 거쳐 제출할 수 있다', () => {
    const s = playToHints();
    for (let i = 0; i < 7; i += 1) hostAction(s, { action: 'next' });
    assert.throws(() => submitPrediction(s, { name: '새친구', guess: 'ENFP' }), { code: 'confirm_unlinked' });
    const r = submitPrediction(s, { name: '새친구', guess: 'ENFP', allowUnlinked: true });
    assert.equal(r.linked, false);
    const linked = submitPrediction(s, { name: '나', guess: 'ENFP' });
    assert.equal(linked.linked, true);
  });

  it('내 기록 조회는 정답 정보를 담지 않는다', () => {
    const s = playToHints();
    for (let i = 0; i < 7; i += 1) hostAction(s, { action: 'next' });
    submitPrediction(s, { name: '가', guess: 'ISTJ' });
    const mine = lookupMine(s, ['가', '없는사람']);
    assert.deepEqual(mine, { entries: [{ name: '가', mbti: 'ENFP' }], predictions: [{ name: '가', guess: 'ISTJ' }] });
  });

  it('끝까지 진행하면 정답자와 유형별 명단이 공개된다', () => {
    const s = playToHints();
    for (let i = 0; i < 7; i += 1) hostAction(s, { action: 'next' });
    submitPrediction(s, { name: '가', guess: 'ENFP' });
    submitPrediction(s, { name: '나', guess: 'ENFJ' });
    hostAction(s, { action: 'next' }); // reveal 0
    for (let i = 0; i < 4; i += 1) hostAction(s, { action: 'next' });
    // 가 ENFP, 나 ENFJ, 다 INFP → E 2:1, N 3:0, F 3:0, P 2:1
    assert.equal(publicState(s).reveal.map((r) => r.letter).join(''), 'ENFP');
    assert.deepEqual(publicState(s).reveal.map((r) => r.correct), [2, 2, 2, 1]);
    hostAction(s, { action: 'next' }); // winners
    assert.deepEqual(publicState(s).winners, { score: 4, names: ['가'] });
    assert.equal(publicState(s).roster, null);
    hostAction(s, { action: 'next' }); // roster
    assert.equal(publicState(s).roster.length, 16);
    assert.throws(() => hostAction(s, { action: 'next' }), { code: 'invalid' });
  });

  it('초기화하면 총인원만 남기고 새 게임이 된다', () => {
    const s = playToHints();
    hostAction(s, { action: 'setTotal', total: 31 });
    const oldId = s.gameId;
    hostAction(s, { action: 'reset' });
    assert.equal(s.phase, 'lobby');
    assert.equal(s.total, 31);
    assert.deepEqual(s.entries, {});
    assert.notEqual(s.gameId, oldId);
    assert.throws(() => hostAction(s, { action: 'setTotal', total: 0 }), { code: 'bad_total' });
  });

  it('입력을 다시 열었다가 마감하면 새 데이터로 다시 계산한다', () => {
    const s = playToHints();
    hostAction(s, { action: 'closeEntry' }, () => 0);
    assert.equal(s.computed.entryCount, 3);
    hostAction(s, { action: 'reopenEntry' });
    submitEntry(s, { name: '라', mbti: 'ISTJ' });
    hostAction(s, { action: 'next' }, () => 0);
    assert.equal(s.computed.entryCount, 4);
  });

  it('진행자 상태에만 미리보기가 있다', () => {
    const s = playToHints();
    hostAction(s, { action: 'next' });
    assert.ok(hostState(s).preview.answer);
    assert.equal(publicState(s).preview, undefined);
  });
});
