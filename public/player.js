import { AXES, h, mount, rpc, store, subscribe } from './common.js';

const root = document.getElementById('app');
const connEl = document.getElementById('conn');
const STORE_KEY = 'mbti-game-device';

const keyOf = (name) => name.toLocaleLowerCase('ko-KR').replace(/\s+/g, '');

// 이 기기에서 제출한 기록 (한 기기에서 여러 명이 제출할 수 있다)
let device = store.get(STORE_KEY, null) || { gameId: null, entries: [], predictions: [] };
const saveDevice = () => store.set(STORE_KEY, device);

function upsert(list, item) {
  const k = keyOf(item.name);
  const i = list.findIndex((x) => keyOf(x.name) === k);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

// 화면 상태 (서버 상태가 갱신돼도 입력 중인 내용은 유지)
let state = null;
const ui = {
  entryView: null, // 'form' | 'done'
  predictView: null,
  entryDraft: { name: '', letters: [null, null, null, null] },
  predictDraft: { name: '', letters: [null, null, null, null] },
  error: '',
  info: '',
  confirm: null, // { kind: 'submit' | 'unlinked' }
  busy: false,
};
let lastKey = '';

function resetDraft(d) {
  d.name = '';
  d.letters = [null, null, null, null];
}

async function syncWithServer() {
  const names = [...new Set([...device.entries, ...device.predictions].map((x) => x.name))];
  if (!names.length) return;
  const data = await rpc('mbti_mine', { names });
  if (!data.ok || data.gameId !== device.gameId) return;
  device.entries = data.entries;
  device.predictions = data.predictions;
  saveDevice();
  render(true);
}

function onState(st) {
  const firstLoad = state === null;
  if (device.gameId !== st.gameId) {
    // 게임이 초기화되면 이 기기의 기록도 비운다
    device = { gameId: st.gameId, entries: [], predictions: [] };
    saveDevice();
    ui.entryView = null;
    ui.predictView = null;
    ui.confirm = null;
    ui.error = '';
    ui.info = '';
  }
  state = st;
  render();
  if (firstLoad) syncWithServer();
}

// ---------------------------------------------------------------------------
// 공통 조각
// ---------------------------------------------------------------------------

const PHASE_CHIP = {
  lobby: '시작 전',
  input: '1 내 MBTI',
  hints: '2 힌트',
  predict: '3 예측',
  reveal: '4 정답 공개',
  winners: '4 정답 공개',
  roster: '4 정답 공개',
};

function top() {
  return h('div', { class: 'p-top' }, h('span', {}, '우리 반 ', h('b', {}, 'MBTI'), ' 추리'), h('span', { class: 'p-chip' }, PHASE_CHIP[state.phase] || ''));
}

function slots(letters, marks, id) {
  return h(
    'div',
    { class: 'p-preview', id },
    letters.map((l, i) => {
      const mark = marks ? marks[i] : null;
      const cls = mark === true ? ' ok' : mark === false ? ' no' : l ? ' filled' : '';
      return h('span', { class: `p-slot${cls}`, 'aria-label': `${AXES[i].axis} ${l || '미선택'}${mark === true ? ' 정답' : mark === false ? ' 오답' : ''}` }, l || '');
    }),
  );
}

function axisPicker(draft) {
  return AXES.map((ax, i) =>
    h(
      'div',
      { class: 'p-axis', role: 'group', 'aria-label': ax.axis },
      [
        [ax.a, ax.la],
        [ax.b, ax.lb],
      ].map(([letter, desc]) =>
        h(
          'button',
          {
            type: 'button',
            class: 'p-opt',
            'aria-pressed': draft.letters[i] === letter ? 'true' : 'false',
            'data-axis': i,
            'data-letter': letter,
            onclick: () => {
              draft.letters[i] = letter;
              ui.error = '';
              refreshPicker(draft);
            },
          },
          h('span', { class: 'l' }, letter),
          h('span', { class: 'd' }, desc),
        ),
      ),
    ),
  );
}

/**
 * 글자 버튼을 누르면 이름 칸은 그대로 두고 버튼 표시만 바꾼다.
 * (화면 전체를 다시 그리면 한글 입력 중인 마지막 글자가 사라질 수 있다)
 */
function refreshPicker(draft) {
  document.querySelectorAll('.p-opt[data-axis]').forEach((b) => {
    b.setAttribute('aria-pressed', draft.letters[Number(b.dataset.axis)] === b.dataset.letter ? 'true' : 'false');
  });
  const box = document.getElementById('slots');
  if (box) box.replaceWith(slots(draft.letters, null, 'slots'));
  document.querySelector('.p-error')?.remove();
  updateSubmit();
}

/** 이름 칸의 현재 값을 초안에 반영 (한글 조합이 끝나지 않았어도 보이는 글자 그대로) */
function syncName(draft) {
  const el = document.getElementById(state?.phase === 'predict' ? 'pname' : 'name');
  if (el) draft.name = el.value;
}

function nameField(draft, id) {
  const input = h('input', {
    id,
    class: 'p-input',
    type: 'text',
    maxlength: '20',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    placeholder: '예: 홍길동',
    value: draft.name,
    oninput: (e) => {
      draft.name = e.target.value;
      updateSubmit();
    },
    oncompositionend: (e) => {
      draft.name = e.target.value;
      updateSubmit();
    },
  });
  return [h('label', { class: 'p-label', for: id }, '이름'), input];
}

function errorBox() {
  return ui.error ? h('p', { class: 'p-error', role: 'alert' }, ui.error) : null;
}

function infoBox() {
  return ui.info ? h('p', { class: 'p-info', role: 'status' }, ui.info) : null;
}

function draftValid(d) {
  const n = d.name.trim();
  return n.length > 0 && [...n].length <= 20 && d.letters.every(Boolean);
}

function updateSubmit() {
  const btn = document.getElementById('submit');
  if (!btn) return;
  const d = state.phase === 'predict' ? ui.predictDraft : ui.entryDraft;
  btn.disabled = ui.busy || !draftValid(d);
}

// ---------------------------------------------------------------------------
// 1단계: 내 MBTI
// ---------------------------------------------------------------------------

async function submitEntry() {
  const d = ui.entryDraft;
  syncName(d);
  if (!draftValid(d) || ui.busy) return;
  ui.busy = true;
  ui.error = '';
  render(true);
  const data = await rpc('mbti_submit_entry', { name: d.name, mbti: d.letters.join('') });
  ui.busy = false;
  if (data.ok) {
    upsert(device.entries, { name: data.name, mbti: data.mbti });
    saveDevice();
    ui.info = data.updated ? `${data.name} 님의 MBTI를 ${data.mbti}(으)로 수정했어요.` : `${data.name} 님, 제출 완료!`;
    ui.entryView = 'done';
    resetDraft(d);
  } else {
    ui.error = data.message || '제출하지 못했습니다.';
  }
  render(true);
}

function entryForm() {
  const d = ui.entryDraft;
  const editing = device.entries.some((e) => keyOf(e.name) === keyOf(d.name.trim() || '\u0000'));
  return [
    h('h1', { class: 'p-h' }, '내 MBTI 입력'),
    h('p', { class: 'p-lead' }, '이름을 쓰고, 네 영역에서 하나씩 골라 주세요.'),
    h('div', { class: 'p-card' }, nameField(d, 'name'), axisPicker(d)),
    h(
      'ul',
      { class: 'p-notes' },
      h('li', {}, 'MBTI를 모르면 더 끌리는 쪽을 골라 주세요.'),
      h('li', {}, '이름과 MBTI는 게임 마지막에 스크린에 공개됩니다.'),
      h('li', {}, '마감 전에는 같은 이름으로 다시 제출하면 수정됩니다.'),
    ),
    slots(d.letters, null, 'slots'),
    h('button', { id: 'submit', class: 'p-btn', type: 'button', disabled: true, onclick: submitEntry }, ui.busy ? '제출 중…' : editing ? '수정해서 제출하기' : '제출하기'),
    errorBox(),
    device.entries.length
      ? h('button', { class: 'p-btn ghost', type: 'button', onclick: () => { ui.entryView = 'done'; ui.error = ''; render(true); } }, '취소')
      : null,
  ];
}

function entryList(editable) {
  return h(
    'ul',
    { class: 'p-list' },
    device.entries.map((e) =>
      h(
        'li',
        { class: 'p-row' },
        h('span', { class: 'who' }, e.name),
        h('span', { class: 'ty' }, e.mbti),
        editable
          ? h(
              'button',
              {
                type: 'button',
                class: 'p-small-btn',
                onclick: () => {
                  ui.entryDraft = { name: e.name, letters: [...e.mbti] };
                  ui.entryView = 'form';
                  ui.info = '';
                  render(true);
                },
              },
              '수정',
            )
          : null,
      ),
    ),
  );
}

function entryDone() {
  return [
    h('h1', { class: 'p-h' }, '제출 완료'),
    infoBox(),
    h('div', { class: 'p-card' }, h('p', { class: 'p-big' }, '스크린을 봐 주세요.'), h('p', { class: 'p-lead' }, '모두 입력하면 힌트가 공개됩니다. 마감 전에는 수정할 수 있어요.'), entryList(true)),
    h(
      'button',
      {
        type: 'button',
        class: 'p-btn ghost',
        onclick: () => {
          resetDraft(ui.entryDraft);
          ui.entryView = 'form';
          ui.info = '';
          render(true);
        },
      },
      '다른 사람도 입력하기 (휴대폰이 없는 친구)',
    ),
  ];
}

// ---------------------------------------------------------------------------
// 3단계: 우리 반 MBTI 예측
// ---------------------------------------------------------------------------

async function submitPrediction(allowUnlinked) {
  const d = ui.predictDraft;
  if (!draftValid(d) || ui.busy) return;
  ui.busy = true;
  ui.error = '';
  render(true);
  const data = await rpc('mbti_submit_prediction', {
    name: d.name,
    guess: d.letters.join(''),
    allow_unlinked: Boolean(allowUnlinked),
  });
  ui.busy = false;
  ui.confirm = null;
  if (data.ok) {
    upsert(device.predictions, { name: data.name, guess: data.guess });
    saveDevice();
    ui.info = `${data.name} 님의 예측 ${data.guess} 제출 완료!`;
    ui.predictView = 'done';
    resetDraft(d);
  } else if (data.code === 'confirm_unlinked') {
    ui.confirm = { kind: 'unlinked' };
  } else if (data.code === 'already') {
    upsert(device.predictions, { name: data.name, guess: data.guess });
    saveDevice();
    ui.info = `${data.name} 님은 이미 ${data.guess}(으)로 제출했어요. 예측은 바꿀 수 없어요.`;
    ui.predictView = 'done';
    resetDraft(d);
  } else {
    ui.error = data.message || '제출하지 못했습니다.';
  }
  render(true);
}

function predictForm() {
  const d = ui.predictDraft;
  const done = new Set(device.predictions.map((p) => keyOf(p.name)));
  const suggest = device.entries.filter((e) => !done.has(keyOf(e.name)));
  const nm = d.name.trim();

  let confirmBox = null;
  if (ui.confirm?.kind === 'submit') {
    confirmBox = h(
      'div',
      { class: 'p-confirm', role: 'alertdialog', 'aria-label': '제출 확인' },
      h('p', { class: 'p-big' }, `${nm} 님, ${d.letters.join('')}(으)로 제출할까요?`),
      h('p', { class: 'p-lead' }, '제출한 뒤에는 바꿀 수 없어요.'),
      h('button', { type: 'button', class: 'p-btn', disabled: ui.busy, onclick: () => submitPrediction(false) }, ui.busy ? '제출 중…' : '네, 제출할게요'),
      h('button', { type: 'button', class: 'p-btn ghost', onclick: () => { ui.confirm = null; render(true); } }, '다시 고르기'),
    );
  } else if (ui.confirm?.kind === 'unlinked') {
    confirmBox = h(
      'div',
      { class: 'p-confirm', role: 'alertdialog', 'aria-label': '이름 확인' },
      h('p', { class: 'p-big' }, `‘${nm}’ 이름은 첫 번째 입력 명단에 없어요.`),
      h('p', { class: 'p-lead' }, '첫 입력 때 쓴 이름과 같은지 확인해 주세요. 첫 입력을 못 했다면 그대로 제출해도 돼요.'),
      h('button', { type: 'button', class: 'p-btn', disabled: ui.busy, onclick: () => submitPrediction(true) }, ui.busy ? '제출 중…' : '이 이름으로 제출'),
      h('button', { type: 'button', class: 'p-btn ghost', onclick: () => { ui.confirm = null; render(true); document.getElementById('pname')?.focus(); } }, '이름 고치기'),
    );
  }

  return [
    h('h1', { class: 'p-h' }, '우리 반 MBTI 예측'),
    h('p', { class: 'p-lead' }, '힌트를 떠올리며, 우리 반 전체에서 더 많이 나온 글자를 영역마다 골라 주세요.'),
    h(
      'div',
      { class: 'p-card' },
      nameField(d, 'pname'),
      suggest.length
        ? h(
            'div',
            {},
            h('div', { class: 'p-chips', 'aria-label': '이 기기에서 입력한 이름' }, suggest.map((e) => h('button', { type: 'button', onclick: () => { d.name = e.name; ui.confirm = null; render(true); } }, e.name))),
          )
        : null,
      axisPicker(d),
    ),
    h(
      'ul',
      { class: 'p-notes' },
      h('li', {}, '첫 번째 입력 때와 같은 이름을 써 주세요.'),
      h('li', {}, '예측은 한 사람당 한 번만, 제출 후에는 수정할 수 없어요.'),
      h('li', {}, '정답자의 이름은 스크린에 공개됩니다.'),
    ),
    slots(d.letters, null, 'slots'),
    confirmBox ||
      h(
        'button',
        {
          id: 'submit',
          class: 'p-btn',
          type: 'button',
          disabled: true,
          onclick: () => {
            syncName(d);
            if (!draftValid(d)) return;
            ui.confirm = { kind: 'submit' };
            ui.error = '';
            render(true);
          },
        },
        '제출하기',
      ),
    errorBox(),
    device.predictions.length && !confirmBox
      ? h('button', { class: 'p-btn ghost', type: 'button', onclick: () => { ui.predictView = 'done'; ui.error = ''; render(true); } }, '취소')
      : null,
  ];
}

function predictionList() {
  return h(
    'ul',
    { class: 'p-list' },
    device.predictions.map((p) => h('li', { class: 'p-row' }, h('span', { class: 'who' }, p.name), h('span', { class: 'ty' }, p.guess))),
  );
}

function predictDone() {
  return [
    h('h1', { class: 'p-h' }, '예측 제출 완료'),
    infoBox(),
    h('div', { class: 'p-card' }, h('p', { class: 'p-big' }, '정답 공개를 기다려 주세요.'), h('p', { class: 'p-lead' }, '정답이 공개되면 이 화면에서 맞혔는지 바로 확인할 수 있어요.'), predictionList()),
    h(
      'button',
      {
        type: 'button',
        class: 'p-btn ghost',
        onclick: () => {
          resetDraft(ui.predictDraft);
          ui.predictView = 'form';
          ui.info = '';
          ui.confirm = null;
          render(true);
        },
      },
      '다른 사람도 제출하기 (휴대폰이 없는 친구)',
    ),
  ];
}

// ---------------------------------------------------------------------------
// 4단계: 정답 공개
// ---------------------------------------------------------------------------

function revealView() {
  const revealed = state.reveal; // 공개된 글자만 들어 있다
  const answerLetters = AXES.map((_, i) => (revealed[i] ? revealed[i].letter : null));
  const final = state.phase === 'winners' || state.phase === 'roster';
  const winners = new Set((state.winners?.names || []).map(keyOf));

  const cards = device.predictions.map((p) => {
    const marks = AXES.map((_, i) => (revealed[i] ? revealed[i].letter === 'X' || revealed[i].letter === p.guess[i] : null));
    const right = marks.filter((m) => m === true).length;
    let finalMsg = null;
    if (final) {
      finalMsg =
        right === 4
          ? '축하해요! 네 글자를 모두 맞혔어요.'
          : right === 3
            ? '아깝다! 세 글자를 맞혔어요.'
            : `${right}글자를 맞혔어요.`;
    }
    return h(
      'div',
      { class: 'p-card' },
      h('p', { class: 'p-result-name' }, `${p.name} 님의 예측`),
      slots([...p.guess], marks),
      h('p', { class: 'p-score' }, `공개 ${revealed.length}/4 · 현재 `, h('b', {}, `${right}개`), ' 맞힘'),
      finalMsg ? h('p', { class: 'p-info' }, finalMsg, winners.has(keyOf(p.name)) ? ' 스크린에 이름이 나와요!' : '') : null,
    );
  });

  return [
    h('h1', { class: 'p-h' }, final ? '최종 결과' : '정답 공개 중'),
    h('div', { class: 'p-card' }, h('p', { class: 'p-label' }, '우리 반 MBTI'), slots(answerLetters.map((l) => l || '?'), null), revealed.some((r) => r.letter === 'X') ? h('p', { class: 'p-lead' }, 'X는 동점인 영역이에요. 무엇을 골랐든 정답!') : null),
    cards.length ? cards : h('div', { class: 'p-card' }, h('p', { class: 'p-big' }, '이 기기에서 제출한 예측이 없어요.'), h('p', { class: 'p-lead' }, '스크린에서 결과를 함께 확인해 주세요.')),
  ];
}

// ---------------------------------------------------------------------------
// 화면 선택
// ---------------------------------------------------------------------------

function view() {
  const st = state;
  switch (st.phase) {
    case 'lobby':
      return { key: 'lobby', nodes: [h('h1', { class: 'p-h' }, '잠시 후 시작합니다'), h('div', { class: 'p-card' }, h('p', { class: 'p-big' }, '진행자가 시작하면 이 화면에 입력 칸이 나타나요.'), h('p', { class: 'p-lead' }, '이 화면을 켜 둔 채로 기다려 주세요.'))] };

    case 'input':
      if (st.entryOpen) {
        const v = ui.entryView || (device.entries.length ? 'done' : 'form');
        return { key: `input-${v}`, nodes: v === 'form' ? entryForm() : entryDone() };
      }
    // 마감되면 힌트 대기 화면과 같다
    // falls through
    case 'hints':
      return {
        key: 'hints',
        nodes: [
          h('h1', { class: 'p-h' }, '입력이 마감되었어요'),
          h('div', { class: 'p-card' }, h('p', { class: 'p-big' }, '스크린의 힌트를 보며 우리 반 MBTI를 추리해 보세요.'), h('p', { class: 'p-lead' }, '힌트가 끝나면 이 화면에서 예측을 제출해요.')),
          device.entries.length ? h('div', { class: 'p-card' }, h('p', { class: 'p-label' }, '이 기기에서 입력한 사람'), entryList(false)) : null,
        ],
      };

    case 'predict':
      if (st.predictionOpen) {
        const v = ui.predictView || (device.predictions.length ? 'done' : 'form');
        return { key: `predict-${v}`, nodes: v === 'form' ? predictForm() : predictDone() };
      }
      return {
        key: 'predict-closed',
        nodes: [
          h('h1', { class: 'p-h' }, '예측이 마감되었어요'),
          h('div', { class: 'p-card' }, h('p', { class: 'p-big' }, '곧 정답이 공개됩니다.'), device.predictions.length ? predictionList() : h('p', { class: 'p-lead' }, '이 기기에서 제출한 예측이 없어요.')),
        ],
      };

    default:
      return { key: `reveal-${st.phase}-${st.revealStep}`, nodes: revealView() };
  }
}

function render(force = false) {
  if (!state) return;
  const v = view();
  // 다른 사람이 제출할 때마다 상태가 바뀌므로, 보이는 화면이 같으면 다시 그리지 않아
  // 입력 중인 글자나 키보드 포커스가 사라지지 않게 한다
  if (!force && v.key === lastKey) return;
  if (v.key.split('-')[0] !== lastKey.split('-')[0]) {
    // 단계가 바뀌면 이전 단계의 안내·오류 문구는 지운다
    ui.error = '';
    ui.info = '';
    ui.confirm = null;
  }
  const active = document.activeElement?.id;
  lastKey = v.key;
  mount(root, h('div', { class: 'p-wrap' }, top(), v.nodes));
  updateSubmit();
  if (active === 'name' || active === 'pname') {
    const el = document.getElementById(active);
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }
}

subscribe(onState, {
  onConnection: (online) => {
    connEl.textContent = online ? '' : '연결 재시도 중…';
    connEl.classList.toggle('hidden', online);
  },
});
