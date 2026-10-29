/**
 * 토몽이와 이지의 방 — 랭킹 서버 (Cloudflare Worker + D1)
 *
 *  GET  /api/health                → { ok }
 *  GET  /api/top?limit=10          → { ok, total, rows: [{ rank, name, score, maxTier, date }] }
 *  GET  /api/rank?score=1234       → { ok, rank }      이 점수를 지금 등록하면 몇 위인지 (동점은 기존 기록이 위)
 *  GET  /api/me?name=닉네임         → { ok, row | null }
 *  POST /api/submit  { name, score, maxTier, device }
 *       → { ok, rank, updated, row }   updated=false 면 기존 최고 기록이 더 높아 그대로
 *       → { ok:false, error }          invalid_name / bad_word / invalid_score / name_taken / rate_limited
 *  DELETE /api/admin/entry?name=닉네임  (Authorization: Bearer <ADMIN_TOKEN>)
 *
 *  규칙
 *   - 닉네임당 최고 기록 1개. 닉네임은 처음 등록한 기기만 쓸 수 있음 (다른 기기는 name_taken)
 *   - 점수 1 ~ 99,999,999, 최고 진화 1~10단계, 그 단계를 만들 때 받는 점수 이상이어야 함
 *   - 같은 기기 5초에 1번, 같은 IP 10분에 30번까지
 */

const NAME_MAX = 10;
const SCORE_MAX = 99_999_999;
const TOP_MAX = 50;
// 게임 js/config.js tiers[].score 와 같아야 함 (그 단계를 처음 만들 때 받는 점수)
const TIER_SCORE = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66];
// 아주 기본적인 금지어 (부분 일치, 공백 제거 후 비교). 필요하면 늘리세요
const BAD_WORDS = ['시발', '씨발', 'ㅅㅂ', '병신', 'ㅂㅅ', '좆', '존나', '개새', '새끼', '지랄', '미친년', '미친놈', 'fuck', 'shit', 'bitch', 'nigger', 'admin', '관리자', '운영자'];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    try {
      let res;
      if (url.pathname === '/api/health') res = json({ ok: true });
      else if (url.pathname === '/api/top' && request.method === 'GET') res = await top(url, env);
      else if (url.pathname === '/api/rank' && request.method === 'GET') res = await rankOf(url, env);
      else if (url.pathname === '/api/me' && request.method === 'GET') res = await me(url, env);
      else if (url.pathname === '/api/submit' && request.method === 'POST') res = await submit(request, env, ctx);
      else if (url.pathname === '/api/admin/entry' && request.method === 'DELETE') res = await adminDelete(request, url, env);
      else res = json({ ok: false, error: 'not_found' }, 404);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: 'server_error' }, 500, cors);
    }
  },
};

/* ---------- 조회 ---------- */
async function top(url, env) {
  const limit = clampInt(url.searchParams.get('limit'), 1, TOP_MAX, 10);
  const { results } = await env.DB.prepare(
    'SELECT name, score, max_tier, date FROM scores ORDER BY score DESC, updated_at ASC LIMIT ?'
  ).bind(limit).all();
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM scores').first()).n;
  return json({ ok: true, total, rows: results.map((r, i) => out(r, i + 1)) }, 200, { 'Cache-Control': 'no-store' });
}

async function rankOf(url, env) {
  const score = Number(url.searchParams.get('score'));
  if (!Number.isInteger(score) || score < 1 || score > SCORE_MAX) return json({ ok: false, error: 'invalid_score' }, 400);
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE score >= ?').bind(score).first()).n;
  return json({ ok: true, rank: n + 1 });
}

async function me(url, env) {
  const key = nameKey(cleanName(url.searchParams.get('name')));
  if (!key) return json({ ok: true, row: null });
  const r = await env.DB.prepare('SELECT name, score, max_tier, date, updated_at FROM scores WHERE name_key = ?').bind(key).first();
  if (!r) return json({ ok: true, row: null });
  return json({ ok: true, row: out(r, await rankOfRow(env, r.score, r.updated_at)) });
}

