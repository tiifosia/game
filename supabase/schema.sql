-- 우리 반 MBTI 추리: Supabase 설정
-- SQL Editor에 이 파일 전체를 붙여 넣고 Run. 여러 번 실행해도 안전합니다(게임 데이터는 유지).
-- 실행한 뒤에는 아래 한 줄로 진행자 비밀번호를 정하세요(따옴표 안을 바꿔서 SQL Editor에서 실행).
--   select public.mbti_set_host_password('원하는-비밀번호');
--
-- 구조
--   mbti_game        : 진행 단계와 마감 때 계산한 힌트·정답 (접속자는 읽을 수 없음)
--   mbti_entries     : 이름과 내 MBTI (접속자는 읽을 수 없음)
--   mbti_predictions : 우리 반 MBTI 예측 (접속자는 읽을 수 없음)
--   mbti_secret      : 진행자 비밀번호 해시 (접속자는 읽을 수 없음)
--   mbti_live        : 화면에 보여도 되는 내용만 담은 두 줄('state', 'counts'). 누구나 읽기 + Realtime
-- 접속자는 테이블에 직접 쓰지 못하고, 아래 mbti_* RPC 함수로만 제출합니다.
-- 정답과 정답 여부는 공개 단계가 되기 전까지 mbti_live와 RPC 응답 어디에도 들어가지 않습니다.

-- ---------------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------------
create table if not exists public.mbti_game (
  id              integer primary key default 1 check (id = 1),
  game_id         text not null,
  phase           text not null default 'lobby'
                  check (phase in ('lobby', 'input', 'hints', 'predict', 'reveal', 'winners', 'roster')),
  total           integer not null default 30 check (total between 1 and 500),
  entry_open      boolean not null default false,
  prediction_open boolean not null default false,
  hint_step       integer not null default 0,
  reveal_step     integer not null default 0,
  computed        jsonb,
  version         bigint not null default 1
);

create table if not exists public.mbti_entries (
  key  text primary key,
  name text not null,
  mbti text not null check (mbti ~ '^[EI][SN][TF][JP]$'),
  at   timestamptz not null default clock_timestamp()
);

create table if not exists public.mbti_predictions (
  key    text primary key,
  name   text not null,
  guess  text not null check (guess ~ '^[EI][SN][TF][JP]$'),
  linked boolean not null,
  at     timestamptz not null default clock_timestamp()
);

create table if not exists public.mbti_secret (
  id   integer primary key default 1 check (id = 1),
  salt text not null,
  hash text not null
);

create table if not exists public.mbti_live (
  id   text primary key check (id in ('state', 'counts')),
  data jsonb not null
);

insert into public.mbti_game (id, game_id)
values (1, substr(md5(random()::text || clock_timestamp()::text), 1, 16))
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. 권한: 모든 테이블에 RLS. 누구나 읽을 수 있는 건 mbti_live 뿐
-- ---------------------------------------------------------------------------
alter table public.mbti_game        enable row level security;
alter table public.mbti_entries     enable row level security;
alter table public.mbti_predictions enable row level security;
alter table public.mbti_secret      enable row level security;
alter table public.mbti_live        enable row level security;

drop policy if exists "anyone can read live" on public.mbti_live;
create policy "anyone can read live" on public.mbti_live for select using (true);

-- ---------------------------------------------------------------------------
-- 3. 규칙 함수 (내부용)
-- ---------------------------------------------------------------------------
create or replace function public.mbti_types() returns text[]
language sql immutable as $$
  select array['ISTJ','ISFJ','INFJ','INTJ','ISTP','ISFP','INFP','INTP',
               'ESTP','ESFP','ENFP','ENTP','ESTJ','ESFJ','ENFJ','ENTJ'];
$$;

create or replace function public.mbti_axes() returns jsonb
language sql immutable as $$
  select '[{"axis":"E/I","a":"E","b":"I"},{"axis":"S/N","a":"S","b":"N"},
           {"axis":"T/F","a":"T","b":"F"},{"axis":"J/P","a":"J","b":"P"}]'::jsonb;
$$;

