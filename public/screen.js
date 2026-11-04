import { AXES, h, mount, rpc, store, subscribe } from './common.js';
import { TOKEN_KEY, primary } from './host-actions.js';

const stage = document.getElementById('stage');
const body = document.getElementById('body');
const stepsEl = document.getElementById('steps');
const connEl = document.getElementById('conn');

// 1920×1080 무대를 창 크기에 맞춘다
function fit() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  const x = (window.innerWidth - 1920 * s) / 2;
  const y = (window.innerHeight - 1080 * s) / 2;
  stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
}
window.addEventListener('resize', fit);
fit();

const STEP_LABELS = [
  ['input', '1 내 MBTI'],
  ['hints', '2 힌트'],
  ['predict', '3 예측'],
  ['answer', '4 정답'],
];
const PHASE_GROUP = { lobby: null, input: 'input', hints: 'hints', predict: 'predict', reveal: 'answer', winners: 'answer', roster: 'answer' };

function renderSteps(phase) {
  const cur = PHASE_GROUP[phase];
  const curIdx = STEP_LABELS.findIndex(([k]) => k === cur);
  mount(
    stepsEl,
    STEP_LABELS.map(([k, label], i) =>
      h('span', { class: `s-step${k === cur ? ' on' : i < curIdx ? ' done' : ''}` }, label),
    ),
  );
}

// 스크린은 <배포 주소>/screen/ 에 있으므로 한 단계 위가 게임 주소다
const BASE = new URL('../', location.href);
const pageUrl = (name) => new URL(`${name}/`, BASE);

function qrCanvas(path, size) {
  const url = pageUrl(path).href;
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const canvas = document.createElement('canvas');
  const px = Math.max(4, Math.floor((size * 2) / n));
  canvas.width = n * px;
  canvas.height = n * px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#F5F5F5';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) ctx.fillRect(c * px, r * px, px, px);
  }
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `QR 코드: ${url}`);
  return canvas;
}

function qrBox(path, size) {
  const u = pageUrl(path);
  return h('div', { class: 's-qr-box' }, qrCanvas(path, size), h('div', { class: 's-url' }, `${u.host}${u.pathname}`.replace(/\/$/, '')));
}

function countBlock(n, total, label) {
  const pct = total > 0 ? Math.min(100, (n / total) * 100) : 0;
  const bar = h('div', { class: 's-bar' }, h('i'));
  bar.firstChild.style.width = `${pct}%`;
  return [
    h('div', { class: 's-count' }, h('span', { class: 'n' }, n), h('span', { class: 't' }, `/ ${total}`)),
    h('div', { class: 's-count-label' }, label),
    bar,
  ];
}