/* ---------- 등록 ---------- */
async function submit(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_request' }, 400); }
  const name = cleanName(body.name);
  if (!name || !validName(name)) return json({ ok: false, error: 'invalid_name' }, 400);
  if (hasBadWord(name)) return json({ ok: false, error: 'bad_word' }, 400);
  const score = body.score, maxTier = body.maxTier;
  if (!Number.isInteger(score) || score < 1 || score > SCORE_MAX) return json({ ok: false, error: 'invalid_score' }, 400);
  if (!Number.isInteger(maxTier) || maxTier < 1 || maxTier >= TIER_SCORE.length) return json({ ok: false, error: 'invalid_score' }, 400);
  if (score < TIER_SCORE[maxTier]) return json({ ok: false, error: 'invalid_score' }, 400);
  const device = String(body.device || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(device)) return json({ ok: false, error: 'bad_request' }, 400);

  // 요청 제한
  const now = Date.now();
  const ipHash = await sha256(request.headers.get('CF-Connecting-IP') || 'unknown');
  const lim = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM submits WHERE device = ?1 AND at > ?2) AS d, (SELECT COUNT(*) FROM submits WHERE ip_hash = ?3 AND at > ?4) AS i'
  ).bind(device, now - 5_000, ipHash, now - 600_000).first();
  if (lim.d >= 1 || lim.i >= 30) return json({ ok: false, error: 'rate_limited' }, 429);

  const key = nameKey(name);
  const date = kstDate(now);
  const cur = await env.DB.prepare('SELECT name, score, max_tier, device, date, updated_at FROM scores WHERE name_key = ?').bind(key).first();
  if (cur && cur.device !== device) return json({ ok: false, error: 'name_taken' }, 409);

  // 요청 제한 기록은 실제로 등록을 처리할 때만 남김 (잘못 입력해서 거절된 시도는 세지 않음)
  await env.DB.prepare('INSERT INTO submits (device, ip_hash, at) VALUES (?, ?, ?)').bind(device, ipHash, now).run();
  ctx.waitUntil(env.DB.prepare('DELETE FROM submits WHERE at < ?').bind(now - 86_400_000).run());

  let updated = false, row;
  if (!cur) {
    await env.DB.prepare('INSERT INTO scores (name_key, name, score, max_tier, device, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(key, name, score, maxTier, device, date, now, now).run();
    updated = true; row = { name, score, max_tier: maxTier, date, updated_at: now };
  } else if (score > cur.score) {
    await env.DB.prepare('UPDATE scores SET name = ?, score = ?, max_tier = ?, date = ?, updated_at = ? WHERE name_key = ?')
      .bind(name, score, maxTier, date, now, key).run();
    updated = true; row = { name, score, max_tier: maxTier, date, updated_at: now };
  } else {
    row = cur;
  }
  const rank = await rankOfRow(env, row.score, row.updated_at);
  return json({ ok: true, updated, rank, row: out(row, rank) });
}

/* ---------- 관리자 ---------- */
async function adminDelete(request, url, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ ok: false, error: 'unauthorized' }, 401);
  const key = nameKey(cleanName(url.searchParams.get('name')));
  if (!key) return json({ ok: false, error: 'invalid_name' }, 400);
  const r = await env.DB.prepare('DELETE FROM scores WHERE name_key = ?').bind(key).run();
  return json({ ok: true, deleted: r.meta.changes });
}

/* ---------- 도우미 ---------- */
async function rankOfRow(env, score, updatedAt) {
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE score > ?1 OR (score = ?1 AND updated_at < ?2)').bind(score, updatedAt).first()).n;
  return n + 1;
}
const out = (r, rank) => ({ rank, name: r.name, score: r.score, maxTier: r.max_tier, date: r.date });

function cleanName(name) {
  const n = String(name ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, '').replace(/\s+/g, ' ').trim();
  return n ? Array.from(n).slice(0, NAME_MAX).join('') : '';
}
// 한글·영문·숫자·공백과 몇 가지 기호만
function validName(n) { return /^[\p{Script=Hangul}A-Za-z0-9 _\-.~!?♡♥☆★()]+$/u.test(n) && /[\p{Script=Hangul}A-Za-z0-9]/u.test(n); }
const nameKey = (n) => (n ? n.toLowerCase() : '');
function hasBadWord(n) {
  const s = n.toLowerCase().replace(/[\s_\-.~!?()]/g, '');
  return BAD_WORDS.some((w) => s.includes(w));
}
function kstDate(ms) {
  const d = new Date(ms + 9 * 3600_000);
  return d.toISOString().slice(0, 10);
}
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tomong:' + s));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function clampInt(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin' };
  if (allowed.includes('*') || allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin || '*';
    h['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
