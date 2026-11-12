/*
 * LM Mini Player - servidor de salas (Cloudflare Worker + banco D1).
 *
 * Guarda, para cada sala, o ESTADO do que esta tocando (video, posicao, tocando/pausado,
 * velocidade) com a hora do servidor. Quem entra na sala pergunta o estado de tempos em
 * tempos; como o estado tem a hora do servidor, cada pessoa calcula a posicao certa mesmo
 * que a resposta demore (e o programa corrige pequenas diferencas sozinho).
 *
 * Nao transmite audio nem video: cada pessoa toca o proprio video do YouTube.
 *
 *   GET  /api/room/<CODIGO>?since=<v>&id=<id>   -> { now, v, members, state? }   (state so se mudou)
 *   POST /api/room/<CODIGO>  { id, op: "create" }                                 -> cria a sala
 *   POST /api/room/<CODIGO>  { id, op: "set", state: { vid, list, pos, playing, rate } }
 *
 * Binding necessario: DB (D1). Esquema em schema.sql.
 */

const CODE_RE = /^[A-HJ-NP-Z2-9]{6,12}$/;     // sem 0, 1, I, O (confundem)
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const VID_RE = /^[A-Za-z0-9_-]{11}$/;
const LIST_RE = /^[A-Za-z0-9_-]{10,80}$/;
const TTL_MS = 24 * 3600 * 1000;               // sala sem uso por 24 h some
const PRESENCE_REFRESH_MS = 15000;             // grava a presenca de cada pessoa no maximo a cada 15 s
const PRESENCE_ACTIVE_MS = 30000;              // "esta na sala" = apareceu nos ultimos 30 s
const MAX_BODY = 4096;

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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const m = /^\/api\/room\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (!m) return json({ error: 'not_found' }, 404);
    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return json({ error: 'bad_code' }, 400);
    const now = Date.now();

    if (request.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const since = parseInt(url.searchParams.get('since') || '-1', 10);
      const row = await env.DB.prepare('SELECT v, state, members FROM rooms WHERE code = ?').bind(code).first();
      if (!row) return json({ now: now, error: 'room_not_found' }, 404);

      // presenca: so grava quando precisa (poupa escrita no banco)
      let members = {};
      try { members = JSON.parse(row.members) || {}; } catch (e) { members = {}; }
      let dirty = false;
      if (ID_RE.test(id) && (!members[id] || now - members[id] > PRESENCE_REFRESH_MS)) { members[id] = now; dirty = true; }
      for (const k of Object.keys(members)) {
        if (now - members[k] > 60000) { delete members[k]; dirty = true; }
      }
      if (dirty) await env.DB.prepare('UPDATE rooms SET members = ?, updated = ? WHERE code = ?').bind(JSON.stringify(members), now, code).run();

      const out = { now: now, v: row.v, members: Object.values(members).filter(function (t) { return now - t < PRESENCE_ACTIVE_MS; }).length };
      if (since !== row.v) { try { out.state = JSON.parse(row.state); } catch (e) { out.state = null; } }
      return json(out);
    }

    if (request.method === 'POST') {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ error: 'too_big' }, 413);
      let body;
      try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad_json' }, 400); }
      const id = String(body.id || '');
      if (!ID_RE.test(id)) return json({ error: 'bad_id' }, 400);

      if (body.op === 'create') {
        await env.DB.prepare('DELETE FROM rooms WHERE updated < ?').bind(now - TTL_MS).run();
        const exists = await env.DB.prepare('SELECT 1 AS x FROM rooms WHERE code = ?').bind(code).first();
        if (exists) return json({ now: now, error: 'exists' }, 409);
        await env.DB.prepare('INSERT INTO rooms (code, v, state, members, created, updated) VALUES (?, 0, ?, ?, ?, ?)')
          .bind(code, 'null', JSON.stringify({ [id]: now }), now, now).run();
        return json({ now: now, v: 0 });
      }

      if (body.op === 'set') {
        const st = cleanState(body.state);
        if (!st) return json({ error: 'bad_state' }, 400);
        st.at = now;
        st.by = id;
        // a versao sobe dentro do proprio banco: duas pessoas mexendo ao mesmo tempo nunca ganham o mesmo numero
        const res = await env.DB.prepare('UPDATE rooms SET v = v + 1, state = ?, updated = ? WHERE code = ? RETURNING v')
          .bind(JSON.stringify(st), now, code).all();
        const row = res && res.results && res.results[0];
        if (!row) return json({ now: now, error: 'room_not_found' }, 404);
        return json({ now: now, v: row.v, state: st });
      }
      return json({ error: 'bad_op' }, 400);
    }

    return json({ error: 'method' }, 405);
  }
};
