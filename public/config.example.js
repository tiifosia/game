// 이 파일을 config.js 로 복사하고 Supabase 값을 넣으면 로컬에서 실행할 수 있습니다.
// 배포할 때는 GitHub Actions가 저장소 Secrets(SUPABASE_URL, SUPABASE_ANON_KEY)로 config.js를 만듭니다.
// 두 값 모두 브라우저에 공개되는 값입니다(정답·비밀번호는 Supabase 서버 쪽에만 있음).
window.MBTI_CONFIG = {
  supabaseUrl: 'https://xxxxxxxx.supabase.co',
  supabaseKey: 'sb_publishable_... 또는 anon key',
};
