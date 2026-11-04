import { AXES, h, mount, subscribe } from './common.js';

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

function render(st) {
  renderSteps(st.phase);
  const key = `${st.gameId}|${st.phase}`;
  const fresh = key !== lastKey;
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

subscribe(render, {
  withCounts: true,
  onConnection: (online) => {
    connEl.textContent = online ? '' : '연결 재시도 중…';
  },
});
