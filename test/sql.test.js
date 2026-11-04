// supabase/schema.sql 의 함수를 실제 PostgreSQL에서 검증한다.
// DATABASE_URL(슈퍼유저)이 있을 때만 돌고, 매번 임시 데이터베이스를 만들었다가 지운다.
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { computeHints, computeRoster, computeWinners, scoreGuess, TYPES } from './reference.js';

const URL_ = process.env.DATABASE_URL;
const SCHEMA = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const PW = 'test-pass';

const skip = !URL_ && 'DATABASE_URL이 없어 SQL 테스트를 건너뜁니다';

let admin;
let sql;
let dbName;

before(async () => {
  if (skip) return;
  admin = postgres(URL_, { max: 1, onnotice: () => {} });
  dbName = `mbti_test_${Date.now()}`;
  await admin.unsafe(`create database ${dbName}`);
  await admin.unsafe(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$`);
  const u = new URL(URL_);
  u.pathname = `/${dbName}`;
  sql = postgres(u.href, { max: 1, onnotice: () => {} });
  await sql.unsafe(SCHEMA);
  await sql.unsafe(SCHEMA); // 두 번 실행해도 안전해야 한다
  // Supabase는 기본으로 anon에게 테이블 권한을 준다. 같은 조건에서 RLS가 막는지 확인한다
  await sql.unsafe('grant usage on schema public to anon, authenticated; grant all on all tables in schema public to anon, authenticated');
  await sql`select public.mbti_set_host_password(${PW})`;
});

after(async () => {
  if (skip) return;
  await sql.end();
  await admin.unsafe(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

// 접속자(anon) 권한으로 RPC 호출
async function call(fn, args = {}) {
  const keys = Object.keys(args);
  const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const values = keys.map((k) => args[k]); // jsonb 인자는 드라이버가 직렬화한다
  return sql.begin(async (tx) => {
    await tx.unsafe('set local role anon');
    const [row] = await tx.unsafe(`select public.${fn}(${params}) as r`, values);
    return row.r;
  });
}
const host = (action, extra = {}) => call('mbti_host_action', { pw: PW, action, total: extra.total ?? null });
const state = () => call('mbti_state');

function seq(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

async function sqlHints(list, r3, r4) {
  const [row] = await sql`select public.mbti_compute_hints(${list}::text[], ${r3}, ${r4}) as r`;
  return row.r;
}

function people(spec) {
  const out = [];
  for (const [type, n] of Object.entries(spec)) for (let i = 0; i < n; i += 1) out.push(type);
  return out;
}

describe('SQL 힌트 계산 = 기준 구현', { skip }, () => {
  it('무작위 데이터 500개에서 힌트·정답이 기준 구현과 완전히 같다', async () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let n = 0; n < 500; n += 1) {
      const size = Math.floor(rand() * 41);
      // 동률이 자주 나오도록 유형을 적게 쓰는 경우도 섞는다
      const pool = rand() < 0.4 ? TYPES.slice(0, 1 + Math.floor(rand() * 4)) : TYPES;
      const list = Array.from({ length: size }, () => pool[Math.floor(rand() * pool.length)]);
      const r3 = rand();
      const r4 = rand();
      const expected = computeHints(list, seq(r3, r4));
      const got = await sqlHints(list, r3, r4);
      assert.deepEqual(got, expected, `데이터: ${list.join(',')} r3=${r3} r4=${r4}`);
    }
  });

  it('영역 동점은 X', async () => {
    assert.equal((await sqlHints(['ENFP', 'INFP', 'ESTJ', 'INTP'], 0, 0)).answer, 'XNXP');
  });

  it('3단계 동률은 동률 영역 중에서만, 4단계는 3단계 영역을 뺀 최대 차이', async () => {
    const list = ['ESTJ', 'ESTJ', 'ENTJ', 'ISTJ', 'INTJ', 'INTP']; // 차이 [0,0,6,4]
    const seen = new Set();
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const { detail } = await sqlHints(list, r, 0);
      assert.ok(['E/I', 'S/N'].includes(detail.closestAxis));
      assert.equal(detail.dominantAxis, 'T/F');
      seen.add(detail.closestAxis);
    }
    assert.equal(seen.size, 2);
  });

  it('4단계 동률이면 동률 영역 중에서 무작위', async () => {
    const list = ['ENTJ', 'ENFJ', 'ENTP', 'ENFJ']; // 차이 [4,4,0,2]
    const seen = new Set();
    for (const r of [0, 0.49, 0.5, 0.99]) {
      const { detail } = await sqlHints(list, 0, r);
      assert.equal(detail.closestAxis, 'T/F');
      seen.add(detail.dominantAxis);
    }
    assert.deepEqual([...seen].sort(), ['E/I', 'S/N']);
  });

  it('네 영역 차이가 모두 같아도 3·4단계는 다른 영역', async () => {
    for (const r of [0, 0.3, 0.6, 0.9]) {
      const { detail } = await sqlHints(['ESTJ', 'INFP', 'ESTJ', 'INFP'], r, r);
      assert.notEqual(detail.closestAxis, detail.dominantAxis);
    }
  });

  it('최소·최대 유형이 여러 개면 모두, 인원수 없이', async () => {
    const { hints } = await sqlHints(people({ INTJ: 1, ESFP: 1, ENFP: 4, ISTJ: 4, INFJ: 2 }), 0, 0);
    assert.equal(hints[4], '가장 적은 유형은 INTJ, ESFP입니다.');
    assert.equal(hints[5], '가장 많은 유형은 ISTJ, ENFP입니다.');
  });

  it('입력이 없어도 오류 없이 계산', async () => {
    const r = await sqlHints([], 0.5, 0.5);
    assert.equal(r.answer, 'XXXX');
    assert.equal(r.hints.length, 6);
  });

  it('채점은 기준 구현과 같다 (X는 모두 정답)', async () => {
    for (const [a, g] of [['EXFP', 'ESFP'], ['EXFP', 'ISFP'], ['XXXX', 'ISTJ'], ['ENFP', 'ISTJ'], ['ENFP', 'ENFJ']]) {
      const [row] = await sql`select public.mbti_score(${a}, ${g}) as s`;
      assert.equal(row.s, scoreGuess(a, g));
    }
  });
});

describe('schema.sql 파일', () => {
  it('복사·붙여 넣기로 깨질 수 있는 보이지 않는 문자가 없다', () => {
    const bad = [...SCHEMA].filter((c) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(c) && c !== '\n' && c !== '\t' && c !== '\r');
    const spaces = [...SCHEMA].filter((c) => /\p{Zs}/u.test(c) && c !== ' ');
    assert.deepEqual([...bad, ...spaces].map((c) => c.codePointAt(0).toString(16)), []);
  });
});

describe('SQL 입력 검증', { skip }, () => {
  it('이름 정리와 길이 제한', async () => {
    const cases = [
      ['  홍   길동 ', '홍 길동'],
      ['a\u0001b\u200Bc', 'abc'],
      ['   ', null],
      ['가'.repeat(20), '가'.repeat(20)],
      ['가'.repeat(21), null],
      ['<script>', '<script>'],
      [`김\u00A0민수\u3000`, '김 민수'],
      ['\uFEFF이\u2028름\u00AD', '이름'],
    ];
    for (const [raw, want] of cases) {
      const [row] = await sql`select public.mbti_norm_name(${raw}) as n`;
      assert.equal(row.n, want, raw);
    }
  });
});

describe('SQL 게임 진행과 공개 범위 (접속자 권한)', { skip }, () => {
  it('접속자는 테이블을 직접 읽거나 쓸 수 없고, 내부 함수도 못 부른다', async () => {
    const asAnon = (q) =>
      sql.begin(async (tx) => {
        await tx.unsafe('set local role anon');
        return tx.unsafe(q);
      });
    for (const t of ['mbti_game', 'mbti_entries', 'mbti_predictions', 'mbti_secret']) {
      assert.equal((await asAnon(`select * from public.${t}`)).length, 0, t);
    }
    assert.equal((await asAnon('select * from public.mbti_live')).length, 2);
    await assert.rejects(asAnon("insert into public.mbti_entries (key, name, mbti) values ('x', 'x', 'ENFP')"), /row-level security/);
    assert.equal((await asAnon("update public.mbti_live set data = '{}' returning id")).length, 0);
    for (const q of ["select public.mbti_set_host_password('x1234')", 'select public.mbti_publish(true)', 'select public.mbti_close_entries()']) {
      await assert.rejects(sql.begin(async (tx) => {
        await tx.unsafe('set local role anon');
        await tx.unsafe(q);
      }), /permission denied/);
    }
  });

  it('비밀번호가 틀리면 진행자 조작 불가', async () => {
    const r = await call('mbti_host_action', { pw: 'wrong', action: 'reset', total: null });
    assert.equal(r.code, 'unauthorized');
  });

  it('처음부터 끝까지', async () => {
    await host('reset');
    await host('setTotal', { total: 5 });
    assert.equal((await call('mbti_submit_entry', { name: '가', mbti: 'ENFP' })).code, 'closed');
    await host('next'); // input

    assert.equal((await call('mbti_submit_entry', { name: '', mbti: 'ENFP' })).code, 'bad_name');
    assert.equal((await call('mbti_submit_entry', { name: '가', mbti: 'EXFP' })).code, 'bad_mbti');
    await call('mbti_submit_entry', { name: '가', mbti: 'ISTJ' });
    const upd = await call('mbti_submit_entry', { name: ' 가 ', mbti: 'enfp' });
    assert.deepEqual([upd.ok, upd.updated, upd.mbti], [true, true, 'ENFP']);
    await call('mbti_submit_entry', { name: '나', mbti: 'ENFJ' });
    await call('mbti_submit_entry', { name: '다', mbti: 'INFP' });
    let st = await state();
    assert.equal(st.entryCount, 3);
    assert.doesNotMatch(JSON.stringify(st), /answer|countA|preview|ENFP/);

    await host('next'); // 마감 + 힌트 1
    st = await state();
    assert.equal(st.hints.length, 1);
    assert.equal((await call('mbti_submit_entry', { name: '라', mbti: 'ISTJ' })).code, 'closed');
    const hs = await call('mbti_host_state', { pw: PW });
    assert.equal(hs.preview.answer, 'ENFP');
    const before = JSON.stringify(hs.preview.hints);
    for (let i = 0; i < 5; i += 1) await host('next');
    st = await state();
    assert.equal(JSON.stringify(st.hints), before); // 다시 계산되지 않음
    assert.equal(st.hintStep, 6);

    await host('next'); // predict
    assert.equal((await call('mbti_submit_prediction', { name: '새친구', guess: 'ENFP', allow_unlinked: false })).code, 'confirm_unlinked');
    const un = await call('mbti_submit_prediction', { name: '새친구', guess: 'ISTJ', allow_unlinked: true });
    assert.equal(un.linked, false);
    const p1 = await call('mbti_submit_prediction', { name: '가', guess: 'ENFP', allow_unlinked: false });
    assert.equal(p1.linked, true);
    const dup = await call('mbti_submit_prediction', { name: '가', guess: 'ISTJ', allow_unlinked: false });
    assert.deepEqual([dup.code, dup.guess], ['already', 'ENFP']);
    await call('mbti_submit_prediction', { name: '나', guess: 'ENFJ', allow_unlinked: false });
    st = await state();
    assert.equal(st.predictionCount, 3);
    assert.deepEqual(st.reveal, []);
    assert.equal(st.winners, null);
    assert.doesNotMatch(JSON.stringify(st), /answer|letter|countA|guess/);
    const mine = await call('mbti_mine', { names: ['가', '없는사람'] });
    assert.deepEqual(mine.entries, [{ name: '가', mbti: 'ENFP' }]);
    assert.deepEqual(mine.predictions, [{ name: '가', guess: 'ENFP' }]);
    assert.doesNotMatch(JSON.stringify(mine), /answer|letter|score/);

    await host('next'); // reveal 0
    st = await state();
    assert.equal(st.predictionOpen, false);
    assert.deepEqual(st.reveal, []);
    assert.equal((await call('mbti_submit_prediction', { name: '다', guess: 'ENFP', allow_unlinked: false })).code, 'closed');
    for (let i = 1; i <= 4; i += 1) {
      await host('next');
      st = await state();
      assert.equal(st.reveal.length, i);
      assert.equal(st.winners, null);
    }
    assert.equal(st.reveal.map((r) => r.letter).join(''), 'ENFP');
    // 새친구 ISTJ, 가 ENFP, 나 ENFJ
    assert.deepEqual(st.reveal.map((r) => r.correct), [2, 2, 2, 1]);

    await host('next'); // winners
    st = await state();
    const preds = [{ name: '새친구', guess: 'ISTJ' }, { name: '가', guess: 'ENFP' }, { name: '나', guess: 'ENFJ' }];
    assert.deepEqual(st.winners, computeWinners('ENFP', preds));
    assert.equal(st.roster, null);

    await host('next'); // roster
    st = await state();
    assert.deepEqual(st.roster, computeRoster([{ name: '가', mbti: 'ENFP' }, { name: '나', mbti: 'ENFJ' }, { name: '다', mbti: 'INFP' }]));
    assert.equal((await host('next')).code, 'invalid');

    const oldId = st.gameId;
    await host('reset');
    st = await state();
    assert.deepEqual([st.phase, st.entryCount, st.predictionCount, st.total], ['lobby', 0, 0, 5]);
    assert.notEqual(st.gameId, oldId);
  });

  it('세 글자 정답자 / 정답자 없음', async () => {
    await host('reset');
    await host('next');
    for (const [n, m] of [['a', 'ENFP'], ['b', 'ENFP'], ['c', 'ENFJ']]) await call('mbti_submit_entry', { name: n, mbti: m });
    for (let i = 0; i < 7; i += 1) await host('next');
    await call('mbti_submit_prediction', { name: 'a', guess: 'ENFJ', allow_unlinked: false });
    await call('mbti_submit_prediction', { name: 'b', guess: 'ISTJ', allow_unlinked: false });
    for (let i = 0; i < 6; i += 1) await host('next');
    const st = await state();
    assert.equal(st.phase, 'winners');
    assert.deepEqual(st.winners, { score: 3, names: ['a'] });
  });

  it('입력을 다시 열고 마감하면 새 데이터로 다시 계산', async () => {
    await host('reset');
    await host('next');
    await call('mbti_submit_entry', { name: 'a', mbti: 'ENFP' });
    await host('closeEntry');
    assert.equal((await call('mbti_host_state', { pw: PW })).preview.answer, 'ENFP');
    await host('reopenEntry');
    assert.equal((await call('mbti_host_state', { pw: PW })).preview, null);
    await call('mbti_submit_entry', { name: 'b', mbti: 'ISTJ' });
    await host('next');
    assert.equal((await call('mbti_host_state', { pw: PW })).preview.answer, 'XXXX');
    assert.equal((await host('setTotal', { total: 0 })).code, 'bad_total');
  });
});
