/*
 * Teste do servidor de salas em tempo real (relay/worker.js): roda o codigo REAL do Worker e do Durable Object
 * com um "ctx" e conexoes WebSocket de mentira (tudo na memoria). Nao usa Node: o corpo abaixo e uma funcao
 * async com a variavel  SRC  (o texto de worker.js), executada numa pagina de navegador (V8, como no Cloudflare).
 * Devolve { passed, failed, results }. Quem roda e tests/room-test.html.
 */
const results = [];
function check(name, cond, extra) { results.push({ name: name, ok: !!cond, extra: cond ? undefined : extra }); }
const RealResponse = Response;

// ---- mentiras do ambiente do Cloudflare ----
class MockSock {
  constructor() { this.sent = []; this.readyState = 1; this.att = null; this.closed = null; }
  send(t) { if (this.readyState !== 1) throw new Error('fechada'); this.sent.push(JSON.parse(t)); }
  close(code, reason) { this.readyState = 3; this.closed = { code: code, reason: reason }; }
  serializeAttachment(o) { this.att = JSON.parse(JSON.stringify(o)); }
  deserializeAttachment() { return this.att ? JSON.parse(JSON.stringify(this.att)) : null; }
  all(t) { return this.sent.filter(function (m) { return m.t === t; }); }
  last(t) { const a = this.all(t); return a.length ? a[a.length - 1] : null; }
}
class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
let lastPair = null;
function WebSocketPair() { const a = new MockSock(), b = new MockSock(); lastPair = [a, b]; this[0] = a; this[1] = b; }
function WebSocketRequestResponsePair(a, b) { this.request = a; this.response = b; }
function FakeResponse(body, init) {
  if (init && init.status === 101) { this.status = 101; this.webSocket = init.webSocket; return; }
  return new RealResponse(body, init);
}

function makeCtx(store, alarm) {
  const ctx = {
    socks: [],
    storage: {
      get: async function (k) { return store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : undefined; },
      put: async function (k, v) { store.set(k, JSON.parse(JSON.stringify(v))); },
      deleteAll: async function () { store.clear(); alarm.t = null; alarm.deleted = true; },
      setAlarm: async function (t) { alarm.t = t; }
    },
    acceptWebSocket: function (ws) { ctx.socks.push(ws); },
    getWebSockets: function () { return ctx.socks.slice(); },
    setWebSocketAutoResponse: function () {},
    blockConcurrencyWhile: function (fn) { ctx.block = fn(); return ctx.block; }
  };
  return ctx;
}

const factory = (function () {
  let code = SRC.replace(/^import .*$/m, '').replace('export default {', 'const __default = {').replace('export class Room extends DurableObject', 'class Room extends DurableObject');
  code += '\nreturn { worker: __default, Room: Room };';
  return new Function('DurableObject', 'WebSocketPair', 'WebSocketRequestResponsePair', 'Response', code);
})();
const mod = factory(DurableObject, WebSocketPair, WebSocketRequestResponsePair, FakeResponse);

async function newRoom(store, alarm, env) {
  const ctx = makeCtx(store || new Map(), alarm || {});
  const room = new mod.Room(ctx, env || { GRACE_MS: 0 });
  await ctx.block;
  return { room: room, ctx: ctx };
}

async function connect(room, id, name, create) {
  const qs = new URLSearchParams({ id: id });
  if (name !== undefined) qs.set('name', name);
  if (create) qs.set('create', '1');
  const res = await room.fetch(new Request('https://relay.test/ws/ABCDEFGH?' + qs.toString(), { headers: { Upgrade: 'websocket' } }));
  return { ws: lastPair[1], res: res };
}
async function say(room, ws, obj) { await room.webSocketMessage(ws, typeof obj === 'string' ? obj : JSON.stringify(obj)); }
async function http(room, method, path, body) {
  const init = { method: method };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await room.fetch(new Request('https://relay.test' + path, init));
  const t = await res.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = { raw: t }; }
  return { status: res.status, json: j };
}

const A = 'pessoaAAAA01', B = 'pessoaBBBB02', C = 'pessoaCCCC03';
const VID = 'aqz-KE-bpKQ';

