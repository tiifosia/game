// 게임 규칙과 상태 전이를 담은 순수 함수 모음.
// Cloudflare API에 의존하지 않으므로 Node 테스트에서 그대로 불러 쓸 수 있다.

export const AXES = [
  { axis: 'E/I', a: 'E', b: 'I' },
  { axis: 'S/N', a: 'S', b: 'N' },
  { axis: 'T/F', a: 'T', b: 'F' },
  { axis: 'J/P', a: 'J', b: 'P' },
];

// 흔히 쓰는 4×4 MBTI 표 순서
export const TYPES = [
  'ISTJ', 'ISFJ', 'INFJ', 'INTJ',
  'ISTP', 'ISFP', 'INFP', 'INTP',
  'ESTP', 'ESFP', 'ENFP', 'ENTP',
  'ESTJ', 'ESFJ', 'ENFJ', 'ENTJ',
];

export const PHASES = ['lobby', 'input', 'hints', 'predict', 'reveal', 'winners', 'roster'];
export const HINT_COUNT = 6;
export const MAX_NAME_LENGTH = 20;
export const MAX_PEOPLE = 300;
export const MAX_TOTAL = 500;

const MBTI_RE = /^[EI][SN][TF][JP]$/;

// ---------------------------------------------------------------------------
// 입력 검증
// ---------------------------------------------------------------------------

/** 이름을 정리한다. 유효하지 않으면 null. */
export function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '') // 제어·서식 문자 제거
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 1 || [...name].length > MAX_NAME_LENGTH) return null;
  return name;
}

/** 동명이인이 없다는 전제에서 이름을 식별하는 키 */
export function nameKey(name) {
  return name.toLocaleLowerCase('ko-KR').replace(/\s+/g, '');
}

export function normalizeMbti(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase();
  return MBTI_RE.test(v) ? v : null;
}

// ---------------------------------------------------------------------------
// 집계와 힌트
// ---------------------------------------------------------------------------

export function countTypes(mbtiList) {
  const counts = Object.fromEntries(TYPES.map((t) => [t, 0]));
  for (const m of mbtiList) counts[m] += 1;
  return counts;
}

export function axisStats(mbtiList) {
  return AXES.map((ax, i) => {
    let countA = 0;
    let countB = 0;
    for (const m of mbtiList) {
      if (m[i] === ax.a) countA += 1;
      else countB += 1;
    }
    const letter = countA > countB ? ax.a : countB > countA ? ax.b : 'X';
    return { ...ax, countA, countB, diff: Math.abs(countA - countB), letter };
  });
}

/** 네 영역에서 더 많이 나온 글자. 동점이면 X. */
export function computeAnswer(mbtiList) {
  return axisStats(mbtiList).map((s) => s.letter).join('');
}

function pick(list, rng) {
  const i = Math.min(list.length - 1, Math.floor(rng() * list.length));
  return list[i];
}

/**
 * 입력 마감 시 한 번만 호출해 힌트를 계산한다.
 * rng는 동률 영역을 무작위로 고를 때 쓴다(테스트에서 주입).
 */
export function computeHints(mbtiList, rng = Math.random) {
  const counts = countTypes(mbtiList);
  const present = TYPES.filter((t) => counts[t] > 0);
  const singles = TYPES.filter((t) => counts[t] === 1);
  const stats = axisStats(mbtiList);

  // 3단계: 표 차이가 가장 작은 영역 (동률이면 무작위)
  const minDiff = Math.min(...stats.map((s) => s.diff));
  const closest = pick(stats.filter((s) => s.diff === minDiff), rng);

  // 4단계: 3단계 영역을 뺀 나머지 중 표 차이가 가장 큰 영역 (동률이면 무작위)
  const rest = stats.filter((s) => s.axis !== closest.axis);
  const maxDiff = Math.max(...rest.map((s) => s.diff));
  const dominant = pick(rest.filter((s) => s.diff === maxDiff), rng);

  // 5·6단계: 0명인 유형은 제외
  let fewest = [];
  let most = [];
  if (present.length > 0) {
    const minCount = Math.min(...present.map((t) => counts[t]));
    const maxCount = Math.max(...present.map((t) => counts[t]));
    fewest = present.filter((t) => counts[t] === minCount);
    most = present.filter((t) => counts[t] === maxCount);
  }

  const hints = [
    `우리 반에는 16개 유형 중 ${present.length}개가 있습니다.`,
    `혼자뿐인 유형은 ${singles.length}개입니다.`,
    `가장 치열한 영역은 ${closest.axis}이고, ${closest.diff}표 차이입니다.`,
    `가장 압도적인 영역은 ${dominant.axis}입니다.`,
    fewest.length ? `가장 적은 유형은 ${fewest.join(', ')}입니다.` : '입력한 사람이 없어 가장 적은 유형이 없습니다.',
    most.length ? `가장 많은 유형은 ${most.join(', ')}입니다.` : '입력한 사람이 없어 가장 많은 유형이 없습니다.',
  ];

  return {
    hints,
    answer: stats.map((s) => s.letter).join(''),
    axes: stats.map(({ axis, a, b, countA, countB, letter }) => ({ axis, a, b, countA, countB, letter })),
    detail: {
      presentCount: present.length,
      singleCount: singles.length,
      closestAxis: closest.axis,
      closestDiff: closest.diff,
      dominantAxis: dominant.axis,
      fewest,
      most,
    },
    entryCount: mbtiList.length,
  };
}

