-- 토몽이와 이지의 방 — 랭킹 서버 (Cloudflare D1)
-- 닉네임당 최고 기록 1개. 닉네임은 처음 등록한 기기(device)가 주인.

CREATE TABLE IF NOT EXISTS scores (
  name_key   TEXT PRIMARY KEY,          -- 비교용 닉네임 (소문자, 공백 정리)
  name       TEXT NOT NULL,             -- 화면에 보이는 닉네임
  score      INTEGER NOT NULL,
  max_tier   INTEGER NOT NULL,          -- 최고 진화 단계 (0~10)
  device     TEXT NOT NULL,             -- 처음 등록한 기기 id (닉네임 주인)
  date       TEXT NOT NULL,             -- 최고 기록 날짜 (한국 시간 YYYY-MM-DD)
  created_at INTEGER NOT NULL,          -- 처음 등록 (ms)
  updated_at INTEGER NOT NULL           -- 최고 기록 갱신 (ms) — 동점이면 먼저 세운 기록이 위
);
CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores (score DESC, updated_at ASC);

-- 요청 제한용 기록 (하루 지난 것은 자동 삭제)
CREATE TABLE IF NOT EXISTS submits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  device  TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submits_device ON submits (device, at);
CREATE INDEX IF NOT EXISTS idx_submits_ip ON submits (ip_hash, at);