// ---- Worker (roteamento) ----
const envStub = { ROOM: { idFromName: function (n) { return n; }, get: function (id) { return { fetch: async function (req) { return new RealResponse('DO:' + id + ':' + new URL(req.url).pathname); } }; } } };
// (o navegador nao deixa um Request levar "Upgrade" nem "Origin": o pedido de mentira so tem o que o Worker le)
function fakeReq(path, headers, method) {
  const h = {};
  for (const k in (headers || {})) h[k.toLowerCase()] = headers[k];
  return { url: 'https://relay.test' + path, method: method || 'GET', headers: { get: function (k) { const v = h[k.toLowerCase()]; return v === undefined ? null : v; } } };
}
async function wfetch(path, headers, method) { return mod.worker.fetch(fakeReq(path, headers, method), envStub); }
let r = await wfetch('/api/room/abcdefgh');
check('Worker: roteia /api/room/<codigo> para a sala certa (codigo em maiusculas)', (await r.text()) === 'DO:ABCDEFGH:/api/room/abcdefgh', r.status);
r = await wfetch('/outra/coisa');
check('Worker: rota desconhecida = 404', r.status === 404, r.status);
r = await wfetch('/api/room/abc');
check('Worker: codigo curto = 400', r.status === 400, r.status);
r = await wfetch('/api/room/ABCDEFG0');
check('Worker: codigo com 0 = 400', r.status === 400, r.status);
r = await wfetch('/ws/ABCDEFGH');
check('Worker: /ws sem Upgrade = 426', r.status === 426, r.status);
r = await wfetch('/ws/ABCDEFGH', { Upgrade: 'websocket', Origin: 'https://site-malvado.example' });
check('Worker: /ws de outro site = 403', r.status === 403, r.status);
r = await wfetch('/ws/abcdefgh', { Upgrade: 'websocket', Origin: 'https://lmminiplayer.app' });
check('Worker: /ws do proprio programa passa e vai para a sala certa', (await r.text()) === 'DO:ABCDEFGH:/ws/abcdefgh', r.status);
r = await wfetch('/ws/ABCDEFGH', { Upgrade: 'websocket' });
check('Worker: /ws sem Origin (testes, ferramentas) passa', r.status === 200, r.status);
r = await wfetch('/api/room/ABCDEFGH', {}, 'OPTIONS');
check('Worker: OPTIONS = 204 com CORS', r.status === 204 && r.headers.get('access-control-allow-origin') === '*', r.status);

// ---- entrar, criar ----
let { room, ctx } = await newRoom();
let a = await connect(room, A, 'Ana', false);
check('entrar em sala que nao existe: recebe err e e fechada com 4404', a.ws.last('err') && a.ws.last('err').error === 'room_not_found' && a.ws.closed && a.ws.closed.code === 4404, a.ws);
a = await connect(room, 'curto', 'Ana', true);
check('id invalido: 4400', a.ws.closed && a.ws.closed.code === 4400, a.ws.closed);
a = await connect(room, A, '  Ana   Maria  ', true);
const hello = a.ws.last('hello');
check('criar: resposta 101 e hello com v=0, estado nulo e so eu na sala',
  a.res.status === 101 && hello && hello.v === 0 && hello.state === null && hello.you === A && hello.members.length === 1 && hello.members[0].id === A, hello);
check('nome: espacos arrumados', hello.members[0].name === 'Ana Maria', hello.members[0]);
check('hello traz a hora do servidor', typeof hello.now === 'number' && Math.abs(hello.now - Date.now()) < 5000, hello.now);
const dup = await connect(room, B, 'Bia', true);
check('criar de novo a mesma sala: 4409', dup.ws.closed && dup.ws.closed.code === 4409, dup.ws.closed);
check('a pessoa que ja estava nao e incomodada pela tentativa recusada', a.ws.sent.length === 1, a.ws.sent);

