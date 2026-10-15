import worker from '../src/index.js';
// 記憶體版 KV
const store = new Map();
const DB = {
  async get(k, t) { const v = store.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; }
};
const env = { DB, TEACHER_SECRET: 'test-secret' };
let fails = 0;
async function call(method, path, { body, token, raw } = {}) {
  const h = { 'content-type': 'application/json' }; if (token) h.authorization = 'Bearer ' + token;
  const r = await worker.fetch(new Request('https://x.test' + path, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) }), env);
  let d = {}; try { d = await r.json(); } catch { } return { status: r.status, d };
}
function ok(name, cond, extra = '') { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) fails++; }

// 講師開班
let r = await call('POST', '/api/class', { body: { secret: 'wrong', name: 'X' } }); ok('開班：密碼錯 → 403', r.status === 403);
r = await call('POST', '/api/class', { body: { secret: 'test-secret', name: '10/8 新竹場', code: 'net-km2026', cfg: { net: '10.10.10', gw: 254, dhcp: [101, 200], ssid: { t: 'T-SSID' }, dns: '163.19.1.1', split: { fiber: 3 } } } });
ok('開班成功', r.status === 200 && r.d.code === 'NET-KM2026' && r.d.key.length === 12, JSON.stringify(r.d));
const KEY = r.d.key, CODE = r.d.code;
r = await call('POST', '/api/class', { body: { secret: 'test-secret', name: 'dup', code: 'NET-KM2026' } }); ok('重複代碼 → 409', r.status === 409);
r = await call('POST', '/api/class', { body: { secret: 'test-secret', name: 'auto' } }); ok('自動產生代碼 NET-XXXX', /^NET-[A-Z2-9]{4}$/.test(r.d.code), r.d.code);
r = await call('GET', '/api/class/NET-KM2026', { token: 'BADKEY' }); ok('講師金鑰錯 → 403', r.status === 403 && /不對/.test(r.d.error));
r = await call('GET', '/api/class/net-km2026', { token: KEY }); ok('讀班級（小寫代碼可用）', r.status === 200 && r.d.name === '10/8 新竹場' && r.d.students.length === 0 && r.d.cfg.net === '10.10.10');

// 學員加入
r = await call('POST', '/api/join', { body: { code: 'XXXX', name: '王小明' } }); ok('加入：班級不存在 → 404', r.status === 404);
r = await call('POST', '/api/join', { body: { code: 'net-km2026', name: ' 07 王小明 ' } });
ok('加入成功', r.status === 200 && r.d.token && r.d.resume.length === 6 && r.d.className === '10/8 新竹場' && r.d.cfg.net === '10.10.10' && r.d.name === '07 王小明', JSON.stringify(r.d));
const TOK = r.d.token, RESUME = r.d.resume;
r = await call('POST', '/api/join', { body: { code: CODE, name: '07 王小明' } }); ok('同名無復原碼 → 409 need resume', r.status === 409 && r.d.need === 'resume');
r = await call('POST', '/api/join', { body: { code: CODE, name: '07 王小明', resume: 'ZZZZZZ' } }); ok('復原碼錯 → 403 need resume', r.status === 403 && r.d.need === 'resume');
r = await call('POST', '/api/join', { body: { code: CODE, name: '07 王小明', resume: RESUME.toLowerCase() } }); ok('復原碼正確 → 接回（新 token）', r.status === 200 && r.d.token !== TOK && r.d.resume === RESUME);
const TOK2 = r.d.token;
r = await call('POST', '/api/join', { body: { code: CODE, name: '08 李小華' } }); ok('第二位學員加入', r.status === 200);

