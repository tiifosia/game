import { AXES, h, mount, rpc, store, subscribe } from './common.js';

const root = document.getElementById('app');
const TOKEN_KEY = 'mbti-game-host';

let token = store.get(TOKEN_KEY, '');
let hs = null; // 진행자 상태
let msg = '';
let busy = false;
let started = false;

const PHASE_NAME = {
  lobby: '시작 전 대기',
  input: '1단계 · 내 MBTI 입력',
  hints: '2단계 · 힌트 공개',
  predict: '3단계 · 우리 반 MBTI 예측',
  reveal: '4단계 · 정답 공개',
  winners: '4단계 · 정답자 발표',
  roster: '4단계 · 유형별 명단',
};

function primary(st) {
  switch (st.phase) {
    case 'lobby':
      return { label: '게임 시작 · 첫 번째 QR 띄우기' };
    case 'input':
      return st.entryOpen
        ? { label: '입력 마감하고 힌트 1 공개', confirm: `아직 입력이 열려 있습니다 (${st.entryCount}/${st.total}명). 마감하고 힌트로 넘어갈까요?` }
        : { label: '힌트 1 공개' };
    case 'hints':
      return st.hintStep < 6 ? { label: `힌트 ${st.hintStep + 1} 공개` } : { label: '두 번째 QR 띄우기 (예측 시작)' };
    case 'predict':
      return st.predictionOpen
        ? { label: '예측 마감하고 정답 공개 화면으로', confirm: `아직 예측이 열려 있습니다 (${st.predictionCount}/${st.total}명). 마감하고 넘어갈까요?` }
        : { label: '정답 공개 화면으로' };
    case 'reveal':
      return st.revealStep < 4 ? { label: `${AXES[st.revealStep].axis} 결과 공개` } : { label: '정답자 발표' };
    case 'winners':
      return { label: '유형별 명단 보기' };
    default:
      return { label: '게임 끝', disabled: true };
  }
}

function phaseSub(st) {
  switch (st.phase) {
    case 'lobby':
      return '스크린에 제목이 떠 있습니다. 준비되면 시작하세요.';
    case 'input':
      return st.entryOpen ? '학생들이 첫 번째 QR로 입력하는 중입니다.' : '입력이 마감되었습니다. 힌트가 계산되어 저장되었습니다.';
    case 'hints':
      return `힌트 ${st.hintStep}/6 공개됨`;
    case 'predict':
      return st.predictionOpen ? '학생들이 두 번째 QR로 예측을 제출하는 중입니다.' : '예측이 마감되었습니다.';
    case 'reveal':
      return `${st.revealStep}/4 글자 공개됨`;
    case 'winners':
      return '정답자 이름이 스크린에 떠 있습니다.';
    default:
      return '전원의 이름이 유형별로 스크린에 떠 있습니다.';
  }
}

async function call(body) {
  if (busy) return;
  busy = true;
  render();
  const data = await rpc('mbti_host_action', { pw: token, action: body.action, total: body.total ?? null });
  busy = false;
  if (data.code === 'unauthorized' || data.code === 'no_password') return logout(data.message);
  if (data.ok) {
    hs = data;
    msg = '';
  } else {
    msg = data.message || '실패했습니다.';
  }
  render();
}

function next() {
  if (!hs || busy) return;
  const p = primary(hs);
  if (p.disabled) return;
  if (p.confirm && !window.confirm(p.confirm)) return;
  call({ action: 'next' });
}

function reset() {
  const answer = window.prompt('모든 입력과 결과를 지우고 처음으로 돌아갑니다.\n계속하려면 "초기화"라고 입력하세요.');
  if (answer === null) return;
  if (answer.trim() !== '초기화') {
    msg = '초기화를 취소했습니다.';
    render();
    return;
  }
  call({ action: 'reset' });
}

async function refresh() {
  const data = await rpc('mbti_host_state', { pw: token });
  if (data.code === 'unauthorized' || data.code === 'no_password') return logout(data.message);
  if (data.ok) {
    hs = data;
    render();
  }
}

let refreshTimer = null;
function onPublicState() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
}

function logout(reason = '') {
  token = '';
  store.remove(TOKEN_KEY);
  hs = null;
  renderLogin(reason);
}

function renderLogin(reason = '') {
  const input = h('input', { class: 'p-input', type: 'password', id: 'pw', autocomplete: 'current-password', placeholder: '진행자 비밀번호' });
  const form = h(
    'form',
    {
      class: 'h-login',
      onsubmit: async (e) => {
        e.preventDefault();
        token = input.value;
        const data = await rpc('mbti_host_state', { pw: token });
        if (data.ok) {
          store.set(TOKEN_KEY, token);
          hs = data;
          start();
          render();
        } else {
          renderLogin(data.message || '로그인하지 못했습니다.');
        }
      },
    },
    h('h1', { class: 'p-h' }, '진행자 로그인'),
    h('p', { class: 'p-lead' }, '이 화면은 스크린에 비추지 말고 노트북 화면에서만 쓰세요.'),
    input,
    h('button', { class: 'p-btn', type: 'submit' }, '들어가기'),
    reason ? h('p', { class: 'p-error', role: 'alert' }, reason) : null,
  );
  mount(root, form);
  input.focus();
}