let b = await connect(room, B, 'Bia', false);
const helloB = b.ws.last('hello');
check('entrar: hello com as duas pessoas (quem ja estava + eu)', helloB && helloB.members.length === 2 && helloB.members.some(function (m) { return m.id === A; }) && helloB.members.some(function (m) { return m.id === B; }), helloB);
check('quem ja estava recebe "join" na hora', a.ws.last('join') && a.ws.last('join').m.id === B && a.ws.last('join').m.name === 'Bia', a.ws.sent);

// ---- estado ----
await say(room, a.ws, { t: 'set', st: { vid: VID, list: null, pos: 12.5, playing: true, rate: 2 } });
let sa = a.ws.last('state'), sb = b.ws.last('state');
check('set valido: os dois recebem o estado novo (v=1, autor, hora do servidor)',
  sa && sb && sa.v === 1 && sb.v === 1 && sb.state.vid === VID && sb.state.by === A && sb.state.pos === 12.5 && sb.state.playing === true && sb.state.rate === 2 && Math.abs(sb.state.at - sb.now) < 5, sb);
await say(room, b.ws, { t: 'set', st: { vid: 'dQw4w9WgXcQ', pos: -50, playing: 0, rate: 99 } });
sa = a.ws.last('state');
check('limites: pos negativa vira 0, rate 99 vira 16, playing vira boolean, v=2', sa.v === 2 && sa.state.pos === 0 && sa.state.rate === 16 && sa.state.playing === false && sa.state.by === B, sa);
await say(room, a.ws, { t: 'set', st: { vid: 'curto', pos: 1 } });
check('set invalido (video curto) e ignorado', a.ws.last('state').v === 2, a.ws.last('state'));
await say(room, a.ws, { t: 'set', st: { vid: null, list: null } });
check('set sem video nem lista e ignorado', a.ws.last('state').v === 2, a.ws.last('state'));
await say(room, a.ws, { t: 'set', st: { vid: null, list: 'PLabcdefghijkl', pos: 1, playing: true, rate: 1 } });
check('playlist sem video e aceita', a.ws.last('state').v === 3 && a.ws.last('state').state.list === 'PLabcdefghijkl', a.ws.last('state'));
const c1 = await connect(room, C, 'Caio', false);
check('quem entra depois recebe o estado atual no hello', c1.ws.last('hello').v === 3 && c1.ws.last('hello').state.list === 'PLabcdefghijkl', c1.ws.last('hello'));
const nowOk = (await ctx.storage.get('room')).v === 3;
check('o estado fica guardado no armazenamento do Durable Object', nowOk, await ctx.storage.get('room'));

// ---- nome e voz ----
await say(room, b.ws, { t: 'name', name: '  <b>Bia</b>'+String.fromCharCode(0x202e)+'  ' });
const mem = a.ws.last('member');
check('trocar o nome avisa todos (e remove caractere de controle de direcao)', mem && mem.m.id === B && mem.m.name === '<b>Bia</b>', mem);
await say(room, b.ws, { t: 'name', name: 'x'.repeat(80) });
check('nome limitado a 24 letras', a.ws.last('member').m.name.length === 24, a.ws.last('member'));
await say(room, b.ws, { t: 'name', name: '   ' });
check('nome vazio vira "Visitante"', a.ws.last('member').m.name === 'Visitante', a.ws.last('member'));
await say(room, b.ws, { t: 'voice', on: true, muted: false });
check('entrar na voz avisa todos', a.ws.last('member').m.voice === true && a.ws.last('member').m.muted === false, a.ws.last('member'));
await say(room, b.ws, { t: 'voice', on: true, muted: true });
check('silenciar o microfone avisa todos', a.ws.last('member').m.muted === true, a.ws.last('member'));
check('quem entra depois ja ve quem esta na voz',
  (await connect(room, 'pessoaDDDD04', 'Dani', false)).ws.last('hello').members.some(function (m) { return m.id === B && m.voice && m.muted; }), 1);

