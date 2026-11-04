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

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, message: '서버 응답을 읽지 못했습니다.' };
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: { ok: false, code: 'network', message: '연결이 불안정합니다. 잠시 후 다시 시도해 주세요.' } };
  }
}

/**
 * 실시간 상태 구독. WebSocket을 우선 쓰고, 끊기면 자동 재연결하면서
 * 그동안은 3초마다 상태를 직접 가져온다. 새로고침해도 서버 상태로 복귀한다.
 */
export function subscribe(onState, onConnection = () => {}) {
  let ws = null;
  let lastVersion = -1;
  let lastGameId = null;
  let retry = 0;
  let pollTimer = null;
  let pingTimer = null;
  let reconnectTimer = null;

  const accept = (state) => {
    if (!state || typeof state.version !== 'number') return;
    if (state.gameId === lastGameId && state.version < lastVersion) return;
    lastGameId = state.gameId;
    lastVersion = state.version;
    onState(state);
  };

  const poll = async () => {
    const { status, data } = await api('/api/state');
    if (status === 200) accept(data);
  };

  const startPolling = () => {
    if (!pollTimer) pollTimer = setInterval(poll, 3000);
  };
  const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const open = () => {
    clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.addEventListener('open', () => {
      retry = 0;
      stopPolling();
      onConnection(true);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, 25000);
    });
    ws.addEventListener('message', (ev) => {
      if (ev.data === 'pong') return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') accept(msg.state);
      } catch {
        // 무시
      }
    });
    ws.addEventListener('close', () => {
      clearInterval(pingTimer);
      onConnection(false);
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        // 무시
      }
    });
  };

  const scheduleReconnect = () => {
    startPolling();
    clearTimeout(reconnectTimer);
    retry += 1;
    reconnectTimer = setTimeout(open, Math.min(10000, 500 * 2 ** Math.min(retry, 5)));
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      poll();
      open();
    }
  });
  window.addEventListener('online', () => {
    poll();
    open();
  });

  poll();
  open();
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