// ---------------------------------------------------------------------------
// 채점
// ---------------------------------------------------------------------------

export function letterCorrect(answerLetter, guessLetter) {
  return answerLetter === 'X' || answerLetter === guessLetter;
}

export function scoreGuess(answer, guess) {
  let score = 0;
  for (let i = 0; i < 4; i += 1) if (letterCorrect(answer[i], guess[i])) score += 1;
  return score;
}

const byName = (a, b) => a.localeCompare(b, 'ko-KR');

/** 네 글자 정답자, 없으면 세 글자 정답자 */
export function computeWinners(answer, predictions) {
  const scored = predictions.map((p) => ({ name: p.name, score: scoreGuess(answer, p.guess) }));
  for (const target of [4, 3]) {
    const names = scored.filter((s) => s.score === target).map((s) => s.name).sort(byName);
    if (names.length) return { score: target, names };
  }
  return { score: 0, names: [] };
}

export function computeRoster(entries) {
  return TYPES.map((type) => ({
    type,
    names: entries.filter((e) => e.mbti === type).map((e) => e.name).sort(byName),
  }));
}

// ---------------------------------------------------------------------------
// 상태와 전이
// ---------------------------------------------------------------------------

export function newGameId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createState(total = 30) {
  return {
    gameId: newGameId(),
    phase: 'lobby',
    total,
    entryOpen: false,
    predictionOpen: false,
    entries: {},
    predictions: {},
    computed: null,
    hintStep: 0,
    revealStep: 0,
    version: 1,
  };
}

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const entryList = (state) => Object.values(state.entries);
const predictionList = (state) => Object.values(state.predictions);

function closeEntries(state, rng) {
  state.entryOpen = false;
  state.computed = computeHints(entryList(state).map((e) => e.mbti), rng);
}

/** 플레이어: 이름과 내 MBTI 제출 (마감 전에는 같은 이름으로 다시 내면 수정) */
export function submitEntry(state, body) {
  if (state.phase !== 'input' || !state.entryOpen) {
    throw new GameError('closed', '지금은 MBTI를 입력할 수 없습니다.');
  }
  const name = normalizeName(body?.name);
  if (!name) throw new GameError('bad_name', `이름을 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`);
  const mbti = normalizeMbti(body?.mbti);
  if (!mbti) throw new GameError('bad_mbti', '네 영역을 모두 골라 주세요.');
  const key = nameKey(name);
  const updated = Boolean(state.entries[key]);
  if (!updated && entryList(state).length >= MAX_PEOPLE) {
    throw new GameError('full', '참여 인원이 너무 많습니다.');
  }
  state.entries[key] = { name, mbti, at: Date.now() };
  return { name, mbti, updated };
}

/** 플레이어: 우리 반 MBTI 예측 제출 (1인 1회, 수정 불가) */
export function submitPrediction(state, body) {
  if (state.phase !== 'predict' || !state.predictionOpen) {
    throw new GameError('closed', '지금은 예측을 제출할 수 없습니다.');
  }
  const name = normalizeName(body?.name);
  if (!name) throw new GameError('bad_name', `이름을 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`);
  const guess = normalizeMbti(body?.guess);
  if (!guess) throw new GameError('bad_mbti', '네 영역을 모두 골라 주세요.');
  const key = nameKey(name);
  const existing = state.predictions[key];
  if (existing) {
    const err = new GameError('already', `${existing.name} 님은 이미 예측을 제출했습니다.`);
    err.extra = { name: existing.name, guess: existing.guess };
    throw err;
  }
  const entry = state.entries[key];
  if (!entry && body?.allowUnlinked !== true) {
    throw new GameError('confirm_unlinked', '첫 번째 입력 명단에 없는 이름입니다.');
  }
  if (predictionList(state).length >= MAX_PEOPLE) {
    throw new GameError('full', '참여 인원이 너무 많습니다.');
  }
  // 첫 입력과 연결되면 그때 쓴 이름 표기를 그대로 쓴다
  const finalName = entry ? entry.name : name;
  state.predictions[key] = { name: finalName, guess, linked: Boolean(entry), at: Date.now() };
  return { name: finalName, guess, linked: Boolean(entry) };
}

/** 이 기기에서 제출한 이름들의 내 기록 (정답 정보는 포함하지 않음) */
export function lookupMine(state, names) {
  const list = Array.isArray(names) ? names.slice(0, 50) : [];
  const entries = [];
  const predictions = [];
  for (const raw of list) {
    const name = normalizeName(raw);
    if (!name) continue;
    const key = nameKey(name);
    if (state.entries[key]) entries.push({ name: state.entries[key].name, mbti: state.entries[key].mbti });
    if (state.predictions[key]) predictions.push({ name: state.predictions[key].name, guess: state.predictions[key].guess });
  }
  return { entries, predictions };
}

