// Word Drop — shared ranking board API
// GET    /api/scores               → 전체 기록
// POST   /api/scores               → 게임 결과 제출 (서버가 값의 타당성을 검사)
// DELETE /api/scores?id=<id>       → 기록 1개 삭제 (x-admin-token 헤더 필요)
// DELETE /api/scores?all=1         → 전체 삭제     (x-admin-token 헤더 필요)
import { getStore } from "@netlify/blobs";

const STORE = "word-drop";
const KEY = "scores-v1";
const MAX_PER_LANG = 500;
const LANGS = ["ko", "en"];
const MAX_POINTS_PER_WORD = 400;   // 가장 긴 단어 × 최대 콤보 배율보다 넉넉한 상한
const MIN_MS_PER_WORD = 400;       // 단어 하나를 0.4초 안에 잡는 건 불가능하다고 봄

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const sortRecs = (r) => r.slice().sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
const nameKey = (n) => n.trim().toLowerCase();
// 랭킹은 이름별 최고 기록 1개만
const bestPerName = (recs) => {
  const seen = new Set(), out = [];
  for (const r of sortRecs(recs)) { const k = nameKey(r.name); if (!seen.has(k)) { seen.add(k); out.push(r); } }
  return out;
};
const prune = (records) => LANGS.flatMap((l) => sortRecs(records.filter((r) => r.lang === l)).slice(0, MAX_PER_LANG));

async function read(store) {
  const res = await store.getWithMetadata(KEY, { type: "json" });
  if (!res) return { records: [], etag: null };
  return { records: Array.isArray(res.data) ? res.data : [], etag: res.etag };
}

// 동시 제출에도 기록이 유실되지 않도록 ETag 조건부 쓰기 + 재시도
async function update(store, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { records, etag } = await read(store);
    const { next, result } = fn(records);
    const { modified } = await store.setJSON(KEY, next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (modified) return result;
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 150 * (attempt + 1)));
  }
  throw new Error("busy");
}

const int = (v) => (Number.isInteger(v) ? v : NaN);

function validate(b) {
  if (!b || typeof b !== "object") return "invalid body";
  const name = String(b.name ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 16);
  if (!name) return "name required";
  if (!LANGS.includes(b.lang)) return "invalid lang";
  const score = int(b.score), caught = int(b.caught), wave = int(b.wave), combo = int(b.maxCombo), ms = int(b.ms);
  if ([score, caught, wave, combo, ms].some(Number.isNaN)) return "invalid stats";
  if (score <= 0 || caught <= 0) return "empty game";
  if (score > caught * MAX_POINTS_PER_WORD) return "score out of range";
  if (ms < caught * MIN_MS_PER_WORD || ms > 3 * 60 * 60 * 1000) return "invalid duration";
  if (combo > caught || combo < 0) return "invalid stats";
  if (wave < 1 || wave > 1 + Math.floor(caught / 8)) return "invalid stats";
  return { name, lang: b.lang, score, caught, wave, maxCombo: combo, seconds: Math.round(ms / 1000) };
}

export default async (req) => {
  const store = getStore({ name: STORE, consistency: "strong" });
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      const { records } = await read(store);
      return json({ records: sortRecs(records) });
    }

    if (req.method === "POST") {
      const text = await req.text();
      if (text.length > 2000) return json({ error: "payload too large" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "invalid json" }, 400); }
      const v = validate(body);
      if (typeof v === "string") return json({ error: v }, 400);
      const record = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), date: new Date().toISOString(), ...v };
      const result = await update(store, (records) => {
        const mine = records.filter((r) => r.lang === record.lang && nameKey(r.name) === nameKey(record.name));
        const prevBest = mine.length ? Math.max(...mine.map((r) => r.score)) : null;
        const next = prune([...records, record]);
        const board = bestPerName(next.filter((r) => r.lang === record.lang));
        const rank = board.findIndex((r) => nameKey(r.name) === nameKey(record.name)) + 1;
        return { next, result: { record, rank: rank || null, players: board.length, prevBest } };
      });
      return json(result, 201);
    }

    if (req.method === "DELETE") {
      const token = globalThis.Netlify?.env?.get?.("ADMIN_TOKEN") ?? process.env.ADMIN_TOKEN;
      if (!token || req.headers.get("x-admin-token") !== token) return json({ error: "forbidden" }, 403);
      const id = url.searchParams.get("id");
      const all = url.searchParams.get("all") === "1";
      if (!id && !all) return json({ error: "id or all=1 required" }, 400);
      const result = await update(store, (records) => {
        const next = all ? [] : records.filter((r) => r.id !== id);
        return { next, result: { removed: records.length - next.length } };
      });
      return json(result);
    }

    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    if (e && e.message === "busy") return json({ error: "busy, retry" }, 503);
    console.error(e);
    return json({ error: "server error" }, 500);
  }
};

export const config = { path: "/api/scores" };