// ---- sinalizacao (voz) ----
await say(room, a.ws, { t: 'sig', to: B, data: { description: { type: 'offer', sdp: 'v=0' } } });
const sig = b.ws.last('sig');
check('sinalizacao chega so na pessoa certa, com o remetente', sig && sig.from === A && sig.data.description.type === 'offer' && !c1.ws.last('sig'), sig);
const nBefore = b.ws.all('sig').length;
await say(room, a.ws, { t: 'sig', to: A, data: { x: 1 } });
await say(room, a.ws, { t: 'sig', to: 'ninguemAAAA', data: { x: 1 } });
await say(room, a.ws, { t: 'sig', to: 'x', data: { x: 1 } });
check('sinalizacao para si mesmo, para quem nao esta ou com id ruim nao faz nada (e nao quebra)', b.ws.all('sig').length === nBefore && a.ws.all('sig').length === 0, 1);
await say(room, a.ws, JSON.stringify({ t: 'sig', to: B, data: 'x'.repeat(9000) }));
check('mensagem grande demais (> 8 KB) e ignorada', b.ws.all('sig').length === nBefore, b.ws.all('sig').length);

// ---- ping, lixo, limite de mensagens ----
await say(room, a.ws, { t: 'ping', c: 1234 });
check('ping devolve pong com o mesmo "c" e a hora do servidor', a.ws.last('pong') && a.ws.last('pong').c === 1234 && Math.abs(a.ws.last('pong').now - Date.now()) < 5000, a.ws.last('pong'));
const nA = a.ws.sent.length;
await say(room, a.ws, 'isto nao e json');
await say(room, a.ws, '[1,2,3]');
await say(room, a.ws, '"texto"');
await say(room, a.ws, 'null');
await say(room, a.ws, { t: 'desconhecido' });
await room.webSocketMessage(a.ws, new ArrayBuffer(8));
check('lixo (json ruim, lista, texto, nulo, tipo desconhecido, binario) e ignorado sem erro', a.ws.sent.length === nA && !a.ws.closed, a.ws.sent.length - nA);

// ---- sair ----
b.ws.readyState = 3;
await room.webSocketClose(b.ws, 1006, '', false);
check('quem sai: os outros recebem "leave" na hora', a.ws.last('leave') && a.ws.last('leave').id === B && c1.ws.last('leave') && c1.ws.last('leave').id === B, a.ws.sent.slice(-2));
check('depois de sair, nao aparece mais na lista de quem entra', !(await connect(room, 'pessoaEEEE05', 'Edu', false)).ws.last('hello').members.some(function (m) { return m.id === B; }), 1);
const aLeaveCount = a.ws.all('leave').length;
const dup2 = await connect(room, C, 'Caio de novo', false);
check('a mesma pessoa reconectando: a conexao antiga e fechada com 4000 e a nova entra',
  c1.ws.closed && c1.ws.closed.code === 4000 && dup2.ws.last('hello') && dup2.ws.last('hello').members.filter(function (m) { return m.id === C; }).length === 1, c1.ws.closed);
await room.webSocketClose(c1.ws, 4000, 'replaced', true);
check('a conexao trocada fechando NAO diz que a pessoa saiu', a.ws.all('leave').length === aLeaveCount, a.ws.all('leave'));
dup2.ws.readyState = 3;
await room.webSocketError(dup2.ws, new Error('rede'));
check('erro na conexao tambem conta como sair', a.ws.last('leave') && a.ws.last('leave').id === C, a.ws.last('leave'));