/** 진행자 조작 */
export function hostAction(state, body, rng = Math.random) {
  const action = body?.action;
  switch (action) {
    case 'next':
      return advance(state, rng);
    case 'closeEntry':
      if (state.phase !== 'input' || !state.entryOpen) throw new GameError('invalid', '입력을 마감할 수 있는 단계가 아닙니다.');
      closeEntries(state, rng);
      return;
    case 'reopenEntry':
      if (state.phase !== 'input' || state.entryOpen) throw new GameError('invalid', '입력을 다시 열 수 있는 단계가 아닙니다.');
      state.entryOpen = true;
      state.computed = null;
      return;
    case 'closePrediction':
      if (state.phase !== 'predict' || !state.predictionOpen) throw new GameError('invalid', '예측을 마감할 수 있는 단계가 아닙니다.');
      state.predictionOpen = false;
      return;
    case 'reopenPrediction':
      if (state.phase !== 'predict' || state.predictionOpen) throw new GameError('invalid', '예측을 다시 열 수 있는 단계가 아닙니다.');
      state.predictionOpen = true;
      return;
    case 'setTotal': {
      const n = Number(body?.total);
      if (!Number.isInteger(n) || n < 1 || n > MAX_TOTAL) throw new GameError('bad_total', `총인원은 1~${MAX_TOTAL} 사이로 입력해 주세요.`);
      state.total = n;
      return;
    }
    case 'reset': {
      const fresh = createState(state.total);
      fresh.version = state.version + 1;
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, fresh);
      return;
    }
    default:
      throw new GameError('bad_action', '알 수 없는 조작입니다.');
  }
}

function advance(state, rng) {
  switch (state.phase) {
    case 'lobby':
      state.phase = 'input';
      state.entryOpen = true;
      return;
    case 'input':
      if (state.entryOpen || !state.computed) closeEntries(state, rng);
      state.phase = 'hints';
      state.hintStep = 1;
      return;
    case 'hints':
      if (state.hintStep < HINT_COUNT) {
        state.hintStep += 1;
      } else {
        state.phase = 'predict';
        state.predictionOpen = true;
      }
      return;
    case 'predict':
      state.predictionOpen = false;
      state.phase = 'reveal';
      state.revealStep = 0;
      return;
    case 'reveal':
      if (state.revealStep < 4) state.revealStep += 1;
      else state.phase = 'winners';
      return;
    case 'winners':
      state.phase = 'roster';
      return;
    case 'roster':
      throw new GameError('invalid', '마지막 단계입니다.');
    default:
      throw new GameError('invalid', '알 수 없는 단계입니다.');
  }
}

// ---------------------------------------------------------------------------
// 보기(View): 무엇을 누구에게 보여 줄지
// ---------------------------------------------------------------------------

/**
 * 스크린과 휴대폰에 보내는 상태.
 * 공개된 힌트와 공개된 글자만 담는다. 정답·집계·정답 여부는 공개 전까지 절대 넣지 않는다.
 */
export function publicState(state) {
  const predictions = predictionList(state);
  const out = {
    gameId: state.gameId,
    version: state.version,
    phase: state.phase,
    total: state.total,
    entryOpen: state.entryOpen,
    entryCount: entryList(state).length,
    predictionOpen: state.predictionOpen,
    predictionCount: predictions.length,
    hintStep: 0,
    hints: [],
    revealStep: 0,
    reveal: [],
    winners: null,
    roster: null,
  };

  const idx = PHASES.indexOf(state.phase);
  if (state.computed && idx >= PHASES.indexOf('hints')) {
    const shown = state.phase === 'hints' ? state.hintStep : HINT_COUNT;
    out.hintStep = shown;
    out.hints = state.computed.hints.slice(0, shown);
  }

  if (state.computed && idx >= PHASES.indexOf('reveal')) {
    const shown = state.phase === 'reveal' ? state.revealStep : 4;
    out.revealStep = shown;
    out.reveal = state.computed.axes.slice(0, shown).map((ax, i) => ({
      axis: ax.axis,
      a: ax.a,
      b: ax.b,
      countA: ax.countA,
      countB: ax.countB,
      letter: ax.letter,
      correct: predictions.filter((p) => letterCorrect(ax.letter, p.guess[i])).length,
    }));
  }

  if (state.computed && idx >= PHASES.indexOf('winners')) {
    out.winners = computeWinners(state.computed.answer, predictions);
  }

  if (state.phase === 'roster') {
    out.roster = computeRoster(entryList(state));
  }

  return out;
}

/** 진행자 화면 전용 상태 (비밀번호 확인 후에만 내려준다) */
export function hostState(state) {
  const byAt = (a, b) => a.at - b.at;
  return {
    ...publicState(state),
    entryNames: entryList(state).sort(byAt).map((e) => e.name),
    predictionNames: predictionList(state).sort(byAt).map((p) => ({ name: p.name, linked: p.linked })),
    preview: state.computed
      ? { hints: state.computed.hints, answer: state.computed.answer, axes: state.computed.axes }
      : null,
  };
}