create or replace function public.mbti_err(code text, message text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('ok', false, 'code', code, 'message', message);
$$;

-- 이름 정리: 제어·서식 문자 제거, 공백 정리, 1~20자. 유효하지 않으면 null
create or replace function public.mbti_norm_name(raw text) returns text
language sql stable as $$
  select case when char_length(n) between 1 and 20 then n end
  from (
    select btrim(regexp_replace(
             regexp_replace(normalize(coalesce(raw, ''), NFC),
               '[\u0001-\u001F\u007F-\u009F­​-‏ -‮⁠-⁤﻿]', '', 'g'),
             '[\s 　]+', ' ', 'g')) as n
  ) s;
$$;

-- 동명이인이 없다는 전제에서 이름을 식별하는 키 (대소문자·띄어쓰기 무시)
create or replace function public.mbti_key(name text) returns text
language sql immutable as $$
  select regexp_replace(lower(name), '[\s 　]', '', 'g');
$$;

create or replace function public.mbti_norm_type(raw text) returns text
language sql immutable as $$
  select case when upper(btrim(coalesce(raw, ''))) ~ '^[EI][SN][TF][JP]$' then upper(btrim(raw)) end;
$$;

-- 동률 후보에서 하나 고르기 (r: 0 이상 1 미만의 난수)
create or replace function public.mbti_pick(n integer, r double precision) returns integer
language sql immutable as $$
  select least(n, floor(r * n)::integer + 1);
$$;

-- 입력 마감 때 한 번만 호출해 힌트 6개와 정답을 계산한다.
-- r3, r4 는 3·4단계 동률을 무작위로 고를 때 쓰는 난수(테스트에서 고정값을 넣는다).
create or replace function public.mbti_compute_hints(mbtis text[], r3 double precision, r4 double precision)
returns jsonb language plpgsql immutable as $$
declare
  types   text[] := public.mbti_types();
  axes    jsonb  := public.mbti_axes();
  list    text[] := coalesce(mbtis, '{}');
  counts  integer[] := array_fill(0, array[16]);
  present text[] := '{}';
  singles integer := 0;
  diffs   integer[] := '{}';
  ax_out  jsonb := '[]';
  answer  text := '';
  m text; i integer; ca integer; cb integer; letter text;
  cand integer[]; c3 integer; c4 integer; min_d integer; max_d integer;
  min_c integer; max_c integer; fewest text[] := '{}'; most text[] := '{}';
  t text;
begin
  foreach m in array list loop
    i := array_position(types, m);
    counts[i] := counts[i] + 1;
  end loop;

  for i in 1..16 loop
    if counts[i] > 0 then present := present || types[i]; end if;
    if counts[i] = 1 then singles := singles + 1; end if;
  end loop;

  -- 영역별 표
  for i in 1..4 loop
    select count(*) filter (where substr(x, i, 1) = axes->(i-1)->>'a'),
           count(*) filter (where substr(x, i, 1) <> axes->(i-1)->>'a')
      into ca, cb
      from unnest(list) as x;
    letter := case when ca > cb then axes->(i-1)->>'a' when cb > ca then axes->(i-1)->>'b' else 'X' end;
    answer := answer || letter;
    diffs := diffs || abs(ca - cb);
    ax_out := ax_out || jsonb_build_object('axis', axes->(i-1)->>'axis', 'a', axes->(i-1)->>'a',
                                           'b', axes->(i-1)->>'b', 'countA', ca, 'countB', cb, 'letter', letter);
  end loop;

  -- 3단계: 표 차이가 가장 작은 영역 (동률이면 무작위)
  select min(d) into min_d from unnest(diffs) d;
  select array_agg(o order by o) into cand from unnest(diffs) with ordinality u(d, o) where d = min_d;
  c3 := cand[public.mbti_pick(array_length(cand, 1), r3)];

  -- 4단계: 3단계 영역을 뺀 나머지 중 표 차이가 가장 큰 영역 (동률이면 무작위)
  select max(d) into max_d from unnest(diffs) with ordinality u(d, o) where o <> c3;
  select array_agg(o order by o) into cand from unnest(diffs) with ordinality u(d, o) where o <> c3 and d = max_d;
  c4 := cand[public.mbti_pick(array_length(cand, 1), r4)];

  -- 5·6단계: 0명인 유형은 제외
  if array_length(present, 1) > 0 then
    select min(counts[array_position(types, p)]), max(counts[array_position(types, p)])
      into min_c, max_c from unnest(present) p;
    foreach t in array present loop
      if counts[array_position(types, t)] = min_c then fewest := fewest || t; end if;
      if counts[array_position(types, t)] = max_c then most := most || t; end if;
    end loop;
  end if;

  return jsonb_build_object(
    'hints', jsonb_build_array(
      format('우리 반에는 16개 유형 중 %s개가 있습니다.', coalesce(array_length(present, 1), 0)),
      format('혼자뿐인 유형은 %s개입니다.', singles),
      format('가장 치열한 영역은 %s이고, %s표 차이입니다.', axes->(c3-1)->>'axis', diffs[c3]),
      format('가장 압도적인 영역은 %s입니다.', axes->(c4-1)->>'axis'),
      case when array_length(fewest, 1) > 0 then format('가장 적은 유형은 %s입니다.', array_to_string(fewest, ', '))
           else '입력한 사람이 없어 가장 적은 유형이 없습니다.' end,
      case when array_length(most, 1) > 0 then format('가장 많은 유형은 %s입니다.', array_to_string(most, ', '))
           else '입력한 사람이 없어 가장 많은 유형이 없습니다.' end
    ),
    'answer', answer,
    'axes', ax_out,
    'detail', jsonb_build_object(
      'presentCount', coalesce(array_length(present, 1), 0),
      'singleCount', singles,
      'closestAxis', axes->(c3-1)->>'axis',
      'closestDiff', diffs[c3],
      'dominantAxis', axes->(c4-1)->>'axis',
      'fewest', to_jsonb(fewest),
      'most', to_jsonb(most)
    ),
    'entryCount', coalesce(array_length(list, 1), 0)
  );
end;
$$;

-- 채점: X 영역은 무엇을 골라도 정답
create or replace function public.mbti_score(answer text, guess text) returns integer
language sql immutable as $$
  select count(*)::integer from generate_series(1, 4) i
  where substr(answer, i, 1) = 'X' or substr(answer, i, 1) = substr(guess, i, 1);
$$;

-- 네 글자 정답자, 없으면 세 글자 정답자
create or replace function public.mbti_winners(answer text) returns jsonb
language sql stable security definer set search_path = public as $$
  with scored as (
    select name, public.mbti_score(answer, guess) as score from public.mbti_predictions
  ), target as (
    select coalesce((select max(t) from (values (4), (3)) v(t) where exists (select 1 from scored where score = t)), 0) as t
  )
  select jsonb_build_object(
    'score', (select t from target),
    'names', coalesce((select jsonb_agg(name order by name collate "ko-x-icu")
                       from scored where score = (select t from target) and (select t from target) > 0), '[]'::jsonb)
  );
$$;

-- 스크린·휴대폰에 보내는 진행 상태. 공개된 힌트와 공개된 글자만 담는다.
create or replace function public.mbti_public_state() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  g public.mbti_game;
  phases text[] := array['lobby', 'input', 'hints', 'predict', 'reveal', 'winners', 'roster'];
  idx integer;
  hint_shown integer := 0;
  reveal_shown integer := 0;
  hints jsonb := '[]';
  reveal jsonb := '[]';
  winners jsonb := null;
  roster jsonb := null;
begin
  select * into g from public.mbti_game where id = 1;
  idx := array_position(phases, g.phase);

  if g.computed is not null and idx >= 3 then
    hint_shown := case when g.phase = 'hints' then g.hint_step else 6 end;
    select coalesce(jsonb_agg(h order by o), '[]') into hints
      from jsonb_array_elements(g.computed->'hints') with ordinality t(h, o) where o <= hint_shown;
  end if;

  if g.computed is not null and idx >= 5 then
    reveal_shown := case when g.phase = 'reveal' then g.reveal_step else 4 end;
    select coalesce(jsonb_agg(ax || jsonb_build_object('correct',
             (select count(*) from public.mbti_predictions p
               where ax->>'letter' = 'X' or substr(p.guess, o::integer, 1) = ax->>'letter')) order by o), '[]')
      into reveal
      from jsonb_array_elements(g.computed->'axes') with ordinality t(ax, o) where o <= reveal_shown;
  end if;

  if g.computed is not null and idx >= 6 then
    winners := public.mbti_winners(g.computed->>'answer');
  end if;

  if g.phase = 'roster' then
    select jsonb_agg(jsonb_build_object('type', t, 'names',
             coalesce((select jsonb_agg(e.name order by e.name collate "ko-x-icu")
                         from public.mbti_entries e where e.mbti = t), '[]'::jsonb)) order by o)
      into roster
      from unnest(public.mbti_types()) with ordinality u(t, o);
  end if;

  return jsonb_build_object(
    'gameId', g.game_id, 'version', g.version, 'phase', g.phase,
    'entryOpen', g.entry_open, 'predictionOpen', g.prediction_open,
    'hintStep', hint_shown, 'hints', hints,
    'revealStep', reveal_shown, 'reveal', reveal,
    'winners', winners, 'roster', roster
  );
end;
$$;

-- 인원 (스크린·진행자만 구독). 제출마다 바뀌므로 진행 상태와 따로 보낸다.
create or replace function public.mbti_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'gameId', g.game_id, 'version', g.version, 'total', g.total,
    'entryCount', (select count(*) from public.mbti_entries),
    'predictionCount', (select count(*) from public.mbti_predictions)
  ) from public.mbti_game g where g.id = 1;