// ---- rede que cai e volta (prazo de 5 s antes de dizer que a pessoa saiu) ----
const gr = await newRoom(new Map(), {}, { GRACE_MS: 60 });
const g1 = await connect(gr.room, A, 'Ana', true);
const g2 = await connect(gr.room, B, 'Bia', false);
g1.ws.readyState = 3;
await gr.room.webSocketClose(g1.ws, 1006, '', false);
check('rede caiu (1006): os outros NAO veem "leave" na hora', !g2.ws.last('leave'), g2.ws.sent.slice(-1));
await new Promise(function (res) { setTimeout(res, 140); });
check('...mas veem "leave" depois do prazo se a pessoa nao voltar', g2.ws.last('leave') && g2.ws.last('leave').id === A, g2.ws.sent.slice(-1));
const gr2 = await newRoom(new Map(), {}, { GRACE_MS: 90 });
const q1 = await connect(gr2.room, A, 'Ana', true);
const q2 = await connect(gr2.room, B, 'Bia', false);
const joinsBefore = q2.ws.all('join').length, leavesBefore = q2.ws.all('leave').length;
q1.ws.readyState = 3;
await gr2.room.webSocketClose(q1.ws, 1006, '', false);
const q1b = await connect(gr2.room, A, 'Ana', false);
await new Promise(function (res) { setTimeout(res, 200); });
check('voltou dentro do prazo: ninguem recebe "leave" nem "join"', q2.ws.all('leave').length === leavesBefore && q2.ws.all('join').length === joinsBefore, q2.ws.sent);
check('...e o hello de quem voltou lista todo mundo', q1b.ws.last('hello') && q1b.ws.last('hello').members.length === 2, q1b.ws.last('hello'));
const gr3 = await newRoom(new Map(), {}, { GRACE_MS: 60 });
const k1 = await connect(gr3.room, A, 'Ana', true);
const k2 = await connect(gr3.room, B, 'Bia', false);
k1.ws.readyState = 3;
await gr3.room.webSocketClose(k1.ws, 1000, '', true);
check('fechamento limpo (1000): "leave" na hora, sem prazo', k2.ws.last('leave') && k2.ws.last('leave').id === A, k2.ws.sent.slice(-1));
// ---- sala cheia ----
const full = await newRoom();
const ids = [];
for (let i = 0; i < 8; i++) { const id = 'membro' + String(i).padStart(6, '0'); ids.push(id); await connect(full.room, id, 'P' + i, i === 0); }
const nine = await connect(full.room, 'membroNONO09', 'Nono', false);
check('a 9a pessoa recebe 4413 (sala cheia) e as 8 continuam', nine.ws.closed && nine.ws.closed.code === 4413 && full.room.open().length === 8, nine.ws.closed);
const back = await connect(full.room, ids[3], 'P3 de novo', false);
check('quem ja esta na sala consegue reconectar mesmo com a sala cheia', !back.ws.closed && back.ws.last('hello') && back.ws.last('hello').members.length === 8, back.ws.closed);

// ---- limite de mensagens ----
const lim = await newRoom();
const l1 = await connect(lim.room, A, 'Ana', true);
for (let i = 0; i < 401; i++) await say(lim.room, l1.ws, { t: 'ping', c: i });
check('mais de 400 mensagens em 10 s: conexao fechada com 4429', l1.ws.closed && l1.ws.closed.code === 4429, l1.ws.closed);

// ---- sobrevive a "hibernacao": outra instancia com o mesmo armazenamento ----
const store = new Map(); const alarm = {};
let h1 = await newRoom(store, alarm);
const hc = await connect(h1.room, A, 'Ana', true);
await say(h1.room, hc.ws, { t: 'set', st: { vid: VID, pos: 5, playing: true, rate: 1 } });
const h2 = await newRoom(store, alarm);
const hc2 = await connect(h2.room, B, 'Bia', false);
check('depois de a sala "dormir" e acordar, o estado continua la', hc2.ws.last('hello') && hc2.ws.last('hello').v === 1 && hc2.ws.last('hello').state.vid === VID, hc2.ws.last('hello'));
check('alarme de 24 h agendado ao criar', typeof alarm.t === 'number' && alarm.t > Date.now() + 23 * 3600 * 1000, alarm.t);

// ---- alarme: apaga sala velha, poupa sala em uso ----
const old = await newRoom(store, alarm);
old.room.data.updated = Date.now() - 25 * 3600 * 1000;
old.ctx.socks.length = 0;
await old.room.alarm();
check('alarme: sala vazia e parada ha mais de 24 h e apagada', alarm.deleted === true && old.room.data === null, alarm);
const live = await newRoom(new Map(), {});
const lc = await connect(live.room, A, 'Ana', true);
live.room.data.updated = Date.now() - 25 * 3600 * 1000;
const alarm2 = {}; live.ctx.storage.setAlarm = async function (t) { alarm2.t = t; };
await live.room.alarm();
check('alarme: sala com gente conectada nao e apagada (prazo recomeca)', live.room.data !== null && typeof alarm2.t === 'number', alarm2);

