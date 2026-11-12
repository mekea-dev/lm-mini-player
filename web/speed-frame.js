/*
 * LM Mini Player - velocidade e atalhos dentro do player do YouTube.
 *
 * O programa injeta este arquivo em TODOS os quadros da janela (WebView2:
 * AddScriptToExecuteOnDocumentCreated). Ele so faz algo dentro do player
 * incorporado do YouTube (youtube.com/embed/...), onde consegue mexer no <video>
 * de verdade. A API oficial do player so aceita 0,25x a 2x; aqui vai de 0,07x a 16x,
 * como o Video Speed Controller.
 *
 *   D / S         acelera / desacelera 0,1x   (com Shift: 1x)
 *   R             volta a 1x; de novo, volta a velocidade anterior
 *   X / Z         avanca / volta 10 segundos
 *
 * A pagina do mini player repassa essas teclas para ca (mensagens "lmmp") quando o
 * foco esta fora do video, e recebe daqui a velocidade atual para mostrar na barra.
 * A ultima velocidade fica guardada e vale para o proximo video.
 */
(function () {
  'use strict';

  // so dentro do iframe do player incorporado do YouTube
  try {
    if (window === window.top) return;
    if (!/(^|\.)youtube(-nocookie)?\.com$/i.test(location.hostname)) return;
    if (location.pathname.indexOf('/embed/') !== 0) return;
  } catch (e) { return; }

  var PARENT = 'https://lmminiplayer.app';       // so a pagina do mini player pode mandar comandos
  var MIN = 0.07, MAX = 16;
  var STEP = 0.1, BIG_STEP = 1, SEEK_SECONDS = 10;
  var STORE_KEY = 'lmmp.speed';
  var LOAD_GRACE_MS = 3000;                      // o YouTube mexe na velocidade ao carregar um video
  var AD_GRACE_MS = 1500;                        // e ao entrar/sair de anuncios

  var st = {
    desired: 1,        // velocidade que o usuario quer
    last: 1,           // velocidade antes de apertar R (para R voltar a ela)
    expect: -1,        // ultima velocidade que NOS aplicamos (para reconhecer o proprio evento)
    expectUntil: 0,
    loadAt: Date.now(),
    adUntil: 0,
    osd: null,
    osdTimer: 0
  };

  // sala: o programa manda o estado da sala; aqui o <video> e posto igual e os gestos da pessoa sobem
  var room = { on: false, state: null, offset: 0, ignoreUntil: 0, lastFix: 0, pending: false, seekTimer: 0 };

  function round2(n) { return Math.round(n * 100) / 100; }
  function clamp(n) { return Math.min(MAX, Math.max(MIN, round2(n))); }
  function label(n) { return String(round2(n)) + '×'; }

  function video() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  // anuncio em andamento: o YouTube forca 1x e nao devemos brigar com ele
  function isAd() {
    var p = document.getElementById('movie_player');
    return !!(p && p.classList && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
  }

  function loadStored() {
    try {
      var v = parseFloat(window.localStorage.getItem(STORE_KEY));
      if (v >= MIN && v <= MAX) st.desired = clamp(v);
    } catch (e) { /* sem armazenamento: comeca em 1x */ }
  }

  function saveStored() {
    try { window.localStorage.setItem(STORE_KEY, String(st.desired)); } catch (e) { /* ignora */ }
  }

  // conta a velocidade para a pagina (que mostra o selo na barra)
  function report() {
    try { window.parent.postMessage({ lmmp: 1, type: 'rate', rate: st.desired }, '*'); } catch (e) { /* ignora */ }
  }

  // aviso rapido no meio do video
  function showOsd(text) {
    var el = st.osd;
    if (!el || !el.parentNode) {
      el = document.createElement('div');
      el.id = 'lm-osd';
      el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;' +
        'padding:.35em .8em;font:700 calc(14px + 3vmin)/1.2 "Segoe UI",system-ui,sans-serif;color:#fff;' +
        'background:rgba(12,12,18,.78);border:1px solid rgba(255,255,255,.25);border-radius:.5em;' +
        'pointer-events:none;opacity:0;transition:opacity .15s';
      (document.body || document.documentElement).appendChild(el);
      st.osd = el;
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(st.osdTimer);
    st.osdTimer = setTimeout(function () { el.style.opacity = '0'; }, 1100);
  }

  function applyToVideo(v, r) {
    st.expect = r;
    st.expectUntil = Date.now() + 400;
    try { v.playbackRate = r; } catch (e) { /* ignora */ }
  }

  function applyDesired(v) {
    if (v && !isAd() && Math.abs(v.playbackRate - st.desired) > 0.001) applyToVideo(v, st.desired);
  }

  function setRate(v, r, silent) {
    st.desired = clamp(r);
    if (!room.on) saveStored();                        // numa sala a velocidade e da sala: nao mexe na sua preferida
    if (v && !isAd()) applyToVideo(v, st.desired);     // em anuncio so guarda; vale depois dele
    report();
    if (!silent) showOsd(label(st.desired));
    emit('rate');
  }

  function resetRate(v) {
    if (Math.abs(st.desired - 1) > 0.001) { st.last = st.desired; setRate(v, 1); }
    else if (Math.abs(st.last - 1) > 0.001) { setRate(v, st.last); }
    else { showOsd(label(1)); }
  }

  function seekBy(v, seconds) {
    if (!v || isAd()) return;
    var t = v.currentTime + seconds;
    if (v.duration && isFinite(v.duration)) t = Math.min(t, v.duration);
    v.currentTime = Math.max(0, t);
    showOsd((seconds > 0 ? '+' : '−') + Math.abs(seconds) + ' s');
  }

  function runCmd(cmd) {
    var v = video();
    switch (cmd) {
      case 'faster':    setRate(v, st.desired + STEP); return true;
      case 'slower':    setRate(v, st.desired - STEP); return true;
      case 'fasterBig': setRate(v, st.desired + BIG_STEP); return true;
      case 'slowerBig': setRate(v, st.desired - BIG_STEP); return true;
      case 'reset':     resetRate(v); return true;
      case 'forward':   seekBy(v, SEEK_SECONDS); return true;
      case 'back':      seekBy(v, -SEEK_SECONDS); return true;
    }
    return false;
  }

  // ---- teclado (com o foco dentro do video) ----
  // pela LETRA da tecla; so em teclados nao latinos vale a posicao fisica (code)
  var BY_CHAR = { d: 'faster', s: 'slower', r: 'reset', x: 'forward', z: 'back' };
  var BY_CODE = { KeyD: 'faster', KeyS: 'slower', KeyR: 'reset', KeyX: 'forward', KeyZ: 'back' };

  function commandFor(e) {
    var ch = (e.key && e.key.length === 1) ? e.key.toLowerCase() : '';
    return /^[a-z]$/.test(ch) ? BY_CHAR[ch] : BY_CODE[e.code];
  }

  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var cmd = commandFor(e);
    if (!cmd) return;
    if (cmd === 'reset' && e.repeat) { e.preventDefault(); return; }       // segurar R nao fica alternando
    if (e.shiftKey && (cmd === 'faster' || cmd === 'slower')) cmd += 'Big';
    if (runCmd(cmd)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // ---- mudancas de velocidade que nao vieram de nos ----
  document.addEventListener('ratechange', function (e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    var now = Date.now();
    var cur = v.playbackRate;
    if (Math.abs(cur - st.expect) < 0.001 && now < st.expectUntil) return;   // foi a gente
    if (isAd()) { st.adUntil = now + AD_GRACE_MS; return; }                  // anuncio forca 1x: ignora
    if (now < st.adUntil || now - st.loadAt < LOAD_GRACE_MS) {               // o YouTube restaurando a dele
      applyDesired(v);
      return;
    }
    // mudanca vinda de outro lugar (menu do YouTube, teclas < e >): adota como a nova velocidade
    st.desired = clamp(cur);
    if (!room.on) saveStored();
    report();
    emit('rate');
  }, true);

  // video novo (ou o video depois do anuncio): aplica a velocidade escolhida
  function onNewMedia(e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    st.loadAt = Date.now();
    applyDesired(v);
    if (room.on && room.state) applyRoom(room.state);
    report();
  }
  document.addEventListener('loadstart', onNewMedia, true);
  document.addEventListener('loadedmetadata', onNewMedia, true);

  // fim de anuncio: reaplica a velocidade escolhida
  var wasAd = false;
  setInterval(function () {
    var ad = isAd();
    if (ad) st.adUntil = Date.now() + AD_GRACE_MS;
    if (wasAd && !ad) {
      applyDesired(video());
      if (room.on && room.state) applyRoom(room.state);
    }
    wasAd = ad;
  }, 500);

  // ---- salas ----
  // posicao em que o video deveria estar agora, pela hora do servidor
  function expected() {
    var s = room.state;
    if (!s) return 0;
    return s.pos + (s.playing ? Math.max(0, (Date.now() + room.offset - s.at) / 1000) * s.rate : 0);
  }

  function isVideoEvent(e) { return e && e.target && e.target.tagName === 'VIDEO'; }

  // avisa a pagina do que a PESSOA fez (nao do que a sala mandou fazer)
  function emit(ev) {
    if (!room.on || isAd() || Date.now() < room.ignoreUntil) return;
    var v = video();
    if (!v) return;
    try { window.parent.postMessage({ lmmp: 1, type: 'rev', ev: ev, pos: v.currentTime, rate: v.playbackRate }, '*'); } catch (e) { /* ignora */ }
  }

  document.addEventListener('play', function (e) { if (isVideoEvent(e)) emit('play'); }, true);
  document.addEventListener('pause', function (e) { if (isVideoEvent(e) && !e.target.ended) emit('pause'); }, true);
  document.addEventListener('seeked', function (e) {
    if (!isVideoEvent(e)) return;
    clearTimeout(room.seekTimer);
    room.seekTimer = setTimeout(function () { emit('seek'); }, 300);   // arrastar a barra gera varios pulos: manda o ultimo
  }, true);

  function applyRoom(s) {
    room.state = s;
    var v = video();
    if (!room.on || !v || isAd()) { room.pending = true; return; }
    room.pending = false;
    var exp = expected();
    room.ignoreUntil = Date.now() + 2500;                              // o que fizermos agora nao e "gesto da pessoa"
    if (Math.abs(v.currentTime - exp) > 0.7) { try { v.currentTime = exp; } catch (e) { /* ignora */ } }
    st.desired = clamp(s.rate);
    applyToVideo(v, st.desired);
    report();
    if (s.playing && v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () { /* autoplay barrado */ }); }
    if (!s.playing && !v.paused) v.pause();
  }

  function applyRoomMsg(d) {
    if (+d.offset || d.offset === 0) room.offset = +d.offset;
    applyRoom({ pos: +d.pos || 0, at: +d.at || 0, playing: !!d.playing, rate: +d.rate > 0 ? +d.rate : 1 });
  }

  function setRoomOn(on) {
    room.on = on;
    if (!on) {                                                         // saiu da sala: volta a sua velocidade preferida
      room.state = null;
      room.pending = false;
      loadStored();
      var v = video();
      if (v) applyDesired(v);
      report();
    }
  }

  // se a pessoa se atrasa ou adianta (carregamento, anuncio, rede), o video e trazido de volta para a sala
  setInterval(function () {
    if (!room.on || !room.state || !room.state.playing) return;
    var v = video();
    if (!v || v.paused || isAd()) return;
    if (Math.abs(expected() - v.currentTime) > 1.5 && Date.now() - room.lastFix > 6000) {
      room.lastFix = Date.now();
      room.ignoreUntil = Date.now() + 2500;
      try { v.currentTime = expected(); } catch (e) { /* ignora */ }
    }
  }, 2000);

  // ---- conversa com a pagina do mini player ----
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || e.origin !== PARENT) return;
    var d = e.data;
    if (!d || d.lmmp !== 1) return;
    if (d.type === 'hello') report();
    else if (d.type === 'cmd') runCmd(String(d.cmd));
    else if (d.type === 'roomOn') setRoomOn(!!d.on);
    else if (d.type === 'room') applyRoomMsg(d);
    else if (d.type === 'roomclock') room.offset = +d.offset || 0;
  });

  loadStored();
  report();
})();
