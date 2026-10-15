/**
 * 網管小學堂 班級 API（Cloudflare Worker + KV）
 *
 * 依前端 web/js/app.js 的呼叫方式反推出的介面，重新實作。
 * 同一個 Worker 同時負責：
 *   - /api/*          班級／學員 API（本檔）
 *   - 其他路徑        靜態網頁（wrangler.toml 的 [assets] 指到 ../web）
 *
 * KV 鍵值配置（KV 命名空間綁定為 DB）：
 *   class:{CODE}            班級本體 {code,name,key,cfg,created,nextId}
 *   stu:{CODE}:{id}         學員紀錄 {id,name,resume,tokens,school,cards,lv,last_seen,cur_lv,cur_at,created}
 *   saves:{CODE}:{id}       學員各關存檔 {[lvNo]:{cur,done}}
 *   name:{CODE}:{NAME}      名字索引 → id（NAME 為正規化後的名字）
 *   tok:{TOKEN}             學員 token → {code,id}
 *
 * 環境變數／Secret：
 *   TEACHER_SECRET          講師開班密碼（wrangler secret put TEACHER_SECRET；本機開發放 .dev.vars）
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const MAX_BODY = 1_000_000;          // 單次請求本體上限（bytes）
const MAX_EVENTS = 100;              // 單次 /event 事件數上限（前端一次最多送 100 筆）
const MAX_SAVE_EVENTS = 5000;        // 單關存檔的操作步數上限
const MAX_TOKENS = 5;                // 每位學員同時有效的 token 數（多台裝置）
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,11}$/;

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: JSON_HEADERS });
const err = (msg, status = 400, extra = {}) => json({ error: msg, ...extra }, status);

/* ---------- 隨機字串 ---------- */
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 I O 0 1
function rand(n, alphabet = ALNUM) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  let s = ''; for (const b of a) s += alphabet[b % alphabet.length]; return s;
}
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