function render() {
  if (!hs) return;
  const st = hs;
  const p = primary(st);
  // 총인원을 고치는 도중에 화면이 갱신돼도 입력값과 포커스를 유지한다
  const editingTotal = document.activeElement?.id === 'total' ? document.activeElement.value : null;
  const totalInput = h('input', { class: 'h-input', type: 'number', min: '1', max: '500', value: editingTotal ?? st.total, 'aria-label': '총인원' });

  const toggles = [];
  if (st.phase === 'input') {
    toggles.push(
      st.entryOpen
        ? h('button', { class: 'h-btn', disabled: busy, onclick: () => call({ action: 'closeEntry' }) }, '입력 마감')
        : h('button', { class: 'h-btn', disabled: busy, onclick: () => call({ action: 'reopenEntry' }) }, '입력 다시 열기'),
    );
  }
  if (st.phase === 'predict') {
    toggles.push(
      st.predictionOpen
        ? h('button', { class: 'h-btn', disabled: busy, onclick: () => call({ action: 'closePrediction' }) }, '예측 마감')
        : h('button', { class: 'h-btn', disabled: busy, onclick: () => call({ action: 'reopenPrediction' }) }, '예측 다시 열기'),
    );
  }

  const preview = st.preview
    ? h(
        'details',
        { class: 'h-card h-preview' },
        h('summary', {}, '진행자 미리보기 (힌트 · 정답) — 스크린에 비추지 마세요'),
        h('p', {}, '정답: ', h('b', {}, st.preview.answer), '  ', st.preview.axes.map((a) => `${a.a} ${a.countA}:${a.countB} ${a.b}`).join(' · ')),
        h('ol', {}, st.preview.hints.map((t, i) => h('li', { class: i < st.hintStep ? 'shown' : '' }, t))),
      )
    : null;

  mount(
    root,
    h(
      'div',
      { class: 'h-wrap' },
      h(
        'div',
        { class: 'h-top' },
        h('h1', {}, '우리 반 ', h('b', {}, 'MBTI'), ' 진행자'),
        h(
          'div',
          { class: 'h-row' },
          h('button', { class: 'h-btn', onclick: () => window.open(new URL('../screen/', location.href), 'mbti-screen') }, '스크린 창 열기'),
          h('button', { class: 'h-btn', onclick: () => logout() }, '로그아웃'),
        ),
      ),
      h(
        'div',
        { class: 'h-grid' },
        h(
          'section',
          { class: 'h-card' },
          h('p', { class: 'h-phase' }, PHASE_NAME[st.phase]),
          h('p', { class: 'h-phase-sub' }, phaseSub(st)),
          h('button', { class: 'h-btn primary', disabled: busy || p.disabled, onclick: next }, busy ? '처리 중…' : p.label),
          h('p', { class: 'h-kbd' }, '단축키: → 또는 Space 또는 PageDown (발표용 리모컨 사용 가능)'),
          toggles.length ? h('div', { class: 'h-row' }, toggles) : null,
          h('div', { class: 'h-msg', role: 'status' }, msg),
        ),
        h(
          'section',
          { class: 'h-card' },
          h('h2', {}, '인원'),
          h('div', { class: 'h-stat' }, h('div', {}, h('b', {}, `${st.entryCount}/${st.total}`), '내 MBTI 입력'), h('div', {}, h('b', {}, `${st.predictionCount}/${st.total}`), '예측 제출')),
          h(
            'form',
            {
              class: 'h-row',
              onsubmit: (e) => {
                e.preventDefault();
                call({ action: 'setTotal', total: Number(totalInput.value) });
              },
            },
            h('label', { for: 'total' }, '총인원'),
            totalInput,
            h('button', { class: 'h-btn', type: 'submit', disabled: busy }, '저장'),
          ),
        ),
        h('section', { class: 'h-card' }, h('h2', {}, `입력한 사람 (${st.entryNames.length})`), h('div', { class: 'h-names' }, st.entryNames.map((n) => h('span', {}, n)))),
        h(
          'section',
          { class: 'h-card' },
          h('h2', {}, `예측한 사람 (${st.predictionNames.length})`),
          h('div', { class: 'h-names' }, st.predictionNames.map((p) => h('span', { class: p.linked ? '' : 'warn', title: p.linked ? '' : '첫 입력 없음' }, p.linked ? p.name : `${p.name} (첫 입력 없음)`))),
        ),
        preview,
        h(
          'section',
          { class: 'h-card' },
          h('h2', {}, '게임 초기화'),
          h('p', { class: 'p-lead' }, '수업 전 연습 데이터를 지울 때 사용합니다. 모든 입력과 결과가 사라지고 휴대폰 화면도 처음으로 돌아갑니다.'),
          h('button', { class: 'h-btn', disabled: busy, onclick: reset }, '게임 초기화'),
        ),
      ),
    ),
  );
  totalInput.id = 'total';
  if (editingTotal !== null) totalInput.focus();
}

function start() {
  if (started) return;
  started = true;
  subscribe(onPublicState, { withCounts: true });
  document.addEventListener('keydown', (e) => {
    if (!hs) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      next();
    }
  });
}

if (token) {
  refresh().then(() => {
    if (hs) start();
  });
} else {
  renderLogin();
}
