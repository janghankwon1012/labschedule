// ============================================================================
// labsched 설정 — 이 파일만 채우면 됩니다.
//
// Supabase 대시보드 → Project Settings → API 에서 복사:
//   Project URL          → SUPABASE_URL
//   anon public key      → SUPABASE_ANON_KEY   (공개되어도 안전한 키. RLS 가 데이터를 보호함)
//
// ※ service_role 키는 절대 여기에 넣지 마세요.
// ============================================================================
window.LABSCHED_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",

  // 화면 표시용
  LAB_NAME: "실험실 장비 예약",

  // 캘린더 표시 범위·시간 단위
  SLOT_MINUTES: 30,
  DAY_START: "07:00:00",
  DAY_END: "24:00:00",
};
