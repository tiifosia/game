// 배포된 설정으로 Supabase에 접속해 게임 함수가 준비됐는지 확인한다.
// 데이터를 바꾸지 않는 호출만 쓴다(빈 이름 제출 → 거절 응답이 와야 정상).
//   SUPABASE_URL=... SUPABASE_KEY=... node scripts/check-supabase.mjs
const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_KEY || '').trim();
if (!url || !key) {
  console.error('SUPABASE_URL, SUPABASE_KEY가 필요합니다.');
  process.exit(1);
}
console.log(`Supabase 주소 형식: ${/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) ? '정상' : `확인 필요 (${url.replace(/\/\/([^.]{4})[^.]*/, '//$1…')})`}`);
console.log(`키 종류: ${key.startsWith('sb_publishable_') ? 'publishable' : key.startsWith('sb_secret_') ? 'secret (쓰면 안 됨!)' : key.startsWith('eyJ') ? 'legacy JWT' : '알 수 없음'}`);

const checks = [
  ['mbti_health', {}, (d) => d.ok === true && d.realtime === true && d.password === true && d.liveRows === 2, '설정 점검 (Realtime 등록·비밀번호)'],
  ['mbti_state', {}, (d) => typeof d.phase === 'string', '현재 단계 읽기'],
  ['mbti_submit_entry', { name: '', mbti: '' }, (d) => ['bad_name', 'closed'].includes(d.code), '내 MBTI 제출 함수'],
  ['mbti_submit_prediction', { name: '', guess: '', allow_unlinked: false }, (d) => ['bad_name', 'closed'].includes(d.code), '예측 제출 함수'],
  ['mbti_mine', { names: [] }, (d) => d.ok === true, '내 기록 조회 함수'],
  ['mbti_host_state', { pw: '' }, (d) => d.code === 'unauthorized' || d.code === 'no_password', '진행자 함수'],
];

let failed = false;
for (const [fn, args, good, label] of checks) {
  let line;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    const ok = res.ok && data && good(data);
    if (!ok) failed = true;
    line = `${ok ? 'OK  ' : 'FAIL'} ${label} (${fn}) HTTP ${res.status} ${ok ? '' : text.slice(0, 300)}`;
    if (fn === 'mbti_state' && ok) line += ` 단계=${data.phase} 입력=${data.entryCount}/${data.total}`;
    if (fn === 'mbti_host_state' && data?.code === 'no_password') line += ' ※ 진행자 비밀번호가 아직 설정되지 않았습니다';
    if (fn === 'mbti_health' && data && !ok) {
      if (data.code === 'PGRST202') line += ' ※ schema.sql을 SQL Editor에서 다시 실행해 주세요';
      if (data.realtime === false) line += ' ※ mbti_live가 Realtime에 등록되지 않았습니다';
      if (data.password === false) line += ' ※ 진행자 비밀번호가 설정되지 않았습니다';
    }
  } catch (err) {
    failed = true;
    line = `FAIL ${label} (${fn}) 접속 실패: ${err.message} ${err.cause?.message || ''}`;
  }
  console.log(line);
}
// Realtime: 휴대폰과 같은 방식으로 구독해 DB 변경 구독까지 준비되는지 확인 (데이터는 바꾸지 않음)
try {
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const t0 = Date.now();
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('시간 초과(15초)'), 15000);
    db.channel('health-check')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mbti_live', filter: 'id=eq.state' }, () => {})
      .on('system', {}, (p) => {
        if (p.extension !== 'postgres_changes') return;
        clearTimeout(timer);
        resolve(p.status === 'ok' ? 'ok' : `거절: ${p.message}`);
      })
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          resolve(`${status} ${err?.message || ''}`);
        }
      });
  });
  await db.removeAllChannels();
  if (result !== 'ok') failed = true;
  console.log(`${result === 'ok' ? 'OK  ' : 'FAIL'} 실시간 구독 (Realtime) ${result === 'ok' ? `${Date.now() - t0}ms 만에 준비` : result}`);
} catch (err) {
  console.log(`SKIP 실시간 구독 점검: ${err.message}`);
}

if (failed) {
  console.log('::error::Supabase 확인에 실패한 항목이 있습니다. 위 FAIL 줄을 확인하세요.');
  process.exit(1);
}
process.exit(0);