$$;

-- 변경 사항을 mbti_live에 써서 Realtime으로 내보낸다
create or replace function public.mbti_publish(with_state boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.mbti_game set version = version + 1 where id = 1;
  insert into public.mbti_live (id, data) values ('counts', public.mbti_counts())
    on conflict (id) do update set data = excluded.data;
  if with_state then
    insert into public.mbti_live (id, data) values ('state', public.mbti_public_state())
      on conflict (id) do update set data = excluded.data;
  end if;
end;
$$;

-- 진행자 비밀번호 확인
create or replace function public.mbti_check_password(pw text) returns text
language plpgsql security definer set search_path = public as $$
declare s public.mbti_secret;
begin
  select * into s from public.mbti_secret where id = 1;
  if s is null then return 'no_password'; end if;
  if encode(sha256(convert_to(s.salt || coalesce(pw, ''), 'UTF8')), 'hex') = s.hash then return 'ok'; end if;
  perform pg_sleep(0.4); -- 비밀번호 추측을 느리게
  return 'unauthorized';
end;
$$;

create or replace function public.mbti_close_entries() returns void
language sql security definer set search_path = public as $$
  update public.mbti_game
  set entry_open = false,
      computed = public.mbti_compute_hints(
        coalesce((select array_agg(mbti) from public.mbti_entries), '{}'), random(), random())
  where id = 1;
$$;

-- ---------------------------------------------------------------------------
-- 4. 접속자가 부르는 RPC
-- ---------------------------------------------------------------------------
create or replace function public.mbti_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select public.mbti_public_state() || public.mbti_counts();
$$;

-- 이름과 내 MBTI 제출 (마감 전에는 같은 이름으로 다시 내면 수정)
create or replace function public.mbti_submit_entry(name text, mbti text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.mbti_game;
  n text := public.mbti_norm_name(name);
  t text := public.mbti_norm_type(mbti);
  k text;
  existed boolean;
begin
  select * into g from public.mbti_game where id = 1 for update;
  if g.phase <> 'input' or not g.entry_open then return public.mbti_err('closed', '지금은 MBTI를 입력할 수 없습니다.'); end if;
  if n is null then return public.mbti_err('bad_name', '이름을 1~20자로 입력해 주세요.'); end if;
  if t is null then return public.mbti_err('bad_mbti', '네 영역을 모두 골라 주세요.'); end if;
  k := public.mbti_key(n);
  existed := exists (select 1 from public.mbti_entries e where e.key = k);
  if not existed and (select count(*) from public.mbti_entries) >= 300 then
    return public.mbti_err('full', '참여 인원이 너무 많습니다.');
  end if;
  insert into public.mbti_entries (key, name, mbti) values (k, n, t)
    on conflict (key) do update set name = excluded.name, mbti = excluded.mbti, at = clock_timestamp();
  perform public.mbti_publish(false);
  return jsonb_build_object('ok', true, 'name', n, 'mbti', t, 'updated', existed, 'gameId', g.game_id);
end;
$$;

-- 우리 반 MBTI 예측 제출 (1인 1회, 수정 불가)
create or replace function public.mbti_submit_prediction(name text, guess text, allow_unlinked boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g public.mbti_game;
  n text := public.mbti_norm_name(name);
  t text := public.mbti_norm_type(guess);
  k text;
  ex public.mbti_predictions;
  en public.mbti_entries;
  final_name text;
begin
  select * into g from public.mbti_game where id = 1 for update;
  if g.phase <> 'predict' or not g.prediction_open then return public.mbti_err('closed', '지금은 예측을 제출할 수 없습니다.'); end if;
  if n is null then return public.mbti_err('bad_name', '이름을 1~20자로 입력해 주세요.'); end if;
  if t is null then return public.mbti_err('bad_mbti', '네 영역을 모두 골라 주세요.'); end if;
  k := public.mbti_key(n);
  select * into ex from public.mbti_predictions p where p.key = k;
  if ex is not null then
    return public.mbti_err('already', format('%s 님은 이미 예측을 제출했습니다.', ex.name))
           || jsonb_build_object('name', ex.name, 'guess', ex.guess);
  end if;
  select * into en from public.mbti_entries e where e.key = k;
  if en is null and coalesce(allow_unlinked, false) is not true then
    return public.mbti_err('confirm_unlinked', '첫 번째 입력 명단에 없는 이름입니다.');
  end if;
  if (select count(*) from public.mbti_predictions) >= 300 then
    return public.mbti_err('full', '참여 인원이 너무 많습니다.');
  end if;
  final_name := coalesce(en.name, n); -- 첫 입력과 연결되면 그때 쓴 이름 표기를 쓴다
  insert into public.mbti_predictions (key, name, guess, linked) values (k, final_name, t, en is not null);
  perform public.mbti_publish(false);
  return jsonb_build_object('ok', true, 'name', final_name, 'guess', t, 'linked', en is not null, 'gameId', g.game_id);
end;
$$;

-- 이 기기에서 제출한 이름들의 내 기록 (정답 정보 없음)
create or replace function public.mbti_mine(names jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  with ks as (
    select distinct public.mbti_key(public.mbti_norm_name(v)) as k
    from (select jsonb_array_elements_text(case when jsonb_typeof(names) = 'array' then names else '[]' end) v limit 50) s
    where public.mbti_norm_name(v) is not null
  )
  select jsonb_build_object(
    'ok', true,
    'gameId', (select game_id from public.mbti_game where id = 1),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('name', e.name, 'mbti', e.mbti) order by e.at)
                         from public.mbti_entries e join ks on ks.k = e.key), '[]'),
    'predictions', coalesce((select jsonb_agg(jsonb_build_object('name', p.name, 'guess', p.guess) order by p.at)
                             from public.mbti_predictions p join ks on ks.k = p.key), '[]')
  );
$$;

-- 진행자 화면 상태 (비밀번호 확인 후)
create or replace function public.mbti_host_state(pw text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  chk text := public.mbti_check_password(pw);
  g public.mbti_game;
begin
  if chk = 'no_password' then return public.mbti_err('no_password', 'Supabase에 진행자 비밀번호가 설정되지 않았습니다.'); end if;
  if chk <> 'ok' then return public.mbti_err('unauthorized', '비밀번호가 올바르지 않습니다.'); end if;
  select * into g from public.mbti_game where id = 1;
  return jsonb_build_object('ok', true) || public.mbti_public_state() || public.mbti_counts() || jsonb_build_object(
    'entryNames', coalesce((select jsonb_agg(name order by at) from public.mbti_entries), '[]'),
    'predictionNames', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'linked', linked) order by at)
                                 from public.mbti_predictions), '[]'),
    'preview', case when g.computed is null then null else jsonb_build_object(
                 'hints', g.computed->'hints', 'answer', g.computed->'answer', 'axes', g.computed->'axes') end
  );
