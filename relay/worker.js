/*
 * LM Mini Player - servidor de salas em tempo real (Cloudflare Worker + Durable Object).
 *
 * Cada sala e um Durable Object (um por codigo). Quem entra abre uma conexao WebSocket com ele; o servidor
 *   - guarda o ESTADO do que esta tocando (video, posicao, tocando/pausado, velocidade) com a hora do servidor
 *     e avisa todo mundo NA HORA quando alguem mexe (sem ficar perguntando a cada segundo);
 *   - sabe quem esta na sala: quem fecha o programa ou sai some para os outros no mesmo instante;
 *   - leva as mensagens de "sinalizacao" da voz (WebRTC) de uma pessoa para outra. O AUDIO nao passa
 *     por aqui: vai direto entre os computadores.
 * Nao transmite video: cada pessoa toca o proprio video do YouTube.
 *
 * Conexao (WebSocket):  GET /ws/<CODIGO>?id=<id>&name=<nome>[&create=1]
 *   servidor -> pessoa:  hello {now,you,v,state,members} | join {m} | leave {id} | member {m} | state {v,state,now}
 *                        sig {from,data} | pong {c,now} | err {error}
 *   pessoa -> servidor:  set {st} | name {name} | voice {on,muted} | sig {to,data} | ping {c}
 *   codigos de fechamento: 4400 pedido ruim, 4404 sala nao existe, 4409 sala ja existe, 4413 sala cheia,
 *                          4429 mensagens demais, 4000 trocada por outra conexao da mesma pessoa
 *
 * Para programas antigos (1.3.x, que perguntam a cada segundo) o mesmo objeto responde por HTTP:
 *   GET  /api/room/<CODIGO>?since=<v>&id=<id>                -> { now, v, members, state? }
 *   POST /api/room/<CODIGO>  { id, op: "create" | "set", state }
 *
 * Deploy: Git (Workers Builds), veja relay/LEIA-ME.md e relay/wrangler.jsonc.
 */
import { DurableObject } from 'cloudflare:workers';

const CODE_RE = /^[A-HJ-NP-Z2-9]{6,12}$/;     // sem 0, 1, I, O (confundem)
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const VID_RE = /^[A-Za-z0-9_-]{11}$/;
const LIST_RE = /^[A-Za-z0-9_-]{10,80}$/;
const TTL_MS = 24 * 3600 * 1000;               // sala sem uso por 24 h some
const MAX_MEMBERS = 8;                         // voz em malha: 8 pessoas ja sao 28 conexoes
const MAX_MSG = 8192;                          // bytes por mensagem
const MAX_NAME = 24;
const LEGACY_ACTIVE_MS = 30000;                // programa antigo "esta na sala" = apareceu nos ultimos 30 s
const RATE_WINDOW_MS = 10000;
const RATE_MAX = 400;                          // mensagens por janela, por conexao
const APP_ORIGIN = 'https://lmminiplayer.app';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS)
  });
}

function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  const vid = s.vid == null ? null : String(s.vid);
  const list = s.list == null ? null : String(s.list);
  if (vid !== null && !VID_RE.test(vid)) return null;
  if (list !== null && !LIST_RE.test(list)) return null;
  if (vid === null && list === null) return null;
  const pos = Number(s.pos);
  const rate = Number(s.rate);
  return {
    vid: vid,
    list: list,
    pos: Math.max(0, Math.min(86400, isFinite(pos) ? pos : 0)),
    playing: !!s.playing,
    rate: Math.max(0.07, Math.min(16, isFinite(rate) && rate > 0 ? rate : 1))
  };
}

// nome que aparece para os outros: sem caracteres de controle nem de direcao de texto, espacos arrumados, ate 24 letras
function cleanName(n) {
  let out = '';
  for (const ch of (typeof n === 'string' ? n : '')) {
    const c = ch.codePointAt(0);
    if (c < 32 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) continue;
    out += ch;
  }
  const s = Array.from(out.replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME).join('');
  return s || 'Visitante';
}