/** 내용이 칸을 넘치지 않을 때까지 글자 크기를 줄인다 */
function fitFont(el, max, min) {
  let size = max;
  el.style.fontSize = `${size}px`;
  while (size > min && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

function hintList(hints, { highlightLast = false } = {}) {
  return h(
    'ol',
    { class: 's-hints' },
    hints.map((text, i) =>
      h('li', { class: `s-hint${highlightLast && i === hints.length - 1 ? ' latest' : ''}` }, h('span', { class: 'no' }, i + 1), h('span', {}, text)),
    ),
  );
}

// QR 캔버스는 다시 그리지 않도록 단계가 바뀔 때만 전체를 갈아 끼운다.
// mount()는 값을 돌려주지 않으므로 `mount(...) || fitFont(...)` 형태로 그린 직후 글자 크기를 맞춘다.
let lastKey = '';

function render(st, force = false) {
  renderSteps(st.phase);
  const key = `${st.gameId}|${st.phase}`;
  const fresh = force || key !== lastKey;
  lastKey = key;

  switch (st.phase) {
    case 'lobby':
      return mount(
        body,
        h(
          'div',
          { class: 's-center' },
          h('h1', { class: 's-title' }, '우리 반 ', h('b', {}, 'MBTI'), '를 맞혀라'),
          h('p', { class: 's-sub' }, '곧 시작합니다 · 자리에서 휴대폰을 준비해 주세요'),
        ),
      );

    case 'input': {
      if (fresh || !body.querySelector('.s-qr-layout')) {
        mount(
          body,
          h(
            'div',
            { class: 's-qr-layout' },
            qrBox('me', 584),
            h('div', { id: 'side' }),
          ),
        );
      }
      return mount(
        document.getElementById('side'),
        h('h2', { class: 's-h' }, h('small', {}, '1단계'), '이름과 내 MBTI를 입력하세요'),
        h('p', { class: 's-instr' }, 'QR 코드를 찍으면 바로 입력할 수 있어요.', h('br'), 'MBTI를 모르면 더 끌리는 쪽을 고르면 돼요.'),
        countBlock(st.entryCount, st.total, '명 입력 완료'),
        st.entryOpen ? null : h('div', { class: 's-badge' }, '입력 마감 · 곧 힌트가 공개됩니다'),
      );
    }

    case 'hints':
      return mount(
        body,
        h('h2', { class: 's-h' }, h('small', {}, `힌트 ${st.hintStep} / 6`), '힌트를 보고 우리 반 MBTI를 추리하세요'),
        h('div', { class: 's-fit', id: 'fit' }, hintList(st.hints, { highlightLast: true })),
        st.hintStep < 6 ? h('div', { class: 's-hint-wait' }, '다음 힌트를 기다려 주세요') : null,
      ) || fitFont(document.getElementById('fit'), 46, 22);

    case 'predict': {
      if (fresh || !body.querySelector('.s-predict-layout')) {
        mount(
          body,
          h(
            'div',
            { class: 's-predict-layout' },
            h('div', {}, qrBox('guess', 444), h('div', { id: 'pcount' })),
            h(
              'div',
              {},
              h('h2', { class: 's-h' }, h('small', {}, '3단계'), '우리 반 MBTI를 예측해 제출하세요'),
              h('h3', { class: 's-side-h' }, '공개된 힌트'),
              h('div', { class: 's-fit', id: 'fit' }, hintList(st.hints)),
            ),
          ),
        );
        fitFont(document.getElementById('fit'), 36, 20);
      }
      const pc = document.getElementById('pcount');
      return mount(
        pc,
        countBlock(st.predictionCount, st.total, '명 제출 완료'),
        st.predictionOpen ? null : h('div', { class: 's-badge' }, '제출 마감'),
      );
    }

    case 'reveal':
      return mount(
        body,
        h('h2', { class: 's-h' }, h('small', {}, `정답 공개 ${st.revealStep} / 4`), '우리 반 MBTI는?'),
        h(
          'div',
          { class: 's-tiles' },
          AXES.map((ax, i) => {
            const r = st.reveal[i];
            if (!r) {
              return h('div', { class: 's-tile' }, h('div', { class: 'ax' }, `${ax.a} / ${ax.b}`), h('div', { class: 'big' }, '?'));
            }
            const tie = r.letter === 'X';
            return h(
              'div',
              { class: 's-tile open' },
              h('div', { class: 'ax' }, `${r.a} / ${r.b}`),
              h('div', { class: 'big' }, r.letter),
              h('div', { class: 'votes' }, `${r.a} ${r.countA} : ${r.countB} ${r.b}`),
              h('div', { class: 'note' }, tie ? '동점! 무엇을 골라도 정답' : `${r.correct} / ${st.predictionCount}명 맞힘`),
            );
          }),
        ),
      );

    case 'winners': {
      const w = st.winners || { score: 0, names: [] };
      const title =
        w.score === 4 ? '네 글자를 모두 맞힌 사람' : w.score === 3 ? '네 글자 정답자가 없어요! 세 글자를 맞힌 사람' : '아쉽게도 세 글자 이상 맞힌 사람이 없어요';
      return mount(
        body,
        answerRow(st),
        h('h2', { class: 's-h' }, h('small', {}, w.names.length ? `${w.names.length}명` : '정답자 발표'), title),
        w.names.length
          ? h(
              'div',
              { class: 's-fit s-names', id: 'fit' },
              w.names.map((n, i) => {
                const el = h('span', { class: 's-name' }, n);
                el.style.animationDelay = `${Math.min(i, 20) * 0.08}s`;
                return el;
              }),
            )
          : h('p', { class: 's-empty' }, '다음엔 꼭 맞혀 봐요!'),
      ) || (w.names.length ? fitFont(document.getElementById('fit'), 72, 24) : undefined);
    }

    case 'roster': {
      const answer = st.reveal.map((r) => r.letter).join('');
      const matches = (type) => [...answer].every((l, i) => l === 'X' || l === type[i]);
      return mount(
        body,
        h('div', { class: 's-answer-row' }, h('span', { class: 'lbl' }, '우리 반 MBTI'), [...answer].map((l) => h('span', { class: 's-mini' }, l)), h('span', { class: 'lbl' }, ' · 유형별 명단')),
        h(
          'div',
          { class: 's-roster' },
          st.roster.map((r) =>
            h(
              'div',
              { class: `s-cell${r.names.length ? '' : ' empty'}${matches(r.type) ? ' answer' : ''}` },
              h('div', { class: 'ty' }, r.type, r.names.length ? h('span', {}, `${r.names.length}명`) : null),
              h('div', { class: 'nm' }, r.names.join(', ')),
            ),
          ),
        ),
      ) || body.querySelectorAll('.s-cell .nm').forEach((el) => fitFont(el, 40, 16));
    }

    default:
      return mount(body);
  }
}

function answerRow(st) {
  return h(
    'div',
    { class: 's-answer-row' },
    h('span', { class: 'lbl' }, '우리 반 MBTI'),
    st.reveal.map((r) => h('span', { class: 's-mini' }, r.letter)),
  );
}

// ---------------------------------------------------------------------------
// 진행자 조작 바: 이 화면을 그대로 프로젝터에 미러링하므로
// 정답 미리보기·명단처럼 학생에게 보이면 안 되는 내용은 넣지 않는다.
// ---------------------------------------------------------------------------
const ctrlEl = document.getElementById('controls');
let lastState = null;
let token = store.get(TOKEN_KEY, '');
let busy = false;
let msg = '';
let barHidden = false;
let loginOpen = false;

function setMsg(text) {
  msg = text;
  renderControls();
}

async function hostCall(action, extra = {}) {
  if (busy || !token) return;
  busy = true;
  renderControls();
  const data = await rpc('mbti_host_action', { pw: token, action, total: extra.total ?? null });
  busy = false;
  if (data.code === 'unauthorized' || data.code === 'no_password') {
    logout();
    return setMsg(data.message);
  }
  msg = data.ok ? '' : data.message || '실패했습니다.';
  renderControls();
}

function next() {
  if (!lastState || busy || !token) return;
  const p = primary(lastState);
  if (p.disabled) return;
  if (p.confirm && !window.confirm(p.confirm)) return;
  hostCall('next');
}

function reset() {
  const answer = window.prompt('모든 입력과 결과를 지우고 처음으로 돌아갑니다.\n계속하려면 "초기화"라고 입력하세요.');
  if (answer === null) return;
  if (answer.trim() !== '초기화') return setMsg('초기화를 취소했습니다.');
  hostCall('reset');
}

function logout() {
  token = '';
  store.remove(TOKEN_KEY);
  renderControls();
}

async function login(pw) {
  const data = await rpc('mbti_host_state', { pw });
  if (!data.ok) return data.message || '로그인하지 못했습니다.';
  token = pw;
  store.set(TOKEN_KEY, pw);
  loginOpen = false;
  msg = '';
  renderControls();
  return '';
}

function loginBox() {
  const input = h('input', { class: 'c-input', type: 'password', autocomplete: 'current-password', placeholder: '진행자 비밀번호', 'aria-label': '진행자 비밀번호' });
  const err = h('p', { class: 'c-err', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'c-login',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '확인 중…';
        err.textContent = await login(input.value);
      },
    },
    h('p', { class: 'c-login-h' }, '진행자 로그인'),
    input,
    h('div', { class: 'c-row' }, h('button', { class: 'c-btn primary', type: 'submit' }, '들어가기'), h('button', { class: 'c-btn', type: 'button', onclick: () => { loginOpen = false; renderControls(); } }, '취소')),
    err,
  );
  setTimeout(() => input.focus(), 0);
  return form;
}

function renderControls() {
  const withBar = Boolean(token) && !barHidden;
  if (stage.classList.contains('has-controls') !== withBar) {
    // 조작 바만큼 화면 높이가 바뀌므로 글자 크기를 다시 맞춘다
    stage.classList.toggle('has-controls', withBar);
    if (lastState) render(lastState, true);
  }
  if (!token) {
    // 비밀번호를 입력하는 동안 상태가 갱신돼도 입력 칸을 다시 만들지 않는다
    if (loginOpen && ctrlEl.querySelector('.c-login')) return;
    mount(ctrlEl, loginOpen ? loginBox() : h('button', { class: 'c-chip', type: 'button', onclick: () => { loginOpen = true; renderControls(); } }, '진행자 로그인'), msg ? h('p', { class: 'c-err' }, msg) : null);
    return;
  }
  if (barHidden) {
    mount(ctrlEl, h('button', { class: 'c-chip', type: 'button', title: 'H 키', onclick: toggleBar }, '조작 바 보이기'));
    return;
  }
  const st = lastState;
  if (!st) return mount(ctrlEl);
  const p = primary(st);
  const toggles = [];
  if (st.phase === 'input') {
    toggles.push(st.entryOpen
      ? h('button', { class: 'c-btn', disabled: busy, onclick: () => hostCall('closeEntry') }, '입력 마감')
      : h('button', { class: 'c-btn', disabled: busy, onclick: () => hostCall('reopenEntry') }, '입력 다시 열기'));
  }
  if (st.phase === 'predict') {
    toggles.push(st.predictionOpen
      ? h('button', { class: 'c-btn', disabled: busy, onclick: () => hostCall('closePrediction') }, '예측 마감')
      : h('button', { class: 'c-btn', disabled: busy, onclick: () => hostCall('reopenPrediction') }, '예측 다시 열기'));
  }
  mount(
    ctrlEl,
    h(
      'div',
      { class: 'c-bar', role: 'toolbar', 'aria-label': '진행자 조작' },
      h(
        'div',
        { class: 'c-row' },
        h('span', { class: 'c-label' }, '총인원'),
        h('button', { class: 'c-btn sq', disabled: busy || st.total <= 1, 'aria-label': '총인원 줄이기', onclick: () => hostCall('setTotal', { total: st.total - 1 }) }, '−'),
        h('span', { class: 'c-num' }, st.total),
        h('button', { class: 'c-btn sq', disabled: busy || st.total >= 500, 'aria-label': '총인원 늘리기', onclick: () => hostCall('setTotal', { total: st.total + 1 }) }, '+'),
        toggles,
        h('button', { class: 'c-btn', disabled: busy, onclick: reset }, '초기화'),
        h('button', { class: 'c-btn', onclick: toggleBar, title: 'H 키' }, '숨기기'),
        h('button', { class: 'c-btn', onclick: logout }, '로그아웃'),
      ),
      h(
        'div',
        { class: 'c-row' },
        msg ? h('span', { class: 'c-err' }, msg) : h('span', { class: 'c-hint' }, '→ · Space · PageDown'),
        h('button', { class: 'c-btn primary next', disabled: busy || p.disabled, onclick: next }, busy ? '처리 중…' : p.disabled ? p.label : `${p.label}  →`),
      ),
    ),
  );
}

function toggleBar() {
  barHidden = !barHidden;
  renderControls();
}

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!token) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault();
    document.activeElement?.blur?.();
    next();
  } else if (e.key === 'h' || e.key === 'H' || e.key === 'ㅗ') {
    toggleBar();
  }
});

// 저장된 비밀번호가 아직 맞는지 확인
if (token) {
  rpc('mbti_host_state', { pw: token }).then((d) => {
    if (d.code === 'unauthorized' || d.code === 'no_password') logout();
  });
}
renderControls();

subscribe((st) => {
  lastState = st;
  render(st);
  renderControls();
}, {
  withCounts: true,
  onConnection: (online) => {
    connEl.textContent = online ? '' : '연결 재시도 중…';
  },
});
