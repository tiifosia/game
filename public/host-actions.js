// 진행자 조작에서 함께 쓰는 정의 (진행자 화면 host/ 와 스크린 화면 screen/ 의 조작 바)
import { AXES } from './common.js';

export const TOKEN_KEY = 'mbti-game-host';

export const PHASE_NAME = {
  lobby: '시작 전 대기',
  input: '1단계 · 내 MBTI 입력',
  hints: '2단계 · 힌트 공개',
  predict: '3단계 · 우리 반 MBTI 예측',
  reveal: '4단계 · 정답 공개',
  winners: '4단계 · 정답자 발표',
  roster: '4단계 · 유형별 명단',
};

/** 지금 단계에서 '다음' 버튼이 할 일. confirm이 있으면 누르기 전에 확인을 받는다 */
export function primary(st) {
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