/* 固定時間比對，避免用回應時間猜金鑰 */
function safeEq(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const normCode = c => String(c ?? '').toUpperCase().replace(/\s/g, '');
const normName = n => String(n ?? '').trim().replace(/\s+/g, ' ').slice(0, 20);
const nameKey = n => normName(n).toLowerCase();
const bearer = req => { const h = req.headers.get('authorization') || ''; const m = /^Bearer\s+(.+)$/i.exec(h); return m ? m[1].trim() : ''; };

async function readJson(req) {
  const len = +(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw err('內容太大。', 413);
  const text = await req.text();
  if (text.length > MAX_BODY) throw err('內容太大。', 413);
  try { return text ? JSON.parse(text) : {}; } catch { throw err('不是正確的 JSON。'); }
}

/* ---------- 學校網路設定（cfg / school）白名單清理 ---------- */
const STR = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : undefined;
const INT = v => Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? +v : undefined);
const SCHOOL_KEYS = ['net', 'gw', 'dhcp', 'domain', 'ssid', 'school', 'blds'];
const CLASS_KEYS = [...SCHOOL_KEYS, 'dns', 'up', 'upShort', 'tel', 'split'];
function cleanSchool(o, allowed) {
  if (o == null) return null;
  if (typeof o !== 'object' || Array.isArray(o)) throw err('學校設定格式不對。');
  const out = {};
  for (const k of allowed) {
    const v = o[k]; if (v == null || v === '') continue;
    switch (k) {
      case 'gw': { const n = INT(v); if (n == null || n < 1 || n > 254) throw err('閘道要是 1–254 的數字。'); out.gw = n; break; }
      case 'dhcp': { if (!Array.isArray(v) || v.length !== 2) throw err('DHCP 範圍格式不對。'); const a = INT(v[0]), b = INT(v[1]);
        if (a == null || b == null || a < 1 || b > 254 || a > b) throw err('DHCP 範圍要是 1–254 之間，起不能大於迄。'); out.dhcp = [a, b]; break; }
      case 'ssid': { if (typeof v !== 'object') throw err('SSID 格式不對。'); const s = {};
        for (const kk of ['t', 's', 'g', 'i']) { const x = STR(v[kk], 32); if (x) s[kk] = x; }
        if (Object.keys(s).length) out.ssid = s; break; }
      case 'split': { if (typeof v !== 'object') throw err('分工設定格式不對。'); const s = {};
        for (const kk of ['fiber', 'fw', 'core']) { const n = INT(v[kk]); if (n != null && n >= 0 && n <= 3) s[kk] = n; }
        if (Object.keys(s).length) out.split = s; break; }
      case 'net': { const x = STR(v, 15); if (x && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(x)) throw err('校內網段要像 192.168.88 這樣的前三段。'); if (x) out.net = x; break; }
      default: { const x = STR(v, k === 'blds' ? 60 : 40); if (x) out[k] = x; }
    }
  }
  return Object.keys(out).length ? out : null;
}

/* ---------- KV 存取 ---------- */
const K = {
  cls: code => `class:${code}`,
  stu: (code, id) => `stu:${code}:${id}`,
  saves: (code, id) => `saves:${code}:${id}`,
  name: (code, name) => `name:${code}:${nameKey(name)}`,
  tok: t => `tok:${t}`,
};
const getJ = (env, k) => env.DB.get(k, 'json');
const putJ = (env, k, v) => env.DB.put(k, JSON.stringify(v));

async function loadClass(env, code) { return CODE_RE.test(code) ? getJ(env, K.cls(code)) : null; }
async function teacherAuth(env, req, code) {
  const c = await loadClass(env, code);
  if (!c || !safeEq(bearer(req), c.key)) throw err('班級代碼或講師金鑰不對。', 403);
  return c;
}
async function studentAuth(env, req) {
  const t = bearer(req); if (!t) throw err('請先加入班級。', 401);
  const ref = await getJ(env, K.tok(t)); if (!ref) throw err('登入已失效，請重新加入。', 401);
  const s = await getJ(env, K.stu(ref.code, ref.id));
  if (!s || !(s.tokens || []).includes(t)) throw err('登入已失效，請重新加入。', 401);
  const c = await loadClass(env, ref.code); if (!c) throw err('班級已不存在。', 401);
  return { c, s, token: t };
}
async function listStudents(env, code) {
  const out = []; let cursor;
  do {
    const r = await env.DB.list({ prefix: `stu:${code}:`, cursor });
    const vals = await Promise.all(r.keys.map(k => getJ(env, k.name)));
    for (const v of vals) if (v) out.push(v);
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out.sort((a, b) => a.id - b.id);
}

/* ---------- 回應給學員的個人資料 ---------- */
const meView = (c, s) => ({
  lv: Object.fromEntries(Object.entries(s.lv || {}).filter(([, p]) => p.s > 0).map(([k, p]) => [k, p.s])),
  cd: Object.keys(s.cards || {}),
  className: c.name, resume: s.resume, cfg: c.cfg || null, school: s.school || null,
});

/* ---------- 事件處理：把前端 track() 送來的事件累計到學員紀錄 ---------- */
function applyEvents(s, saves, events, now) {
  let savesDirty = false;
  const lv = s.lv = s.lv || {};
  const P = n => { const k = String(n); return lv[k] = lv[k] || { s: 0, a: 0, ms: 0, w: 0 }; };
  const lvOk = n => Number.isInteger(+n) && +n >= 0 && +n < 200;
  const T = x => x && typeof x.t === 'number' ? x.t : 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    switch (ev.t) {
      case 'open': if (lvOk(ev.lv)) { P(ev.lv); s.cur_lv = +ev.lv; s.cur_at = now; } break;
      case 'test': if (lvOk(ev.lv)) { const p = P(ev.lv); p.a++; p.ms += Math.max(0, Math.min(+ev.ms || 0, 15 * 60e3)); } break;
      case 'time': if (lvOk(ev.lv)) { const p = P(ev.lv); p.ms += Math.max(0, Math.min(+ev.ms || 0, 15 * 60e3)); } break;
      case 'win': if (lvOk(ev.lv)) { const p = P(ev.lv), st = Math.max(0, Math.min(+ev.stars || 0, 3));
        p.s = Math.max(p.s, st); p.w = 1; if (ev.hints != null) p.h = Math.max(0, Math.min(+ev.hints || 0, 999)); } break;
      case 'card': if (typeof ev.card === 'string' && ev.card.length <= 40) (s.cards = s.cards || {})[ev.card] = 1; break;
      case 'sync':
        if (ev.lv && typeof ev.lv === 'object') for (const k in ev.lv) if (lvOk(k)) { const p = P(k), st = Math.max(0, Math.min(+ev.lv[k] || 0, 3)); if (st > p.s) { p.s = st; p.w = 1; } }
        if (Array.isArray(ev.cd)) for (const c of ev.cd.slice(0, 200)) if (typeof c === 'string' && c.length <= 40) (s.cards = s.cards || {})[c] = 1;
        break;
      case 'save': if (lvOk(ev.lv)) {
        const k = String(ev.lv), cur = saves[k] = saves[k] || {};
        const ok = r => r && typeof r === 'object' && Array.isArray(r.e) && r.e.length <= MAX_SAVE_EVENTS && Number.isFinite(r.s);
        if (ok(ev.cur) && T(ev.cur) > T(cur.cur)) { cur.cur = ev.cur; savesDirty = true; }
        if (ok(ev.done) && T(ev.done) > T(cur.done)) { cur.done = ev.done; savesDirty = true; if (ev.done.w) { const p = P(k); p.s = Math.max(p.s, Math.min(+ev.done.w, 3)); p.w = 1; } }
        if (ev.cur === null && cur.cur) { /* 前端送 null 表示該關已重開，不刪雲端的 cur，講師仍可回看 */ }
      } break;
      default: break;
    }
  }
  s.last_seen = now;
  return savesDirty;
}

/* ---------- 路由 ---------- */
async function handleApi(req, env, path) {
  const m = req.method;
  const seg = path.split('/').filter(Boolean); // ['api', ...]
  const now = Date.now();

  /* 學員：加入班級 */
  if (seg.length === 2 && seg[1] === 'join' && m === 'POST') {
    const b = await readJson(req);
    const code = normCode(b.code), name = normName(b.name), resume = normCode(b.resume);
    if (!CODE_RE.test(code)) return err('班級代碼格式不對。');
    if (!name) return err('請輸入名字。');
    const c = await loadClass(env, code); if (!c) return err('找不到這個班級代碼。', 404);
    const existId = await env.DB.get(K.name(code, name));
    let s;
    if (existId != null) {
      s = await getJ(env, K.stu(code, existId));
      if (s) {
        if (!resume) return err('這個名字已經有人用了。', 409, { need: 'resume' });
        if (!safeEq(resume, s.resume)) return err('復原碼不對。', 403, { need: 'resume' });
      }
    }
    if (!s) {
      c.nextId = (c.nextId || 0) + 1;
      s = { id: c.nextId, name, resume: rand(6), tokens: [], school: null, cards: {}, lv: {}, created: now, last_seen: now, cur_lv: null, cur_at: null };
      await putJ(env, K.cls(code), c);
      await env.DB.put(K.name(code, name), String(s.id));
    }
    const token = hex(24);
    s.tokens = [...(s.tokens || []), token].slice(-MAX_TOKENS);
    s.last_seen = now;
    await Promise.all([putJ(env, K.stu(code, s.id), s), putJ(env, K.tok(token), { code, id: s.id })]);
    return json({ token, code, name: s.name, className: c.name, resume: s.resume, cfg: c.cfg || null, school: s.school || null });
  }

  /* 學員：需要 token 的路由 */
  if (seg[1] === 'me' || seg[1] === 'saves' || seg[1] === 'event') {
    const { c, s } = await studentAuth(env, req);
    const code = c.code;
    if (seg.length === 2 && seg[1] === 'me' && m === 'GET') return json(meView(c, s));
    if (seg.length === 3 && seg[1] === 'me' && seg[2] === 'school' && m === 'PUT') {
      const b = await readJson(req);
      s.school = cleanSchool(b.school, SCHOOL_KEYS);
      await putJ(env, K.stu(code, s.id), s);
      return json({ school: s.school || {} });
    }
    if (seg.length === 2 && seg[1] === 'saves' && m === 'GET') {
      const saves = (await getJ(env, K.saves(code, s.id))) || {};
      return json({ saves });
    }
    if (seg.length === 2 && seg[1] === 'event' && m === 'POST') {
      const b = await readJson(req);
      const events = Array.isArray(b.events) ? b.events.slice(0, MAX_EVENTS) : [];
      const saves = (await getJ(env, K.saves(code, s.id))) || {};
      const dirty = applyEvents(s, saves, events, now);
      const w = [putJ(env, K.stu(code, s.id), s)];
      if (dirty) w.push(putJ(env, K.saves(code, s.id), saves));
      await Promise.all(w);
      return json({ ok: true, n: events.length });
    }
    return err('找不到這個路徑。', 404);
  }

  /* 講師：開班 */
  if (seg.length === 2 && seg[1] === 'class' && m === 'POST') {
    const b = await readJson(req);
    if (!env.TEACHER_SECRET) return err('伺服器尚未設定 TEACHER_SECRET。', 500);
    if (!safeEq(b.secret, env.TEACHER_SECRET)) return err('講師密碼不對。', 403);
    const name = STR(b.name, 40); if (!name) return err('請輸入班級名稱。');
    const cfg = cleanSchool(b.cfg, CLASS_KEYS);
    let code = normCode(b.code);
    if (code) {
      if (!CODE_RE.test(code)) return err('班級代碼只能用英數字和 -，3 到 12 個字。');
      if (await loadClass(env, code)) return err('這個班級代碼已經有人用了。', 409);
    } else {
      do code = 'NET-' + rand(4); while (await loadClass(env, code));
    }
    const c = { code, name, key: rand(12), cfg, created: now, nextId: 0 };
    await putJ(env, K.cls(code), c);
    return json({ code: c.code, name: c.name, key: c.key, cfg: c.cfg });
  }

  /* 講師：班級相關 */
  if (seg[1] === 'class' && seg.length >= 3) {
    const code = normCode(decodeURIComponent(seg[2]));
    const c = await teacherAuth(env, req, code);
    if (seg.length === 3 && m === 'GET') {
      const S = await listStudents(env, code);
      return json({
        code: c.code, name: c.name, cfg: c.cfg || null, now,
        students: S.map(s => ({
          id: s.id, name: s.name, resume: s.resume, cards: Object.keys(s.cards || {}).length,
          last_seen: s.last_seen || 0, cur_lv: s.cur_lv ?? null, cur_at: s.cur_at ?? null,
          school: s.school || null, lv: s.lv || {},
        })),
      });
    }
    if (seg.length === 3 && m === 'PUT') {
      const b = await readJson(req);
      if ('cfg' in b) c.cfg = cleanSchool(b.cfg, CLASS_KEYS);
      if (b.name != null) { const n = STR(b.name, 40); if (n) c.name = n; }
      await putJ(env, K.cls(code), c);
      return json({ code: c.code, name: c.name, cfg: c.cfg || null });
    }
    if (seg.length >= 5 && seg[3] === 'student') {
      const id = +seg[4]; if (!Number.isInteger(id)) return err('學員編號不對。');
      const s = await getJ(env, K.stu(code, id)); if (!s) return err('找不到這位學員。', 404);
      if (seg.length === 5 && m === 'DELETE') {
        await Promise.all([
          env.DB.delete(K.stu(code, id)), env.DB.delete(K.saves(code, id)), env.DB.delete(K.name(code, s.name)),
          ...(s.tokens || []).map(t => env.DB.delete(K.tok(t))),
        ]);
        return json({ ok: true });
      }
      if (seg.length === 7 && seg[5] === 'save' && m === 'GET') {
        const saves = (await getJ(env, K.saves(code, id))) || {};
        const r = saves[String(+seg[6])] || {};
        return json({ cur: r.cur || null, done: r.done || null });
      }
    }
    return err('找不到這個路徑。', 404);
  }

  return err('找不到這個路徑。', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try { return await handleApi(req, env, url.pathname); }
      catch (e) {
        if (e instanceof Response) return e;
        console.error(e);
        return err('伺服器發生錯誤。', 500);
      }
    }
    // 非 /api 的路徑交給靜態資源（../web）
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Not found', { status: 404 });
  },
};
