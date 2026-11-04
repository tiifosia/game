// 스크린·진행자·플레이어 화면이 함께 쓰는 도구

export const AXES = [
  { axis: 'E/I', a: 'E', b: 'I', la: '외향', lb: '내향' },
  { axis: 'S/N', a: 'S', b: 'N', la: '감각', lb: '직관' },
  { axis: 'T/F', a: 'T', b: 'F', la: '사고', lb: '감정' },
  { axis: 'J/P', a: 'J', b: 'P', la: '판단', lb: '인식' },
];

/**
 * DOM 생성 도우미. 문자열 자식은 항상 텍스트 노드로 넣으므로
 * 사용자 이름이 HTML로 해석되지 않는다(자동 이스케이프).
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function mount(root, ...children) {
  root.replaceChildren(...children.flat(Infinity).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Supabase 연결
// ---------------------------------------------------------------------------

const cfg = window.MBTI_CONFIG || {};
let client = null;

function getClient() {
  if (client) return client;
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) {
    document.body.replaceChildren(
      h('div', { class: 'p-wrap' }, h('h1', { class: 'p-h' }, '설정이 필요합니다'), h('p', { class: 'p-lead' }, 'config.js에 Supabase 주소와 키가 없습니다. README의 배포 안내를 확인해 주세요.')),
    );
    throw new Error('MBTI_CONFIG 없음');
  }
  client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}

const NETWORK_ERROR = { ok: false, code: 'network', message: '연결이 불안정합니다. 잠시 후 다시 시도해 주세요.' };

/** Supabase RPC 호출. 항상 { ok, code?, message?, ... } 형태로 돌려준다 */
export async function rpc(fn, args = {}) {
  try {
    const { data, error } = await getClient().rpc(fn, args);
    if (error || !data) return { ...NETWORK_ERROR, detail: error?.message };
    return { ok: true, ...data };
  } catch {
    return NETWORK_ERROR;
  }
}

/**
 * 실시간 상태 구독.
 * - 진행 상태(mbti_live 'state')는 모두가, 인원(mbti_live 'counts')은 withCounts일 때만 받는다.
 *   휴대폰은 인원 변화를 받지 않으므로 제출이 몰려도 실시간 메시지가 적다.
 * - Realtime이 끊기면 3초마다 상태를 직접 가져오고, 다시 연결되면 한 번 맞춘다.
 * - 새로고침하면 서버 상태로 바로 복귀한다.
 */
export function subscribe(onState, { withCounts = false, onConnection = () => {} } = {}) {
  const db = getClient();
  const cur = {};
  let stateV = -1;
  let countsV = -1;
  let pollTimer = null;
  let ready = false;

  const emit = () => {
    if (ready) onState({ ...cur });
  };

  const applyState = (data) => {
    if (!data || data.version < stateV) return false;
    stateV = data.version;
    Object.assign(cur, data);
    return true;
  };
  const applyCounts = (data) => {
    if (!data || data.version < countsV) return false;
    countsV = data.version;
    Object.assign(cur, data);
    return true;
  };

  const poll = async () => {
    const res = await rpc('mbti_state');
    if (!res.ok) return;
    const { ok, ...data } = res;
    const changed = applyState(data);
    if (withCounts) applyCounts(data);
    ready = true;
    if (changed || withCounts) emit();
  };

  const startPolling = () => {
    if (!pollTimer) pollTimer = setInterval(poll, 3000);
  };
  const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const channel = db
    .channel(`mbti-${Math.random().toString(36).slice(2)}`)
    .on(
      'postgres_changes',
      withCounts
        ? { event: '*', schema: 'public', table: 'mbti_live' }
        : { event: '*', schema: 'public', table: 'mbti_live', filter: 'id=eq.state' },
      (payload) => {
        const row = payload.new;
        if (!row || !row.data) return;
        const changed = row.id === 'state' ? applyState(row.data) : withCounts && applyCounts(row.data);
        if (changed) emit();
      },
    )
    // DB 변경 구독이 실제로 준비되면 그 사이 놓친 변경을 한 번 맞춘다
    .on('system', {}, (p) => {
      if (p.extension === 'postgres_changes' && p.status === 'ok') poll();
    });

  if (cfg.realtime === false) {
    startPolling();
  } else {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        stopPolling();
        onConnection(true);
        poll(); // 끊긴 동안 놓친 변경을 맞춘다
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        onConnection(false);
        startPolling();
      }
    });
    // 연결이 오래 걸리면 그동안은 조회로 버틴다
    setTimeout(() => {
      if (channel.state !== 'joined') startPolling();
    }, 4000);
  }
  // 혹시 놓친 메시지가 있어도 30초 안에는 맞춰진다
  setInterval(poll, 30000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });
  window.addEventListener('online', poll);

  poll();
  return { refresh: poll };
}

/** localStorage는 막혀 있을 수 있으므로 항상 감싸서 쓴다 */
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 저장 불가 환경
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 무시
    }
  },
};
