/*
 * LM Mini Player - salas: ver o mesmo video ao mesmo tempo que outras pessoas (e conversar por voz).
 *
 * A pagina abre uma conexao WebSocket com a sala no servidor (relay/worker.js). Tudo chega na hora:
 * quando alguem pausa, toca, pula, muda a velocidade ou troca de video, o servidor avisa todo mundo; quando
 * alguem entra ou sai (ou fecha o programa) a lista de pessoas muda no mesmo instante. O estado leva a hora
 * do SERVIDOR, entao cada um calcula a posicao certa mesmo com o relogio do computador adiantado ou atrasado.
 * Nao transmite audio nem video: cada pessoa toca o proprio video (a voz vai direto entre os computadores:
 * veja voice.js, que usa esta conexao so para os dois se encontrarem).
 *
 *   LMRoom.available()        o servidor de salas esta configurado?
 *   LMRoom.create(inicial)    cria uma sala (com o video atual, se houver) -> Promise(codigo)
 *   LMRoom.join(codigo)       entra numa sala -> Promise(codigo)
 *   LMRoom.leave()            sai da sala
 *   LMRoom.code() / status() / members() / myId() / name() / setName(nome)
 *   LMRoom.publishLoad(info)  avisa a sala que a pessoa trocou de video
 *   LMRoom.onFrameEvent(ev)   avisa a sala de play/pause/pulo/velocidade (vindo do player)
 *   LMRoom.send(obj)          manda uma mensagem solta para o servidor (voz); LMRoom.setVoice(on, mudo)
 *   LMRoom.hooks              { changed, toast, applyRemote, signal, memberJoined, memberLeft, memberUpdated, opened, left }
 */
