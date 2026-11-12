/*
 * LM Mini Player - salas: ver o mesmo video ao mesmo tempo que outras pessoas.
 *
 * A pagina pergunta ao servidor de salas (relay/worker.js) o estado da sala de tempos em tempos e manda
 * o player (speed-frame.js, dentro do YouTube) ficar igual; e, quando a pessoa pausa, toca, pula ou troca
 * de video, publica o novo estado. O estado leva a hora do SERVIDOR, entao cada um calcula a posicao
 * certa mesmo que a resposta demore. Nao transmite audio nem video: cada pessoa toca o proprio video.
 *
 *   LMRoom.available()        o servidor de salas esta configurado?
 *   LMRoom.create(inicial)    cria uma sala (com o video atual, se houver) -> Promise(codigo)
 *   LMRoom.join(codigo)       entra numa sala -> Promise(codigo)
 *   LMRoom.leave()            sai da sala
 *   LMRoom.code() / status() / members()
 *   LMRoom.publishLoad(info)  avisa a sala que a pessoa trocou de video
 *   LMRoom.onFrameEvent(ev)   avisa a sala de play/pause/pulo/velocidade (vindo do player)
 *   LMRoom.hooks              { changed, toast, applyRemote } preenchido pela pagina
 */
(function () {
  'use strict';

  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // sem 0, 1, I, O (confundem)
  var CODE_LEN = 8;
  var CODE_RE = /^[A-HJ-NP-Z2-9]{6,12}$/;

  var hooks = {};
  var S = {
    code: null,
    id: randomId(24),            // identifica ESTA janela (nao e guardado)
    v: -1,                       // ultima versao do estado que ja aplicamos
    state: null,                 // ultimo estado conhecido: { vid, list, pos, playing, rate, at, by }
    members: 1,
    status: 'off',               // off | ok | reconectando
    offset: 0,                   // hora do servidor - hora local (ms)
    bestRtt: 1e9,
    timer: 0,
    busy: false,
    failures: 0,
    lastChangeAt: 0,
    fastUntil: 0
  };

  function randomId(n) {
    var a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = '';
    for (var i = 0; i < n; i++) s += ALPHABET.charAt(a[i] % ALPHABET.length);
    return s.toLowerCase();
  }

  function relayBase() {
    try { var o = window.localStorage.getItem('lmmp.relay'); if (o) return o; } catch (e) { /* ignora */ }
    return (window.LM_CONFIG && window.LM_CONFIG.relay) || '';
  }

  function available() { return !!relayBase(); }
  function serverNow() { return Date.now() + S.offset; }
  function notify() { if (hooks.changed) { try { hooks.changed(); } catch (e) { /* ignora */ } } }

  // ---- relogio: estima (hora do servidor - hora local) pela amostra de menor atraso ----
  function sampleClock(j, t0, t1) {
    if (!j || typeof j.now !== 'number') return;
    var rtt = t1 - t0;
    var off = j.now - (t0 + t1) / 2;
    if (rtt <= S.bestRtt) { S.bestRtt = rtt; S.offset = off; }
    else if (rtt <= S.bestRtt * 1.5 + 30) { S.offset = S.offset * 0.8 + off * 0.2; }
    S.bestRtt = S.bestRtt * 1.02 + 0.5;                 // a melhor amostra "envelhece" (a rede muda)
  }

  function api(method, path, body) {
    var t0 = Date.now();
    var opts = { method: method, headers: {}, cache: 'no-store' };
    if (body) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
    return fetch(relayBase().replace(/\/+$/, '') + path, opts).then(function (r) {
      var t1 = Date.now();
      return r.json().then(function (j) { j.__status = r.status; sampleClock(j, t0, t1); return j; },
        function () { return { __status: r.status, error: 'resposta_invalida' }; });
    });
  }

  // ---- entrar, criar, sair ----
  function makeCode() {
    var a = new Uint8Array(CODE_LEN);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = '';
    for (var i = 0; i < CODE_LEN; i++) s += ALPHABET.charAt(a[i] % ALPHABET.length);
    return s;
  }

  function start(code) {
    stop(true);
    S.code = code; S.v = -1; S.state = null; S.failures = 0; S.status = 'ok'; S.members = 1;
    S.lastChangeAt = Date.now();
    notify();
  }

  function stop(silent) {
    clearTimeout(S.timer);
    S.timer = 0; S.code = null; S.status = 'off'; S.v = -1; S.state = null; S.busy = false;
    if (!silent) notify();
  }

  function create(initial) {
    if (!available()) return Promise.reject(new Error('sem_servidor'));
    var code = makeCode();
    return api('POST', '/api/room/' + code, { id: S.id, op: 'create' }).then(function (j) {
      if (j.__status === 409) return create(initial);                     // codigo repetido (improvavel)
      if (j.__status !== 200) throw new Error(j.error || 'falha');
      start(code);
      var p = initial ? publish(initial) : Promise.resolve();
      return p.then(function () { schedule(1000); return code; });
    });
  }

  function join(codeRaw) {
    var code = String(codeRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!CODE_RE.test(code)) return Promise.reject(new Error('codigo_invalido'));
    if (!available()) return Promise.reject(new Error('sem_servidor'));
    return api('GET', '/api/room/' + code + '?since=-1&id=' + S.id).then(function (j) {
      if (j.__status === 404) throw new Error('sala_nao_encontrada');
      if (j.__status !== 200) throw new Error(j.error || 'falha');
      start(code);
      handlePoll(j);
      schedule(interval());
      return code;
    });
  }

  // ---- perguntar o estado de tempos em tempos ----
  function interval() {
    var now = Date.now();
    if (S.failures > 0) return Math.min(10000, 2000 * S.failures);
    if (now < S.fastUntil) return 400;                                    // logo apos uma acao: acompanha de perto
    if (now - S.lastChangeAt > 120000) return 2000;                       // sala parada ha 2 min: pergunta um pouco menos
    return 1000;
  }

  function schedule(ms) { clearTimeout(S.timer); if (S.code) S.timer = setTimeout(poll, ms); }

  function poll() {
    if (!S.code) return;
    if (S.busy) { schedule(interval()); return; }
    S.busy = true;
    var code = S.code;
    api('GET', '/api/room/' + code + '?since=' + S.v + '&id=' + S.id).then(function (j) {
      S.busy = false;
      if (code !== S.code) return;
      if (j.__status === 404) { if (hooks.toast) hooks.toast('A sala foi encerrada'); stop(); return; }
      if (j.__status !== 200) throw new Error(j.error || 'falha');
      S.failures = 0;
      if (S.status !== 'ok') { S.status = 'ok'; notify(); }
      handlePoll(j);
      schedule(interval());
    }).catch(function () {
      S.busy = false;
      if (code !== S.code) return;
      S.failures++;
      if (S.status !== 'reconectando') { S.status = 'reconectando'; notify(); }
      schedule(interval());
    });
  }

  function handlePoll(j) {
    if (typeof j.members === 'number' && j.members !== S.members) { S.members = j.members; notify(); }
    if (j.state !== undefined && j.v !== S.v) {                           // o estado mudou
      S.v = j.v;
      S.lastChangeAt = Date.now();
      S.state = j.state;
      if (j.state) applyRemote(j.state);
    } else if (typeof j.v === 'number') {
      S.v = j.v;
    }
  }

  // posicao em que o video deveria estar agora
  function targetOf(st) {
    return st.pos + (st.playing ? Math.max(0, (serverNow() - st.at) / 1000) * st.rate : 0);
  }

  function applyRemote(st) {
    if (!hooks.applyRemote) return;
    try {
      hooks.applyRemote({ vid: st.vid, list: st.list, playing: st.playing, rate: st.rate, pos: st.pos, at: st.at, by: st.by, target: targetOf(st) });
    } catch (e) { /* ignora */ }
  }

  // ---- publicar o que ESTA pessoa fez ----
  function publish(partial) {
    if (!S.code) return Promise.resolve();
    var cur = S.state || {};
    var st = {
      vid: partial.vid !== undefined ? partial.vid : cur.vid,
      list: partial.list !== undefined ? partial.list : cur.list,
      pos: partial.pos !== undefined ? partial.pos : (cur.pos || 0),
      playing: partial.playing !== undefined ? partial.playing : !!cur.playing,
      rate: partial.rate !== undefined ? partial.rate : (cur.rate || 1)
    };
    if (!st.vid && !st.list) return Promise.resolve();
    S.fastUntil = Date.now() + 3000;
    var code = S.code;
    return api('POST', '/api/room/' + code, { id: S.id, op: 'set', state: st }).then(function (j) {
      if (code !== S.code) return j;
      if (j.__status === 200) { S.v = j.v; S.state = j.state; S.lastChangeAt = Date.now(); schedule(400); }
      return j;
    }).catch(function () { /* o proximo poll recupera */ });
  }

  function publishLoad(info) {
    if (!S.code || !info) return;
    var cur = S.state;
    if (cur && cur.vid === (info.id || null) && (cur.list || null) === (info.list || null) && !info.start) return;   // o mesmo video
    publish({ vid: info.id || null, list: info.list || null, pos: info.start || 0, playing: true });
  }

  function onFrameEvent(d) {
    if (!S.code || !d) return;
    var p = { pos: +d.pos || 0 };
    if (d.ev === 'play') p.playing = true;
    else if (d.ev === 'pause') p.playing = false;
    if (d.rate > 0) p.rate = d.rate;
    publish(p);
  }

  window.LMRoom = {
    hooks: hooks,
    available: available,
    create: create,
    join: join,
    leave: function () { stop(); },
    code: function () { return S.code; },
    status: function () { return S.status; },
    members: function () { return S.members; },
    state: function () { return S.state ? Object.assign({ target: targetOf(S.state) }, S.state) : null; },
    offset: function () { return S.offset; },
    serverNow: serverNow,
    publishLoad: publishLoad,
    onFrameEvent: onFrameEvent
  };
})();
