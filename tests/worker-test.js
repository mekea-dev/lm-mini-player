/*
 * Teste de relay/worker.js: roda o codigo REAL do servidor de salas contra um SQLite de verdade
 * (tests/d1-shim.py, que imita a forma do D1). Nao usa Node: o corpo abaixo e colocado dentro de uma
 * funcao async com as variaveis  W (o objeto do Worker)  e  SHIM (URL do banco de teste)  e executado
 * numa pagina de navegador (mesmo motor V8 do Cloudflare). Devolve { passed, failed, results }.
 * Quem faz isso e tests/worker-test.html (veja como rodar nela).
 */
const results = [];
function check(name, cond, extra) { results.push({ name: name, ok: !!cond, extra: cond ? undefined : extra }); }

// "D1" falso: mesma forma de uso (prepare -> bind -> first / all / run), SQL de verdade do outro lado
function stmt(sql) {
  let params = [];
  const s = {
    bind: function () { params = Array.prototype.slice.call(arguments); return s; },
    call: async function (mode) {
      const r = await fetch(SHIM, { method: 'POST', body: JSON.stringify({ sql: sql, params: params, mode: mode }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'erro de sql');
      return j;
    },
    first: async function () { return (await s.call('first')).row; },
    all: async function () { const j = await s.call('all'); return { results: j.results, success: true, meta: j.meta }; },
    run: async function () { const j = await s.call('run'); return { success: true, meta: j.meta }; }
  };
  return s;
}
const env = { DB: { prepare: stmt } };

async function call(method, path, body, rawBody) {
  const init = { method: method };
  if (rawBody !== undefined) init.body = rawBody;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const res = await W.fetch(new Request('https://relay.test' + path, init), env);
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch (e) { j = { __raw: text }; }
  return { status: res.status, json: j, headers: res.headers };
}
async function dbFirst(text, params) { const s = stmt(text); s.bind.apply(s, params || []); return s.first(); }
async function dbRun(text, params) { const s = stmt(text); s.bind.apply(s, params || []); return s.run(); }

const A = 'pessoaAAAA01', B = 'pessoaBBBB02', C = 'pessoaCCCC03';
const CODE = 'ABCDEFGH';

// ---- rotas e validacao ----
let r = await call('OPTIONS', '/api/room/' + CODE);
check('OPTIONS responde 204 com CORS', r.status === 204 && r.headers.get('access-control-allow-origin') === '*', r.status);
r = await call('GET', '/outra/coisa');
check('rota desconhecida = 404 not_found', r.status === 404 && r.json.error === 'not_found', r);
r = await call('GET', '/api/room/abc');
check('codigo curto = 400 bad_code', r.status === 400 && r.json.error === 'bad_code', r);
r = await call('GET', '/api/room/ABCDEFG0');
check('codigo com 0 = 400 bad_code', r.status === 400 && r.json.error === 'bad_code', r);
r = await call('GET', '/api/room/' + CODE + '?id=' + A);
check('sala inexistente = 404 room_not_found (e manda a hora)', r.status === 404 && r.json.error === 'room_not_found' && typeof r.json.now === 'number', r);
r = await call('PUT', '/api/room/' + CODE);
check('metodo PUT = 405', r.status === 405, r);

// ---- criar ----
r = await call('POST', '/api/room/' + CODE, { op: 'create' });
check('criar sem id = 400 bad_id', r.status === 400 && r.json.error === 'bad_id', r);
r = await call('POST', '/api/room/' + CODE, null, '{nao e json');
check('JSON ruim = 400 bad_json', r.status === 400 && r.json.error === 'bad_json', r);
r = await call('POST', '/api/room/' + CODE, null, '{"id":"' + A + '","x":"' + 'z'.repeat(5000) + '"}');
check('corpo grande = 413', r.status === 413, r.status);
r = await call('POST', '/api/room/' + CODE, { id: A, op: 'voar' });
check('operacao desconhecida = 400 bad_op', r.status === 400 && r.json.error === 'bad_op', r);
r = await call('POST', '/api/room/' + CODE, { id: A, op: 'set', state: { vid: 'aqz-KE-bpKQ', pos: 1, playing: true, rate: 1 } });
check('set em sala que nao existe = 404', r.status === 404 && r.json.error === 'room_not_found', r);
r = await call('POST', '/api/room/' + CODE, { id: A, op: 'create' });
check('criar = 200 v=0', r.status === 200 && r.json.v === 0 && typeof r.json.now === 'number', r);
r = await call('POST', '/api/room/' + CODE, { id: B, op: 'create' });
check('criar o mesmo codigo = 409 exists', r.status === 409 && r.json.error === 'exists', r);
r = await call('POST', '/api/room/' + CODE.toLowerCase(), { id: B, op: 'create' });
check('codigo em minusculas e a mesma sala (409)', r.status === 409, r);

// ---- ler ----
r = await call('GET', '/api/room/' + CODE + '?since=-1&id=' + B);
check('ler sala nova: v=0, state=null, 2 pessoas (criador + B)', r.status === 200 && r.json.v === 0 && r.json.state === null && r.json.members === 2, r);
r = await call('GET', '/api/room/' + CODE + '?since=0&id=' + B);
check('ler com since igual: sem o campo state', r.status === 200 && !('state' in r.json), r);

// ---- gravar ----
const bad = [
  ['sem state', undefined],
  ['vid curto', { vid: 'abc', pos: 1 }],
  ['vid com caractere invalido', { vid: 'aqz-KE-bp!K', pos: 1 }],
  ['vid e list nulos', { vid: null, list: null, pos: 1 }],
  ['list curta', { list: 'PL1', pos: 1 }]
];
for (const b of bad) {
  r = await call('POST', '/api/room/' + CODE, { id: A, op: 'set', state: b[1] });
  check('estado invalido (' + b[0] + ') = 400 bad_state', r.status === 400 && r.json.error === 'bad_state', r);
}
r = await call('POST', '/api/room/' + CODE, { id: A, op: 'set', state: { vid: 'aqz-KE-bpKQ', pos: 12.5, playing: 1, rate: 2 } });
const t1 = r.json && r.json.state;
check('gravar: v=1, hora do servidor, autor, playing vira boolean',
  r.status === 200 && r.json.v === 1 && t1 && t1.vid === 'aqz-KE-bpKQ' && t1.pos === 12.5 && t1.playing === true && t1.rate === 2 && t1.by === A && Math.abs(t1.at - r.json.now) < 5, r);
r = await call('GET', '/api/room/' + CODE + '?since=0&id=' + B);
check('quem tem a versao antiga recebe o estado novo', r.status === 200 && r.json.v === 1 && r.json.state && r.json.state.vid === 'aqz-KE-bpKQ', r);
r = await call('GET', '/api/room/' + CODE + '?since=1&id=' + B);
check('quem ja tem a versao nao recebe de novo', r.status === 200 && r.json.v === 1 && !('state' in r.json), r);

r = await call('POST', '/api/room/' + CODE, { id: B, op: 'set', state: { vid: 'dQw4w9WgXcQ', pos: -50, playing: false, rate: 99 } });
check('limites: pos negativa vira 0, rate 99 vira 16', r.status === 200 && r.json.state.pos === 0 && r.json.state.rate === 16, r);
r = await call('POST', '/api/room/' + CODE, { id: B, op: 'set', state: { vid: 'dQw4w9WgXcQ', pos: 999999, playing: false, rate: 0 } });
check('limites: pos enorme vira 86400, rate 0 vira 1', r.status === 200 && r.json.state.pos === 86400 && r.json.state.rate === 1, r);
r = await call('POST', '/api/room/' + CODE, { id: B, op: 'set', state: { vid: null, list: 'PLabcdefghijkl', pos: 3, playing: true, rate: 0.5 } });
check('playlist sem video e aceita', r.status === 200 && r.json.state.list === 'PLabcdefghijkl' && r.json.state.vid === null, r);

// ---- varias pessoas gravando ao mesmo tempo: cada gravacao ganha uma versao diferente ----
const before = (await call('GET', '/api/room/' + CODE + '?since=-1&id=' + A)).json.v;
const sets = await Promise.all(Array.from({ length: 25 }, function (_, i) {
  return call('POST', '/api/room/' + CODE, { id: i % 2 ? A : B, op: 'set', state: { vid: 'aqz-KE-bpKQ', pos: i, playing: true, rate: 1 } });
}));
const vs = sets.map(function (x) { return x.json.v; });
const distinct = new Set(vs);
const after = (await call('GET', '/api/room/' + CODE + '?since=-1&id=' + A)).json.v;
check('25 gravacoes simultaneas = 25 versoes diferentes', distinct.size === 25 && after === before + 25, { distinct: distinct.size, before: before, after: after });

// ---- presenca ----
const now = Date.now();
await dbRun('UPDATE rooms SET members = ? WHERE code = ?', [JSON.stringify({ velhoAAAAA1: now - 45000, velhoBBBBB2: now - 70000 }), CODE]);
r = await call('GET', '/api/room/' + CODE + '?since=-1&id=' + C);
const row = await dbFirst('SELECT members FROM rooms WHERE code = ?', [CODE]);
const mem = JSON.parse(row.members);
check('presenca: so conta quem apareceu nos ultimos 30 s', r.json.members === 1, r.json);
check('presenca: some quem passou de 60 s, guarda quem esta entre 30 e 60 s', !mem.velhoBBBBB2 && !!mem.velhoAAAAA1 && !!mem[C], mem);
const t0 = (await dbFirst('SELECT updated FROM rooms WHERE code = ?', [CODE])).updated;
check('presenca atualiza o "updated" da sala (sala com gente nao expira)', Math.abs(t0 - Date.now()) < 5000, t0);

// ---- limpeza de salas velhas na hora de criar ----
await dbRun('INSERT INTO rooms (code, v, state, members, created, updated) VALUES (?, 0, ?, ?, ?, ?)', ['VELHA234', 'null', '{}', now - 90000000, now - 90000000]);
check('sala velha existe antes da limpeza', !!(await dbFirst('SELECT code FROM rooms WHERE code = ?', ['VELHA234'])), 'nao inseriu');
r = await call('POST', '/api/room/SALA2345', { id: A, op: 'create' });
check('criar outra sala = 200', r.status === 200, r);
check('sala com mais de 24 h sem uso e apagada ao criar outra', !(await dbFirst('SELECT code FROM rooms WHERE code = ?', ['VELHA234'])), 'continua la');
check('a sala em uso nao e apagada', !!(await dbFirst('SELECT code FROM rooms WHERE code = ?', [CODE])), 'sumiu');

return JSON.stringify({ passed: results.filter(function (x) { return x.ok; }).length, failed: results.filter(function (x) { return !x.ok; }).length, results: results });