(function () {
  'use strict';

  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // sem 0, 1, I, O (confundem)
  var CODE_LEN = 8;
  var CODE_RE = /^[A-HJ-NP-Z2-9]{6,12}$/;
  var FATAL = { 4400: 'falha', 4404: 'sala_nao_encontrada', 4409: 'codigo_em_uso', 4413: 'sala_cheia', 4429: 'falha', 4000: 'trocada' };
  var RETRY_MS = [1000, 2000, 3000, 5000, 8000, 10000];
  var KEEPALIVE_MS = 20000;        // "estou aqui" (o servidor responde sem acordar a sala)
  var SYNC_MS = 30000;             // refaz a conta do relogio
  var DEAD_MS = 50000;             // sem ouvir nada do servidor por tanto tempo: a conexao morreu

  var hooks = {};
  var S = {
    id: randomId(24),              // identifica ESTA janela (nao e guardado)
    name: loadName(),
    code: null,
    ws: null,
    status: 'off',                 // off | conectando | ok | reconectando
    v: -1,                         // versao do estado que ja conhecemos
    state: null,                   // { vid, list, pos, playing, rate, at, by }
    members: [],                   // [{ id, name, voice, muted }]
    offset: 0,                     // hora do servidor - hora local (ms)
    bestRtt: 1e9,
    retry: 0,
    retryTimer: 0,
    keepTimer: 0,
    syncTimer: 0,
    lastRx: 0,
    leaving: false,
    pending: null                  // { resolve, reject, create, initial } enquanto a primeira conexao nao termina
  };

  function randomId(n) {
    var a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = '';
    for (var i = 0; i < n; i++) s += ALPHABET.charAt(a[i] % ALPHABET.length);
    return s.toLowerCase();
  }

  function loadName() {
    try { return cleanName(window.localStorage.getItem('lmmp.name')); } catch (e) { return ''; }
  }

  function cleanName(n) {
    n = typeof n === 'string' ? n : '';
    n = n.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
    return Array.from(n).slice(0, 24).join('');
  }

  function relayBase() {
    try { var o = window.localStorage.getItem('lmmp.relay'); if (o) return o; } catch (e) { /* ignora */ }
    return (window.LM_CONFIG && window.LM_CONFIG.relay) || '';
  }

  function wsBase() { return relayBase().replace(/\/+$/, '').replace(/^http/i, 'ws'); }

  function available() { return !!relayBase(); }
  function serverNow() { return Date.now() + S.offset; }
  function notify() { if (hooks.changed) { try { hooks.changed(); } catch (e) { /* ignora */ } } }
  function call(name, a, b) { if (hooks[name]) { try { hooks[name](a, b); } catch (e) { /* ignora */ } } }

  // ---- relogio: estima (hora do servidor - hora local) pela amostra de menor atraso ----
  function sampleClock(c, now) {
    var t1 = Date.now();
    var rtt = t1 - c;
    if (!(rtt >= 0) || rtt > 15000) return;
    var off = now - (c + t1) / 2;
    if (rtt <= S.bestRtt) { S.bestRtt = rtt; S.offset = off; }
    else if (rtt <= S.bestRtt * 1.5 + 30) { S.offset = S.offset * 0.8 + off * 0.2; }
    S.bestRtt = S.bestRtt * 1.02 + 0.5;                 // a melhor amostra "envelhece" (a rede muda)
  }

  function send(obj) {
    var ws = S.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function ping() { send({ t: 'ping', c: Date.now() }); }

  function startTimers() {
    stopTimers();
    S.keepTimer = setInterval(function () {
      if (Date.now() - S.lastRx > DEAD_MS) { try { S.ws && S.ws.close(); } catch (e) { /* ignora */ } return; }
      send('ping');
    }, KEEPALIVE_MS);
    S.syncTimer = setInterval(ping, SYNC_MS);
    [0, 250, 500, 800].forEach(function (ms) { setTimeout(ping, ms); });       // varias amostras logo ao entrar
  }

  function stopTimers() { clearInterval(S.keepTimer); clearInterval(S.syncTimer); S.keepTimer = 0; S.syncTimer = 0; }

  // ---- codigo, entrar, criar, sair ----
  function makeCode() {
    var a = new Uint8Array(CODE_LEN);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = '';
    for (var i = 0; i < CODE_LEN; i++) s += ALPHABET.charAt(a[i] % ALPHABET.length);
    return s;
  }

  function reset() {
    var had = !!S.code;
    stopTimers();
    clearTimeout(S.retryTimer);
    S.retryTimer = 0;
    S.code = null; S.status = 'off'; S.v = -1; S.state = null; S.members = []; S.retry = 0;
    S.pending = null;
    if (had) call('left');                       // quem usa a sala (a voz) larga o que estava usando
  }

  function closeSocket() {
    var ws = S.ws;
    S.ws = null;
    if (ws) { try { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.close(1000); } catch (e) { /* ignora */ } }
  }

  function stop(silent) {
    S.leaving = true;
    closeSocket();
    reset();
    if (!silent) notify();
  }

  function connect(code, create, initial) {
    return new Promise(function (resolve, reject) {
      stop(true);
      S.leaving = false;
      S.code = code;
      S.status = 'conectando';
      S.pending = { resolve: resolve, reject: reject, create: create, initial: initial };
      openSocket(create);
      notify();
    });
  }

  function openSocket(create) {
    var url = wsBase() + '/ws/' + S.code + '?id=' + S.id + '&name=' + encodeURIComponent(S.name || 'Visitante') + (create ? '&create=1' : '');
    var ws;
    try { ws = new WebSocket(url); } catch (e) { failPending('falha'); return; }
    S.ws = ws;
    ws.onopen = function () { if (ws === S.ws) S.lastRx = Date.now(); };
    ws.onmessage = function (ev) { if (ws === S.ws) { S.lastRx = Date.now(); onMessage(ev.data); } };
    ws.onerror = function () { /* o "close" vem logo depois */ };
    ws.onclose = function (ev) { if (ws === S.ws) onClose(ev); };
  }

  function failPending(key) {
    var p = S.pending;
    stop(true);
    S.leaving = false;
    notify();
    if (p) p.reject(new Error(key));
  }

  function onClose(ev) {
    S.ws = null;
    stopTimers();
    var key = FATAL[ev && ev.code];
    if (S.pending) { failPending(key || 'falha'); return; }               // a primeira conexao nao deu certo
    if (key) {                                                            // a sala acabou (ou nos recusou) com a gente la dentro
      stop(true);
      S.leaving = false;
      if (key !== 'trocada') call('toast', key === 'sala_nao_encontrada' ? 'A sala foi encerrada' : (key === 'sala_cheia' ? 'A sala está cheia' : 'Você foi desconectado da sala'));
      notify();
      return;
    }
    S.status = 'reconectando';                                            // caiu a rede: volta sozinho
    notify();
    var wait = RETRY_MS[Math.min(S.retry, RETRY_MS.length - 1)];
    S.retry++;
    S.retryTimer = setTimeout(function () { if (S.code && !S.ws && !S.leaving) openSocket(false); }, wait);
  }

  function onMessage(text) {
    if (text === 'pong') return;
    var m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    switch (m.t) {
      case 'hello': {
        var prevV = S.v;
        S.status = 'ok';
        S.retry = 0;
        S.v = m.v;
        S.state = m.state;
        S.members = m.members || [];
        S.offset = m.now - Date.now();               // primeira estimativa (o erro e o atraso de uma volta); os pings refinam
        S.bestRtt = 1e9;
        startTimers();
        var p = S.pending;
        S.pending = null;
        if (p && p.create && p.initial) publish(p.initial);
        call('opened');
        notify();
        if (m.state && (!p || !p.create) && m.v !== prevV) applyRemote(m.state);   // entrou (ou voltou) e a sala tem algo tocando
        if (p) p.resolve(S.code);
        break;
      }
      case 'join':
        upsert(m.m);
        if (m.m && m.m.id !== S.id) call('toast', (m.m.name || 'Alguém') + ' entrou na sala');
        call('memberJoined', m.m);
        notify();
        break;
      case 'leave': {
        var who = find(m.id);
        S.members = S.members.filter(function (x) { return x.id !== m.id; });
        if (who && who.id !== S.id) call('toast', (who.name || 'Alguém') + ' saiu da sala');
        call('memberLeft', m.id);
        notify();
        break;
      }
      case 'member':
        upsert(m.m);
        call('memberUpdated', m.m);
        notify();
        break;
      case 'state':
        S.v = m.v;
        S.state = m.state;
        if (m.state && m.state.by !== S.id) applyRemote(m.state);
        break;
      case 'sig':
        call('signal', m.from, m.data);
        break;
      case 'pong':
        sampleClock(m.c, m.now);
        break;
    }
  }

  function find(id) { for (var i = 0; i < S.members.length; i++) if (S.members[i].id === id) return S.members[i]; return null; }

  function upsert(mem) {
    if (!mem || !mem.id) return;
    for (var i = 0; i < S.members.length; i++) {
      if (S.members[i].id === mem.id) { S.members[i] = mem; return; }
    }
    S.members.push(mem);
  }

  function create(initial) {
    if (!available()) return Promise.reject(new Error('sem_servidor'));
    function attempt(tries) {
      return connect(makeCode(), true, initial).then(null, function (err) {
        if (err && err.message === 'codigo_em_uso' && tries < 3) return attempt(tries + 1);   // codigo repetido (improvavel)
        throw err;
      });
    }
    return attempt(0);
  }

  function join(codeRaw) {
    var code = String(codeRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!CODE_RE.test(code)) return Promise.reject(new Error('codigo_invalido'));
    if (!available()) return Promise.reject(new Error('sem_servidor'));
    return connect(code, false, null);
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
    if (!S.code || S.status !== 'ok') return;
    var cur = S.state || {};
    var st = {
      vid: partial.vid !== undefined ? partial.vid : cur.vid,
      list: partial.list !== undefined ? partial.list : cur.list,
      pos: partial.pos !== undefined ? partial.pos : (cur.pos || 0),
      playing: partial.playing !== undefined ? partial.playing : !!cur.playing,
      rate: partial.rate !== undefined ? partial.rate : (cur.rate || 1)
    };
    if (!st.vid && !st.list) return;
    send({ t: 'set', st: st });
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

  function setName(n) {
    S.name = cleanName(n);
    try { window.localStorage.setItem('lmmp.name', S.name); } catch (e) { /* ignora */ }
    if (S.code && S.name) send({ t: 'name', name: S.name });
  }

  // fechar a janela: sai da sala na hora (sem esperar a conexao cair)
  window.addEventListener('pagehide', function () { if (S.ws) { try { S.ws.close(1000); } catch (e) { /* ignora */ } } });

  window.LMRoom = {
    hooks: hooks,
    available: available,
    create: create,
    join: join,
    leave: function () { stop(); },
    code: function () { return S.code; },
    status: function () { return S.status; },
    members: function () { return S.members.slice(); },
    myId: function () { return S.id; },
    name: function () { return S.name; },
    setName: setName,
    state: function () { return S.state ? Object.assign({ target: targetOf(S.state) }, S.state) : null; },
    offset: function () { return S.offset; },
    serverNow: serverNow,
    publishLoad: publishLoad,
    onFrameEvent: onFrameEvent,
    send: send,
    setVoice: function (on, muted) { return send({ t: 'voice', on: !!on, muted: !!muted }); },
    __drop: function () { if (S.ws) { try { S.ws.close(4001); } catch (e) { /* ignora */ } } }     // so para testes: simula a rede caindo
  };
})();