// ---- HTTP para programas antigos (1.3.x) ----
const lg = await newRoom();
let x = await http(lg.room, 'GET', '/api/room/ABCDEFGH?since=-1&id=' + A);
check('HTTP: sala que nao existe = 404', x.status === 404 && x.json.error === 'room_not_found' && typeof x.json.now === 'number', x);
x = await http(lg.room, 'POST', '/api/room/ABCDEFGH', { op: 'create' });
check('HTTP: criar sem id = 400', x.status === 400 && x.json.error === 'bad_id', x);
x = await http(lg.room, 'POST', '/api/room/ABCDEFGH', '{nao e json');
check('HTTP: json ruim = 400', x.status === 400 && x.json.error === 'bad_json', x);
x = await http(lg.room, 'POST', '/api/room/ABCDEFGH', '{"id":"' + A + '","x":"' + 'z'.repeat(5000) + '"}');
check('HTTP: corpo grande = 413', x.status === 413, x.status);
x = await http(lg.room, 'POST', '/api/room/ABCDEFGH', { id: A, op: 'set', state: { vid: VID, pos: 1 } });
check('HTTP: gravar em sala que nao existe = 404', x.status === 404, x);
x = await http(lg.room, 'POST', '/api/room/ABCDEFGH', { id: A, op: 'create' });
check('HTTP: criar = 200 v=0', x.status === 200 && x.json.v === 0, x);
x = await http(lg.room, 'POST', '/api/room/ABCDEFGH', { id: B, op: 'create' });
check('HTTP: criar de novo = 409', x.status === 409, x);
const wsNew = await connect(lg.room, C, 'Caio', false);
x = await http(lg.room, 'GET', '/api/room/ABCDEFGH?since=-1&id=' + B);
check('HTTP: ler = v=0, state=null, conta quem esta por WebSocket + os programas antigos (A, B e Caio = 3)', x.status === 200 && x.json.v === 0 && x.json.state === null && x.json.members === 3, x);
x = await http(lg.room, 'POST', '/api/room/ABCDEFGH', { id: A, op: 'set', state: { vid: VID, pos: 12.5, playing: true, rate: 1.5 } });
check('HTTP: gravar = v=1 e o estado com autor e hora', x.status === 200 && x.json.v === 1 && x.json.state.by === A && x.json.state.rate === 1.5, x);
check('HTTP: quem esta por WebSocket recebe na hora o que o programa antigo gravou', wsNew.ws.last('state') && wsNew.ws.last('state').v === 1 && wsNew.ws.last('state').state.by === A, wsNew.ws.sent.slice(-1));
x = await http(lg.room, 'GET', '/api/room/ABCDEFGH?since=0&id=' + B);
check('HTTP: ler com versao antiga recebe o estado', x.json.v === 1 && x.json.state && x.json.state.vid === VID, x);
x = await http(lg.room, 'GET', '/api/room/ABCDEFGH?since=1&id=' + B);
check('HTTP: ler com a versao atual nao traz o estado de novo', x.json.v === 1 && !('state' in x.json), x);
x = await http(lg.room, 'POST', '/api/room/ABCDEFGH', { id: A, op: 'set', state: { vid: 'curto' } });
check('HTTP: estado invalido = 400', x.status === 400 && x.json.error === 'bad_state', x);
x = await http(lg.room, 'POST', '/api/room/ABCDEFGH', { id: A, op: 'voar' });
check('HTTP: operacao desconhecida = 400', x.status === 400 && x.json.error === 'bad_op', x);
x = await http(lg.room, 'PUT', '/api/room/ABCDEFGH');
check('HTTP: metodo PUT = 405', x.status === 405, x);
lg.room.legacy.set(B, Date.now() - 45000);
x = await http(lg.room, 'GET', '/api/room/ABCDEFGH?since=1&id=' + A);
check('HTTP: programa antigo que sumiu ha mais de 30 s deixa de contar', x.json.members === 2, x);

return JSON.stringify({ passed: results.filter(function (q) { return q.ok; }).length, failed: results.filter(function (q) { return !q.ok; }).length, results: results });