end;
$$;

-- 진행자 조작: next, closeEntry, reopenEntry, closePrediction, reopenPrediction, setTotal, reset
create or replace function public.mbti_host_action(pw text, action text, total integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  chk text := public.mbti_check_password(pw);
  g public.mbti_game;
begin
  if chk = 'no_password' then return public.mbti_err('no_password', 'Supabase에 진행자 비밀번호가 설정되지 않았습니다.'); end if;
  if chk <> 'ok' then return public.mbti_err('unauthorized', '비밀번호가 올바르지 않습니다.'); end if;
  select * into g from public.mbti_game where id = 1 for update;

  case action
  when 'next' then
    case g.phase
    when 'lobby' then
      update public.mbti_game set phase = 'input', entry_open = true where id = 1;
    when 'input' then
      if g.entry_open or g.computed is null then perform public.mbti_close_entries(); end if;
      update public.mbti_game set phase = 'hints', hint_step = 1 where id = 1;
    when 'hints' then
      if g.hint_step < 6 then
        update public.mbti_game set hint_step = hint_step + 1 where id = 1;
      else
        update public.mbti_game set phase = 'predict', prediction_open = true where id = 1;
      end if;
    when 'predict' then
      update public.mbti_game set phase = 'reveal', prediction_open = false, reveal_step = 0 where id = 1;
    when 'reveal' then
      if g.reveal_step < 4 then
        update public.mbti_game set reveal_step = reveal_step + 1 where id = 1;
      else
        update public.mbti_game set phase = 'winners' where id = 1;
      end if;
    when 'winners' then
      update public.mbti_game set phase = 'roster' where id = 1;
    else
      return public.mbti_err('invalid', '마지막 단계입니다.');
    end case;
  when 'closeEntry' then
    if g.phase <> 'input' or not g.entry_open then return public.mbti_err('invalid', '입력을 마감할 수 있는 단계가 아닙니다.'); end if;
    perform public.mbti_close_entries();
  when 'reopenEntry' then
    if g.phase <> 'input' or g.entry_open then return public.mbti_err('invalid', '입력을 다시 열 수 있는 단계가 아닙니다.'); end if;
    update public.mbti_game set entry_open = true, computed = null where id = 1;
  when 'closePrediction' then
    if g.phase <> 'predict' or not g.prediction_open then return public.mbti_err('invalid', '예측을 마감할 수 있는 단계가 아닙니다.'); end if;
    update public.mbti_game set prediction_open = false where id = 1;
  when 'reopenPrediction' then
    if g.phase <> 'predict' or g.prediction_open then return public.mbti_err('invalid', '예측을 다시 열 수 있는 단계가 아닙니다.'); end if;
    update public.mbti_game set prediction_open = true where id = 1;
  when 'setTotal' then
    if total is null or total < 1 or total > 500 then return public.mbti_err('bad_total', '총인원은 1~500 사이로 입력해 주세요.'); end if;
    update public.mbti_game set total = mbti_host_action.total where id = 1;
  when 'reset' then
    delete from public.mbti_predictions where true;
    delete from public.mbti_entries where true;
    update public.mbti_game
    set game_id = substr(md5(random()::text || clock_timestamp()::text), 1, 16),
        phase = 'lobby', entry_open = false, prediction_open = false,
        hint_step = 0, reveal_step = 0, computed = null
    where id = 1;
  else
    return public.mbti_err('bad_action', '알 수 없는 조작입니다.');
  end case;

  perform public.mbti_publish(action <> 'setTotal');
  return public.mbti_host_state(pw);
end;
$$;

-- 진행자 비밀번호 설정 (SQL Editor 전용, 접속자는 부를 수 없음)
create or replace function public.mbti_set_host_password(pw text) returns text
language plpgsql security definer set search_path = public as $$
declare s text := md5(random()::text || clock_timestamp()::text);
begin
  if char_length(coalesce(pw, '')) < 4 then raise exception '비밀번호는 4자 이상으로 정해 주세요.'; end if;
  insert into public.mbti_secret (id, salt, hash)
  values (1, s, encode(sha256(convert_to(s || pw, 'UTF8')), 'hex'))
  on conflict (id) do update set salt = excluded.salt, hash = excluded.hash;
  return '진행자 비밀번호를 저장했습니다.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. 함수 실행 권한: 접속자(anon)는 아래 RPC만
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'mbti\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon, authenticated', f.sig);
    end if;
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.mbti_state() to anon, authenticated;
    grant execute on function public.mbti_submit_entry(text, text) to anon, authenticated;
    grant execute on function public.mbti_submit_prediction(text, text, boolean) to anon, authenticated;
    grant execute on function public.mbti_mine(jsonb) to anon, authenticated;
    grant execute on function public.mbti_host_state(text) to anon, authenticated;
    grant execute on function public.mbti_host_action(text, text, integer) to anon, authenticated;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. 화면용 상태를 채우고 Realtime에 등록
-- ---------------------------------------------------------------------------
select public.mbti_publish(true);

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mbti_live') then
    alter publication supabase_realtime add table public.mbti_live;
  end if;
end $$;

notify pgrst, 'reload schema';

-- 수업 전 초기화는 진행자 화면의 [게임 초기화] 버튼을 쓰세요.