// 學員 API
r = await call('GET', '/api/me'); ok('無 token → 401', r.status === 401);
r = await call('GET', '/api/me', { token: 'deadbeef' }); ok('壞 token → 401', r.status === 401);
r = await call('GET', '/api/me', { token: TOK }); ok('舊 token 仍有效（多裝置）', r.status === 200 && JSON.stringify(r.d.lv) === '{}' && Array.isArray(r.d.cd));
r = await call('POST', '/api/event', { token: TOK, body: { events: [
  { t: 'open', lv: 1 }, { t: 'test', lv: 1, ms: 30000 }, { t: 'test', lv: 1, ms: 20000 }, { t: 'time', lv: 1, ms: 5000 },
  { t: 'win', lv: 1, stars: 2, hints: 1 }, { t: 'card', card: 'c-dhcp' },
  { t: 'save', lv: 1, cur: { s: 123, e: [{ a: 1 }, { a: 2 }], t: 1000 }, done: { s: 123, e: [{ a: 1 }, { a: 2 }, { a: 3 }], w: 2, t: 2000 } },
  { t: 'sync', lv: { '1': 3, '2': 1 }, cd: ['c-dns'] }, { t: 'open', lv: 2 }
] } }); ok('送事件', r.status === 200 && r.d.n === 9);
r = await call('GET', '/api/me', { token: TOK2 }); ok('me 反映星數與知識卡', r.d.lv['1'] === 3 && r.d.lv['2'] === 1 && r.d.cd.includes('c-dhcp') && r.d.cd.includes('c-dns'), JSON.stringify(r.d));
r = await call('GET', '/api/saves', { token: TOK }); ok('saves 回傳存檔', r.d.saves['1'].cur.e.length === 2 && r.d.saves['1'].done.w === 2);
r = await call('POST', '/api/event', { token: TOK, body: { events: [{ t: 'save', lv: 1, cur: { s: 9, e: [], t: 500 }, done: null }] } });
r = await call('GET', '/api/saves', { token: TOK }); ok('較舊的存檔不覆蓋雲端', r.d.saves['1'].cur.s === 123);
r = await call('PUT', '/api/me/school', { token: TOK, body: { school: { net: '192.168.5', gw: '1', ssid: { s: 'Stu' }, dns: '8.8.8.8', junk: 'x' } } });
ok('學員學校設定：白名單過濾（dns/junk 不收）', r.status === 200 && r.d.school.net === '192.168.5' && r.d.school.gw === 1 && !('dns' in r.d.school) && !('junk' in r.d.school), JSON.stringify(r.d));
r = await call('PUT', '/api/me/school', { token: TOK, body: { school: { net: 'bad' } } }); ok('學校設定格式錯 → 400', r.status === 400);
r = await call('PUT', '/api/me/school', { token: TOK, body: { school: null } }); ok('清除學校設定 → {}', r.status === 200 && JSON.stringify(r.d.school) === '{}');

// 講師總表
r = await call('GET', '/api/class/' + CODE, { token: KEY });
const st = r.d.students.find(x => x.name === '07 王小明');
ok('總表：學員統計', r.d.students.length === 2 && st.lv['1'].s === 3 && st.lv['1'].a === 2 && st.lv['1'].ms === 55000 && st.lv['1'].h === 1 && st.lv['1'].w === 1 && st.cur_lv === 2 && st.cards === 2 && typeof r.d.now === 'number', JSON.stringify(st));
r = await call('GET', `/api/class/${CODE}/student/${st.id}/save/1`, { token: KEY }); ok('講師看學員存檔', r.status === 200 && r.d.cur.e.length === 2 && r.d.done.w === 2);
r = await call('GET', `/api/class/${CODE}/student/${st.id}/save/5`, { token: KEY }); ok('沒有存檔的關 → cur/done 為 null', r.status === 200 && r.d.cur === null && r.d.done === null);
r = await call('PUT', '/api/class/' + CODE, { token: KEY, body: { cfg: { net: '172.16.0', tel: '02-12345678' } } }); ok('改班級設定', r.status === 200 && r.d.cfg.net === '172.16.0' && r.d.cfg.tel === '02-12345678');
r = await call('GET', '/api/me', { token: TOK }); ok('學員 me 看到新的 cfg', r.d.cfg.net === '172.16.0');
r = await call('DELETE', `/api/class/${CODE}/student/${st.id}`, { token: KEY }); ok('移除學員', r.status === 200);
r = await call('GET', '/api/me', { token: TOK }); ok('被移除後 token 失效 → 401', r.status === 401);
r = await call('GET', '/api/class/' + CODE, { token: KEY }); ok('總表剩 1 人', r.d.students.length === 1);
r = await call('POST', '/api/join', { body: { code: CODE, name: '07 王小明' } }); ok('名字釋出，可重新加入', r.status === 200);
r = await call('GET', '/api/nope'); ok('未知路徑 → 404', r.status === 404);
r = await call('POST', '/api/join', { raw: '{bad' }); ok('壞 JSON → 400', r.status === 400);
console.log('\nKV keys:', [...store.keys()].length, fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