function pub(a) { return { id: a.id, name: a.name, voice: !!a.voice, muted: !!a.muted }; }

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const m = /^\/(ws|api\/room)\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (!m) return json({ error: 'not_found' }, 404);
    const code = m[2].toUpperCase();
    if (!CODE_RE.test(code)) return json({ error: 'bad_code' }, 400);

    if (m[1] === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
      const origin = request.headers.get('Origin');
      if (origin && origin !== APP_ORIGIN) return json({ error: 'origin' }, 403);   // outro site na web nao entra
    }
    return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.data = null;                 // { v, state, created, updated }; null = a sala nao existe
    this.legacy = new Map();          // programas antigos (HTTP): id -> ultima vez visto
    this.rate = new WeakMap();        // conexao -> { n, t }
    ctx.blockConcurrencyWhile(async () => { this.data = (await ctx.storage.get('room')) || null; });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));   // "estou aqui" sem acordar a sala
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.indexOf('/ws/') === 0) return this.openSocket(url);
    return this.http(request, url);
  }

  // ---------- sala ----------

  async create() {
    const now = Date.now();
    this.data = { v: 0, state: null, created: now, updated: now };
    await this.ctx.storage.put('room', this.data);
    await this.ctx.storage.setAlarm(now + TTL_MS);
  }

  open() {
    return this.ctx.getWebSockets().filter(function (s) { return s.readyState === 1; });
  }

  members() {
    return this.open().map(function (s) { const a = s.deserializeAttachment(); return a ? pub(a) : null; }).filter(Boolean);
  }

  activeCount() {
    const now = Date.now();
    for (const [id, t] of this.legacy) if (now - t > LEGACY_ACTIVE_MS) this.legacy.delete(id);
    return this.open().length + this.legacy.size;
  }

  broadcast(msg, except) {
    const text = JSON.stringify(msg);
    for (const s of this.open()) {
      if (s === except) continue;
      try { s.send(text); } catch (e) { /* conexao caindo: o webSocketClose cuida */ }
    }
  }

  async applySet(st, by) {
    const now = Date.now();
    st.at = now;
    st.by = by;
    this.data.v += 1;
    this.data.state = st;
    this.data.updated = now;
    await this.ctx.storage.put('room', this.data);
    this.broadcast({ t: 'state', v: this.data.v, state: st, now: now });
    return st;
  }

  // ---------- WebSocket ----------

  async openSocket(url) {
    const id = url.searchParams.get('id') || '';
    const wantCreate = url.searchParams.get('create') === '1';
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const refuse = function (code, why) {
      try { server.send(JSON.stringify({ t: 'err', error: why })); server.close(code, why); } catch (e) { /* ignora */ }
      return new Response(null, { status: 101, webSocket: client });
    };

    if (!ID_RE.test(id)) return refuse(4400, 'bad_id');
    if (wantCreate) {
      if (this.data) return refuse(4409, 'exists');
      await this.create();
    } else if (!this.data) {
      return refuse(4404, 'room_not_found');
    }

    // a mesma pessoa reconectando (rede que caiu): a conexao antiga sai sem avisar ninguem
    for (const s of this.open()) {
      if (s === server) continue;
      const a = s.deserializeAttachment();
      if (a && a.id === id) { try { s.close(4000, 'replaced'); } catch (e) { /* ignora */ } }
    }
    const others = this.open().filter(function (s) { const a = s.deserializeAttachment(); return s !== server && a && a.id !== id; });
    if (others.length >= MAX_MEMBERS) return refuse(4413, 'room_full');

    const me = { id: id, name: cleanName(url.searchParams.get('name')), voice: false, muted: false, at: Date.now() };
    server.serializeAttachment(me);
    this.data.updated = me.at;
    this.ctx.storage.put('room', this.data);

    server.send(JSON.stringify({
      t: 'hello', now: Date.now(), you: id, v: this.data.v, state: this.data.state,
      members: others.map(function (s) { return pub(s.deserializeAttachment()); }).concat([pub(me)])
    }));
    this.broadcast({ t: 'join', m: pub(me) }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  allow(ws) {
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now - r.t > RATE_WINDOW_MS) { r = { n: 0, t: now }; this.rate.set(ws, r); }
    r.n += 1;
    return r.n <= RATE_MAX;
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_MSG) return;
    if (!this.allow(ws)) { try { ws.close(4429, 'rate'); } catch (e) { /* ignora */ } return; }
    let m;
    try { m = JSON.parse(message); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const me = ws.deserializeAttachment();
    if (!me) return;

    switch (m.t) {
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong', c: m.c, now: Date.now() }));
        break;
      case 'set': {
        const st = cleanState(m.st);
        if (st) await this.applySet(st, me.id);
        break;
      }
      case 'name':
        me.name = cleanName(m.name);
        ws.serializeAttachment(me);
        this.broadcast({ t: 'member', m: pub(me) });
        break;
      case 'voice':
        me.voice = !!m.on;
        me.muted = !!m.muted;
        ws.serializeAttachment(me);
        this.broadcast({ t: 'member', m: pub(me) });
        break;
      case 'sig': {
        if (typeof m.to !== 'string' || m.to === me.id || !ID_RE.test(m.to)) break;
        for (const s of this.open()) {
          const a = s.deserializeAttachment();
          if (a && a.id === m.to) { try { s.send(JSON.stringify({ t: 'sig', from: me.id, data: m.data })); } catch (e) { /* ignora */ } break; }
        }
        break;
      }
    }
  }

  gone(ws, code) {
    const me = ws.deserializeAttachment();
    if (!me || code === 4000) return;                  // trocada por uma conexao nova da mesma pessoa: nao saiu
    for (const s of this.open()) {                      // a mesma pessoa ainda tem outra conexao aberta
      if (s === ws) continue;
      const a = s.deserializeAttachment();
      if (a && a.id === me.id) return;
    }
    this.broadcast({ t: 'leave', id: me.id }, ws);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch (e) { /* ja fechada */ }
    this.gone(ws, code);
  }

  async webSocketError(ws, error) {
    this.gone(ws, 1006);
  }

  // sala sem uso por 24 h some (com gente conectada, o prazo recomeca)
  async alarm() {
    if (!this.data) return;
    const idle = Date.now() - this.data.updated;
    if (this.open().length > 0 || idle < TTL_MS) {
      await this.ctx.storage.setAlarm(Date.now() + (this.open().length > 0 ? TTL_MS : TTL_MS - idle));
      return;
    }
    await this.ctx.storage.deleteAll();
    this.data = null;
  }

  // ---------- HTTP (programas antigos) ----------

  async http(request, url) {
    const now = Date.now();
    if (request.method === 'GET') {
      if (!this.data) return json({ now: now, error: 'room_not_found' }, 404);
      const id = url.searchParams.get('id') || '';
      if (ID_RE.test(id)) this.legacy.set(id, now);
      const since = parseInt(url.searchParams.get('since') || '-1', 10);
      const out = { now: now, v: this.data.v, members: this.activeCount() };
      if (since !== this.data.v) out.state = this.data.state;
      return json(out);
    }

    if (request.method === 'POST') {
      const raw = await request.text();
      if (raw.length > 4096) return json({ error: 'too_big' }, 413);
      let body;
      try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad_json' }, 400); }
      const id = String(body.id || '');
      if (!ID_RE.test(id)) return json({ error: 'bad_id' }, 400);

      if (body.op === 'create') {
        if (this.data) return json({ now: now, error: 'exists' }, 409);
        await this.create();
        this.legacy.set(id, now);
        return json({ now: now, v: 0 });
      }
      if (body.op === 'set') {
        if (!this.data) return json({ now: now, error: 'room_not_found' }, 404);
        const st = cleanState(body.state);
        if (!st) return json({ error: 'bad_state' }, 400);
        this.legacy.set(id, now);
        await this.applySet(st, id);
        return json({ now: now, v: this.data.v, state: this.data.state });
      }
      return json({ error: 'bad_op' }, 400);
    }

    return json({ error: 'method' }, 405);
  }
}
