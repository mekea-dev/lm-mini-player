/*
 * LM Mini Player - interface.
 * Roda dentro da janela do programa (WebView2) e tambem num navegador comum, para teste.
 *
 * Conversa com o programa (C#) por mensagens de texto "comando:argumento":
 *   pagina -> programa:  ready | drag | size:<borda> | min | close | pin:0/1 | op:0.85 (transparencia, 0.10 a 1)
 *                        opdrag:0/1 (a barra de transparencia esta sendo arrastada) | menu:0/1 (menu suspenso aberto)
 *                        ov:0/1 (ha uma tela do programa por cima do video: o modo fantasma mostra a janela inteira)
 *                        tbs:<p=..;nx=..;mic=..;hear=..> (estado dos botoes da miniatura da barra de tarefas)
 *                        paste | typing:0/1 | open:<url>
 *                        mod:<player|youtube|spotify> | search:<texto> | modhome | modhide | yhome | yprep
 *                        ysearch:<n>:<texto> | ymore:<n>:<token> | yinfo:<n>:<id>   (veja yt.js)
 *                        update:<link do video atual> | updweb
 *   programa -> pagina:  cfg:pin=1;op=1 | url:<texto> | link | ui:0/1 | dragend
 *                        menu:toggle | menu:close (a alca do modo fantasma foi clicada)
 *                        tb:<prev|toggle|next|mic|hear|vdown|vup> (botao da miniatura da barra de tarefas)
 *                        mod:<modulo> | modtitle:<texto> | modfail:<modulo>
 *                        yres:<n>:<json> | yinfo:<n>:<json>   (veja yt.js)
 *                        upd:ready:<versao> | upd:manual:<versao> | upd:busy | upd:fail
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var HAS_HOST = !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage);
  var Room = window.LMRoom;
  var APP_NAME = 'LM Mini Player';
  var GHOST_MAX = 0.5;                                     // ate esta transparencia a janela vira "fantasma" (igual a GhostMax em Program.cs)
  var HIST_MAX = 30;                                       // videos lembrados para o botao "anterior"
  // teclas de velocidade (como no Video Speed Controller): pela LETRA da tecla; so em teclados
  // nao latinos vale a posicao fisica (code)
  var SPEED_BY_CHAR = { d: 'faster', s: 'slower', r: 'reset', x: 'forward', z: 'back' };
  var SPEED_BY_CODE = { KeyD: 'faster', KeyS: 'slower', KeyR: 'reset', KeyX: 'forward', KeyZ: 'back' };
  function speedCmdFor(e) {
    var ch = (e.key && e.key.length === 1) ? e.key.toLowerCase() : '';
    return /^[a-z]$/.test(ch) ? SPEED_BY_CHAR[ch] : SPEED_BY_CODE[e.code];
  }
  var TEST_MUTE = /[?&]mute=1\b/.test(location.search);   // so para testes automaticos

  var S = {
    apiRequested: false,
    apiReady: false,
    pending: null,      // video esperando a API do YouTube carregar
    player: null,
    current: null,      // { id, list, start, index, url }
    hostActive: false,  // o programa avisa que o mouse esta se mexendo sobre a janela
    barHover: false,
    typing: false,
    pin: true,
    opacity: 1,
    rate: 1,            // velocidade do video (vem do player por mensagem)
    mode: 'player',     // 'player' | 'youtube' (busca) | 'spotify'
    ytView: 'results',  // no modo youtube: 'results' (lista do programa) | 'site' (o site do YouTube, janela do programa)
    ytq: '',            // o que foi pesquisado
    ytItems: [],        // videos achados
    ytMore: null,       // proxima pagina (token) ou null
    ytBusy: false,
    ytErr: '',
    ytGen: 0,           // descarta resposta de pesquisa antiga
    rpTab: 'room',      // aba do painel da sala: 'room' | 'queue'
    qDrag: null,        // arraste da fila em andamento
    qIdle: true,        // nada tocando (ou o ultimo video acabou sem proximo): o que entrar na SUA fila comeca a tocar
    fromQueue: null,    // id do video que a SUA fila pos para tocar (se nao puder tocar aqui, passa para o proximo)
    hist: [],           // videos que tocaram antes deste (botao "anterior")
    histNav: false,     // esta voltando no historico: nao poe o video de agora la
    opDrag: false,      // a barra de transparencia esta sendo arrastada
    lastVol: 0,         // ultimo volume do video antes de ficar mudo (para o botao de som voltar a ele)
    toastTimer: 0,
    muteOnReady: false  // so para testes automaticos (abre o video mudo)
  };

  /* ---------- ponte com o programa ---------- */

  function toHost(msg) {
    if (HAS_HOST) window.chrome.webview.postMessage(msg);
    else if (window.console) console.log('[pagina -> programa]', msg);
  }

  function onHostMessage(text) {
    if (typeof text !== 'string') return;
    if (window.LMYt && window.LMYt.onHost(text)) return;            // resposta da pesquisa do YouTube
    var i = text.indexOf(':');
    var cmd = i < 0 ? text : text.slice(0, i);
    var arg = i < 0 ? '' : text.slice(i + 1);
    if (cmd === 'cfg') {
      applyCfg(arg);
    } else if (cmd === 'url') {
      if (queueTabOpen()) addLinkToQueue(arg); else handleText(arg);   // com a aba Fila aberta, colar um link poe na fila
    } else if (cmd === 'link') {
      openOmnibox();
    } else if (cmd === 'mod') {
      setMode(arg);
    } else if (cmd === 'modtitle') {
      $('modTitle').textContent = arg;
    } else if (cmd === 'modfail') {
      setMode('player');
      toast('Não foi possível abrir este módulo');
    } else if (cmd === 'ui') {
      S.hostActive = arg === '1';
      if (!S.hostActive && !$('bar').matches(':hover')) S.barHover = false;
      refreshUi();
    } else if (cmd === 'dragend') {
      S.barHover = false;
      refreshUi();
    } else if (cmd === 'upd') {
      onUpdate(arg);
    } else if (cmd === 'menu') {
      if (arg === 'toggle') { if (menuIsOpen()) closeMenu(false); else openMenu(); }      // clique na alca do modo fantasma
      else if (arg === 'close') closeMenu(false);                                         // o mouse saiu da janela com o menu aberto
    } else if (cmd === 'tb') {
      tbAction(arg);                                                                      // botao da miniatura da barra de tarefas
    } else if (cmd === 'dbg') {
      window.__dbg = arg;                                                                 // so nos testes (o programa so manda isto com LMMP_TEST=1)
    }
  }

  if (HAS_HOST) {
    window.chrome.webview.addEventListener('message', function (e) { onHostMessage(e.data); });
  }
  window.__lm = { fromHost: onHostMessage, state: S, renderRate: function () { renderRate(); }, resumeLink: function () { return resumeLink(); },
                  fitBar: function () { fitSig = ''; fitBarIfNeeded(); }, tbState: function () { return tbState(); } };   // ganchos para testes

  function applyCfg(arg) {
    arg.split(';').forEach(function (kv) {
      var p = kv.split('=');
      if (p[0] === 'pin') { S.pin = p[1] === '1'; renderPin(); }
      else if (p[0] === 'op') {
        var v = parseFloat(p[1]);
        if (v > 0 && v <= 1) { S.opacity = v; renderOpacity(); }
      }
    });
  }

  /* ---------- pequenas utilidades de tela ---------- */

  function refreshUi() {
    var always = body.classList.contains('empty') || body.classList.contains('home') ||
      body.classList.contains('err') || body.classList.contains('browse');
    body.classList.toggle('ui', always || S.hostActive || S.barHover || S.typing || menuIsOpen());
    renderRate();
    syncOverlay();
  }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function setTitle(t) {
    var name = (t || '').trim() || APP_NAME;
    $('ttl').textContent = name;
    $('ttl').title = name;
    document.title = name === APP_NAME ? APP_NAME : name + ' · ' + APP_NAME;
    fitBarIfNeeded();
  }

  function renderPin() {
    var b = $('bPin');
    b.classList.toggle('on', S.pin);
    b.setAttribute('aria-pressed', S.pin ? 'true' : 'false');
    b.title = S.pin
      ? 'Sempre por cima: ligado (clique para desligar)'
      : 'Sempre por cima: desligado (clique para ligar)';
    var m = $('mPin');                               // o mesmo botao na barra do modo navegacao
    m.classList.toggle('on', S.pin);
    m.setAttribute('aria-pressed', S.pin ? 'true' : 'false');
    m.title = b.title;
    $('mnPin').setAttribute('aria-checked', S.pin ? 'true' : 'false');
  }

  // a barra de transparencia (no menu) e o numero ao lado dela; abaixo de GHOST_MAX o aviso do modo fantasma fica em destaque
  function renderOpacity() {
    var pct = Math.round(S.opacity * 100);
    var r = $('mnOp');
    if (!S.opDrag && document.activeElement !== r) r.value = String(pct);
    $('mnOpVal').textContent = pct + '%';
    $('mnHint').classList.toggle('on', S.opacity <= GHOST_MAX + 0.0001);
    $('bMenu').title = 'Menu: transparência (' + pct + '%) e mais';
    $('mMenu').title = $('bMenu').title;
  }

  // selo da velocidade na barra: so aparece quando ha video e a velocidade nao e 1x
  function renderRate() {
    var b = $('bSpeed');
    var on = Math.abs(S.rate - 1) > 0.001 && S.current &&
      !body.classList.contains('empty') && !body.classList.contains('err');
    b.hidden = !on;
    b.textContent = (Math.round(S.rate * 100) / 100) + '×';
    $('mnSpeed').hidden = !on;
    $('mnSpeedVal').textContent = b.textContent;
    fitBarIfNeeded();
  }

  // manda um comando (faster, slower, reset...) para o script que vive dentro do player do YouTube
  function sendToFrame(cmd) {
    try {
      var f = S.player && S.player.getIframe && S.player.getIframe();
      if (f && f.contentWindow) {
        f.contentWindow.postMessage({ lmmp: 1, type: cmd === 'hello' ? 'hello' : 'cmd', cmd: cmd }, 'https://www.youtube.com');
      }
    } catch (err) { /* ignora */ }
  }

  // devolve o foco ao video: assim as teclas (D, S, R, X, Z e as do proprio YouTube) valem de novo
  function focusPlayer() {
    try {
      var f = S.player && S.player.getIframe && S.player.getIframe();
      if (menuIsOpen()) return;                                      // focar o video tiraria o foco desta pagina e fecharia o menu
      if (f && S.mode === 'player' && !body.classList.contains('home')) f.focus();
    } catch (err) { /* ignora */ }
  }

  /* ---------- pilula: tira da barra o que nao cabe (o menu ≡ tem tudo) ---------- */

  // Ordem em que os botoes saem da barra quando a janela estreita (o primeiro sai antes). Numa sala o botao da sala e o
  // microfone ganham prioridade. Ficam sempre: o ≡, a alca de arrastar, minimizar e fechar.
  var FIT_NORMAL = ['ttl', 'bLink', 'bRoom', 'bPin', 'bSpeed', 'bMic'];
  var FIT_ROOM = ['ttl', 'bLink', 'bPin', 'bSpeed', 'bRoom', 'bMic'];
  var fitSig = '';

  function fitBar() {
    var bar = $('bar');
    var order = body.classList.contains('in-room') ? FIT_ROOM : FIT_NORMAL;
    var i;
    for (i = 0; i < FIT_NORMAL.length; i++) $(FIT_NORMAL[i]).classList.remove('fit-off');
    if (!bar.offsetWidth) return;                                      // barra escondida (modo navegacao): nada a medir
    if ($('ttl').offsetWidth < 64) $('ttl').classList.add('fit-off');  // titulo curto demais para ler: sai
    for (i = 0; i < order.length && bar.scrollWidth > bar.clientWidth + 1; i++) $(order[i]).classList.add('fit-off');
  }

  // so refaz a conta quando algo que muda a largura mudou (tamanho da janela, estado da tela, selo de velocidade, microfone, titulo)
  function fitBarIfNeeded() {
    var sig = [window.innerWidth, body.className.replace(/(^|\s)(ui|menu-open)(?=\s|$)/g, ''), $('bSpeed').hidden ? '' : $('bSpeed').textContent,
      $('bMic').hidden ? 0 : 1, $('ttl').textContent].join('|');
    if (sig === fitSig) return;
    fitSig = sig;
    fitBar();
  }

  /* ---------- tela do programa por cima do video (o modo fantasma mostra a janela inteira enquanto houver uma) ---------- */

  var lastOv = null;

  function syncOverlay() {
    var on = menuIsOpen() || !$('roomPanel').hidden || body.classList.contains('empty') || body.classList.contains('home') ||
      body.classList.contains('err') || body.classList.contains('browse');
    if (on === lastOv) return;
    lastOv = on;
    toHost('ov:' + (on ? 1 : 0));
  }

  /* ---------- menu suspenso (botao ≡): transparencia e as acoes da barra ---------- */

  function menuIsOpen() { return !$('menu').hidden; }

  // o que o menu mostra agora (so com o menu aberto; e de novo quando algo muda enquanto ele esta aberto)
  function renderMenu() {
    renderOpacity();
    syncVolumes();
    var q = qItems().length;
    var qb = $('mnRoomQ');
    qb.hidden = !q;
    qb.textContent = q > 9 ? '9+' : String(q);
    var inRoom = !!Room.code();
    var sup = !!(Voice && Voice.supported());
    var on = !!(Voice && Voice.isOn());
    var muted = on && Voice.isMuted();
    var deaf = on && Voice.isDeaf();
    var mic = $('mnMic');
    mic.hidden = !(inRoom && sup);
    mic.classList.toggle('live', on && !muted);
    mic.classList.toggle('muted', on && muted);
    mic.querySelector('use').setAttribute('href', on && muted ? '#i-mic-off' : '#i-mic');
    $('mnMicText').textContent = !on ? 'Entrar na voz' : (muted ? 'Ligar o microfone' : 'Silenciar o microfone');
    var hear = $('mnHear');
    hear.hidden = !(inRoom && sup && on);
    hear.classList.toggle('muted', deaf);
    hear.setAttribute('aria-checked', deaf ? 'false' : 'true');
    hear.querySelector('use').setAttribute('href', deaf ? '#i-headphones-off' : '#i-headphones');
    $('mnHearText').textContent = deaf ? 'Voltar a ouvir as vozes' : 'Parar de ouvir as vozes';
  }

  function openMenu() {
    if (menuIsOpen()) return;
    $('roomPanel').hidden = true;                                      // um painel de cada vez (sem devolver o foco ao video: isso fecharia o menu)
    renderMenu();
    $('menu').hidden = false;
    body.classList.add('menu-open');
    $('bMenu').setAttribute('aria-expanded', 'true');
    $('mMenu').setAttribute('aria-expanded', 'true');
    toHost('menu:1');
    refreshUi();
  }

  function endOpDrag() {
    if (!S.opDrag) return;
    S.opDrag = false;
    toHost('opdrag:0');
    renderOpacity();
  }

  function closeMenu(refocus) {
    if (!menuIsOpen()) return;
    $('menu').hidden = true;
    body.classList.remove('menu-open');
    $('bMenu').setAttribute('aria-expanded', 'false');
    $('mMenu').setAttribute('aria-expanded', 'false');
    endOpDrag();
    toHost('menu:0');
    refreshUi();
    if (refocus) focusPlayer();
  }

  /* ---------- botoes da miniatura da barra de tarefas (anterior, play/pause, proxima, microfone, fone, volume) ---------- */

  function histKey(i) { return i ? (i.id || '') + '|' + (i.list || '') : ''; }

  function pushHist(info) {
    if (!info || (!info.id && !info.list)) return;
    var h = S.hist;
    if (h.length && histKey(h[h.length - 1]) === histKey(info)) return;
    h.push({ id: info.id, list: info.list, start: 0, index: info.index || 0, url: info.url });
    if (h.length > HIST_MAX) h.shift();
  }

  // ha para onde ir? fila (da sala ou a sua) ou proximo video da lista do YouTube que esta tocando
  function canNext() {
    if (qItems().length > 0) return true;
    try {
      if (S.current && S.current.list && S.player && S.player.getPlaylist) {
        var pl = S.player.getPlaylist();
        var ix = S.player.getPlaylistIndex();
        return !!(pl && ix >= 0 && ix < pl.length - 1);
      }
    } catch (e) { /* ignora */ }
    return false;
  }

  // p: -1 nada tocando, 0 parado, 1 tocando | nx: ha proximo | mic: -1 fora da voz, 0 nao entrou, 1 ligado, 2 mudo | hear: -1 fora da voz, 1 ouvindo, 0 fone desligado
  function tbState() {
    var p = -1, nx = 0;
    if (S.current && !body.classList.contains('empty')) {
      p = 0;
      try { var st = S.player.getPlayerState(); if (st === 1 || st === 3) p = 1; } catch (e) { /* o player ainda esta carregando */ }
      nx = canNext() ? 1 : 0;
    }
    var mic = -1, hear = -1;
    if (Room.code() && Voice && Voice.supported()) {
      var on = Voice.isOn();
      mic = !on ? 0 : (Voice.isMuted() ? 2 : 1);
      hear = on ? (Voice.isDeaf() ? 0 : 1) : -1;
    }
    return 'p=' + p + ';nx=' + nx + ';mic=' + mic + ';hear=' + hear;
  }

  var tbLast = '';
  function pushTb() {
    var s = tbState();
    if (s === tbLast) return;
    tbLast = s;
    toHost('tbs:' + s);
  }

  function togglePlayback() {
    if (!S.current || !S.player) return;
    try {
      var st = S.player.getPlayerState();
      if (st === 1 || st === 3) S.player.pauseVideo(); else S.player.playVideo();   // tocando ou carregando: pausa; senao toca
    } catch (e) { /* ignora */ }
  }

  function skipNext() {
    if (!S.current) return;
    if (qItems().length > 0) {                                        // a fila manda (na sala, para todos)
      if (Room.code()) Room.qNext(); else localAdvance(true);
      return;
    }
    try {
      if (canNext() && S.player.nextVideo) { S.player.nextVideo(); return; }
    } catch (e) { /* ignora */ }
    toast('Não há próximo vídeo na fila');
  }

  // como nos tocadores de musica: depois de 3 s volta ao comeco do video; no comeco volta ao video de antes
  function skipPrev() {
    if (!S.current || !S.player) return;
    var t = 0;
    try { t = S.player.getCurrentTime() || 0; } catch (e) { /* ignora */ }
    if (t <= 3) {
      try {
        if (S.current.list && S.player.getPlaylistIndex && S.player.getPlaylistIndex() > 0) { S.player.previousVideo(); return; }
      } catch (e) { /* ignora */ }
      var h = S.hist.pop();
      if (h) {
        S.histNav = true;
        try { play(h); } finally { S.histNav = false; }
        return;
      }
    }
    try { S.player.seekTo(0, true); } catch (e) { /* ignora */ }
  }

  // volume do video em passos de 5% (como as setas do YouTube)
  function stepVolume(d) {
    var cur = videoVolume();
    if (!S.current || cur === null) return;
    var v = Math.max(0, Math.min(100, Math.round(cur / 5) * 5 + d));
    setVideoVolume(v);
    toast('Volume do vídeo: ' + v + '%');
  }

  // o "fone": para de ouvir as vozes da sala (e volta a ouvir); so vale dentro da voz
  function toggleHear() {
    if (!Voice || !Voice.isOn()) return;
    var d = !Voice.isDeaf();
    Voice.setDeaf(d);
    toast(d ? 'Você parou de ouvir as vozes da sala' : 'Voltou a ouvir as vozes da sala');
  }

  function tbAction(a) {
    if (a === 'toggle') togglePlayback();
    else if (a === 'next') skipNext();
    else if (a === 'prev') skipPrev();
    else if (a === 'mic') { if (Room.code()) micClick(); }
    else if (a === 'hear') toggleHear();
    else if (a === 'vdown') stepVolume(-5);
    else if (a === 'vup') stepVolume(5);
    setTimeout(pushTb, 150);
  }

  /* ---------- sala: ver o mesmo video junto com outras pessoas (e conversar por voz) ---------- */

  var Voice = window.LMVoice;

  function sendToFrameRaw(obj) {
    try {
      var f = S.player && S.player.getIframe && S.player.getIframe();
      if (f && f.contentWindow) {
        var m = { lmmp: 1 };
        for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) m[k] = obj[k]; }
        f.contentWindow.postMessage(m, 'https://www.youtube.com');
      }
    } catch (err) { /* ignora */ }
  }

  function sendRoomToFrame(r) {
    sendToFrameRaw({ type: 'room', pos: r.pos, at: r.at, playing: r.playing, rate: r.rate, offset: Room.offset() });
  }

  function roomMsg(text) { $('rpMsg').textContent = text || ''; }

  function roomError(err) {
    var m = err && err.message;
    if (m === 'sem_servidor') return 'Salas desligadas: o servidor de salas ainda não foi configurado.';
    if (m === 'codigo_invalido') return 'Código inválido. Ele tem de 6 a 12 letras e números.';
    if (m === 'sala_nao_encontrada') return 'Sala não encontrada. Confira o código.';
    if (m === 'sala_cheia') return 'A sala está cheia (até 8 pessoas).';
    return 'Não foi possível falar com o servidor de salas.';
  }

  function micErrorText(e) {
    if (e === 'NotAllowedError' || e === 'SecurityError') return 'O microfone está bloqueado. No Windows: Configurações > Privacidade > Microfone, e permita que aplicativos da área de trabalho usem o microfone. Você entrou só ouvindo.';
    if (e === 'NotFoundError' || e === 'OverconstrainedError') return 'Nenhum microfone encontrado. Você entrou na voz só ouvindo.';
    if (e === 'NotReadableError' || e === 'AbortError') return 'O microfone está em uso por outro programa. Você entrou na voz só ouvindo.';
    return 'Não consegui usar o microfone. Você entrou na voz só ouvindo.';
  }

  // o que esta tocando agora, para a sala nova ja nascer com o video atual
  function currentRoomState() {
    if (!S.current || !S.player) return null;
    var pos = 0, playing = false;
    try { pos = S.player.getCurrentTime() || 0; playing = S.player.getPlayerState() === 1; } catch (e) { /* ignora */ }
    return { vid: S.current.id || null, list: S.current.list || null, pos: pos, playing: playing, rate: S.rate || 1 };
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function icon(id) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('class', 'i');
    var u = document.createElementNS(ns, 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  }

  function colorFor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return 'hsl(' + h + ' 55% 42%)';
  }

  // volume do video (o do player do YouTube), separado do volume das vozes
  // (o controle de volume do proprio YouTube fica escondido, veja speed-frame.js: o volume do video e ajustado aqui,
  // no menu ≡, no painel da sala e nos botoes da miniatura da barra de tarefas)
  function videoVolume() {                                          // 0 a 100 (0 tambem quando esta mudo); null = sem player
    try {
      if (S.player && S.player.getVolume) return (S.player.isMuted && S.player.isMuted()) ? 0 : Math.round(S.player.getVolume());
    } catch (e) { /* o player ainda esta carregando */ }
    return null;
  }

  function syncVolumes() {
    var vol = videoVolume();
    var v = $('rpVidVol');
    if (document.activeElement !== v && vol !== null) v.value = String(vol);
    var m = $('mnVol');
    if (document.activeElement !== m && vol !== null) m.value = String(vol);
    m.disabled = vol === null;
    $('mnVolVal').textContent = vol === null ? '—' : vol + '%';
    $('mnMute').querySelector('use').setAttribute('href', vol === 0 ? '#i-volume-x' : '#i-volume');
    var vv = $('rpVoiceVol');
    if (Voice && document.activeElement !== vv) vv.value = Math.round(Voice.masterVolume() * 100);
  }

  function setVideoVolume(n) {
    var v = Math.max(0, Math.min(100, Math.round(n)));
    try {
      if (!S.player || !S.player.setVolume) return;
      if (v > 0) S.lastVol = v;
      S.player.setVolume(v);
      if (v > 0 && S.player.isMuted && S.player.isMuted()) S.player.unMute();
    } catch (e) { /* ignora */ }
    syncVolumes();
  }

  // botao de som: sem som (mudo ou volume 0) volta ao ultimo volume (ou 50); com som deixa mudo
  function toggleVideoMute() {
    if (!S.player || !S.current) return;
    try {
      var vol = S.player.getVolume();
      var muted = !!(S.player.isMuted && S.player.isMuted());
      if (muted || vol === 0) {
        if (vol === 0) S.player.setVolume(S.lastVol > 0 ? S.lastVol : 50);
        if (muted) S.player.unMute();
      } else {
        S.lastVol = vol;
        S.player.mute();
      }
    } catch (e) { /* ignora */ }
    syncVolumes();
  }

  // lista de quem esta na sala (nomes vem de outras pessoas: sempre como texto, nunca como HTML)
  function renderMembers(list) {
    if (S.dragVol) return;                                              // nao refaz a lista no meio de um arraste de volume
    var ul = $('rpMembers');
    var me = Room.myId();
    var sorted = list.slice().sort(function (a, b) { return (b.id === me ? 1 : 0) - (a.id === me ? 1 : 0); });
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    var inVoice = !!(Voice && Voice.isOn());
    sorted.forEach(function (m) {
      var mine = m.id === me;
      var key = mine ? 'me' : m.id;
      var voiceOn = mine ? inVoice : !!m.voice;
      var muted = mine ? !!(Voice && Voice.isMuted()) : !!m.muted;
      var li = el('li', 'rp-m' + (voiceOn ? '' : ' novoice'));
      li.setAttribute('data-mid', key);
      if (Voice && Voice.speaking(key)) li.classList.add('speaking');
      var av = el('span', 'av', (Array.from(m.name || '?')[0] || '?').toUpperCase());
      av.style.background = colorFor(m.id);
      li.appendChild(av);
      var nm = el('span', 'nm', m.name || 'Visitante');
      if (mine) nm.appendChild(el('i', null, '(você)'));
      li.appendChild(nm);

      var st = el('span', 'st');
      if (voiceOn) {
        var broken = !mine && inVoice && Voice.peerState(m.id) === 'falhou';
        st.classList.add(broken ? 'warn' : (muted ? 'off' : 'on'));
        st.title = broken ? 'Sem conexão de voz com ' + (m.name || 'esta pessoa') : (muted ? 'Microfone silenciado' : 'Na voz');
        st.appendChild(icon(muted ? 'i-mic-off' : 'i-mic'));
      }
      li.appendChild(st);

      if (!mine && voiceOn && inVoice) {                                // volume e silenciar essa pessoa (so para voce)
        var p = Voice.person(m.id);
        var pv = el('input', 'pv');
        pv.type = 'range'; pv.min = '0'; pv.max = '100'; pv.step = '1';
        pv.value = String(Math.round(p.vol * 100));
        pv.setAttribute('data-vid', m.id);
        pv.title = 'Volume de ' + (m.name || 'esta pessoa');
        pv.setAttribute('aria-label', pv.title);
        li.appendChild(pv);
        var pm = el('button', 'ib pm' + (p.mute ? ' on' : ''));
        pm.type = 'button';
        pm.setAttribute('data-vid', m.id);
        pm.title = (p.mute ? 'Deixar de silenciar ' : 'Silenciar ') + (m.name || 'esta pessoa') + ' (só para você)';
        pm.setAttribute('aria-label', pm.title);
        pm.appendChild(icon(p.mute ? 'i-volume-x' : 'i-volume'));
        li.appendChild(pm);
      }
      ul.appendChild(li);
    });
  }

  function renderVoice() {
    var inRoom = !!Room.code();
    var sup = !!(Voice && Voice.supported());
    var on = !!(Voice && Voice.isOn());
    var muted = on && Voice.isMuted();
    var bm = $('bMic');
    bm.hidden = !(inRoom && sup);
    bm.classList.toggle('mic-on', on && !muted);
    bm.classList.toggle('mic-muted', on && muted);
    bm.querySelector('use').setAttribute('href', on && muted ? '#i-mic-off' : '#i-mic');
    bm.title = !on ? 'Entrar na voz (liga o microfone)' : (muted ? 'Microfone silenciado: clique para ligar' : 'Microfone ligado: clique para silenciar');
    var rm = $('rpMic');
    rm.hidden = !sup;
    rm.classList.toggle('live', on && !muted);
    rm.classList.toggle('muted', on && muted);
    rm.querySelector('use').setAttribute('href', on && muted ? '#i-mic-off' : '#i-mic');
    $('rpMicText').textContent = !on ? 'Entrar na voz' : (muted ? 'Ligar microfone' : 'Silenciar microfone');
    $('rpVoiceOff').hidden = !on;
    var deaf = on && Voice.isDeaf();
    var rh = $('rpHear');                                            // o "fone": parar de ouvir as vozes da sala
    rh.hidden = !on;
    rh.classList.toggle('muted', deaf);
    rh.querySelector('use').setAttribute('href', deaf ? '#i-headphones-off' : '#i-headphones');
    $('rpHearText').textContent = deaf ? 'Voltar a ouvir' : 'Parar de ouvir';
    if (menuIsOpen()) renderMenu();
    fitBarIfNeeded();
    pushTb();
  }

  function openRoomPanel() {
    clearError();
    closeMenu(false);
    $('roomPanel').hidden = false;
    syncOverlay();
    $('rpName').value = Room.name();
    $('rpName2').value = Room.name();
    renderRoom();
    roomMsg('');
    syncVolumes();
    if (S.rpTab === 'queue') {
      renderQueue(true);
      if (ytAvailable()) toHost('yprep');                              // aquece a janela que acha o titulo dos links colados
    } else if (!Room.code()) setTimeout(function () { (Room.name() ? $('rpCode') : $('rpName')).focus(); }, 30);
  }

  function closeRoomPanel() { $('roomPanel').hidden = true; syncOverlay(); focusPlayer(); }

  // desenha o botao da barra e o painel conforme a sala e a aba (Sala | Fila); a fila vale em qualquer caso
  function renderRoom() {
    var code = Room.code();
    var on = !!code;
    var list = Room.members();
    var n = list.length || 1;
    var b = $('bRoom');
    b.classList.toggle('room-on', on);
    b.title = on
      ? 'Sala ' + code + ': ' + n + (n === 1 ? ' pessoa' : ' pessoas') + ' (clique para ver a sala e a fila)'
      : 'Sala e fila de vídeos';
    body.classList.toggle('in-room', on);
    if (on) {
      $('rpCodeShow').textContent = code;
      $('rpInfo').textContent = (Room.status() === 'reconectando' ? 'Reconectando… ' : '') +
        n + (n === 1 ? ' pessoa na sala' : ' pessoas na sala');
      renderMembers(list);
      syncVolumes();
    }
    renderRoomTab();
    renderQueue();
    renderVoice();
    sendToFrameRaw({ type: 'roomOn', on: on });
  }

  function copyText(t) {
    function done() { roomMsg('Código copiado.'); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* ignora */ }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, fallback);
    else fallback();
  }

  // para criar ou entrar a pessoa precisa de um nome (e ele fica guardado para a proxima vez)
  function ensureName() {
    var n = $('rpName').value.replace(/\s+/g, ' ').trim();
    if (!n) { roomMsg('Digite o seu nome para os outros saberem quem é você.'); $('rpName').focus(); return false; }
    Room.setName(n);
    $('rpName2').value = Room.name();
    return true;
  }

  // o estado da sala chegou: mesmo video -> manda o player ficar igual; outro video -> carrega o da sala
  Room.hooks.changed = renderRoom;
  Room.hooks.toast = function (m) { toast(m); };
  Room.hooks.applyRemote = function (r) {
    var same = S.current && S.current.id === (r.vid || null) && (S.current.list || null) === (r.list || null);
    if (same) { sendRoomToFrame(r); return; }
    var info = window.LMLink.parse(r.vid
      ? 'https://youtu.be/' + r.vid + (r.list ? '?list=' + r.list : '')
      : 'https://www.youtube.com/playlist?list=' + r.list);
    if (!info) return;
    info.start = Math.max(0, Math.floor(r.target));
    S.remoteLoad = true;                                             // veio da sala: nao devolve para a sala
    try { play(info, r.by === 'queue'); } finally { S.remoteLoad = false; }   // o proximo da fila nao tira ninguem da pesquisa
  };

  setInterval(function () {                                          // o relogio do servidor muda devagar
    if (Room.code()) sendToFrameRaw({ type: 'roomclock', offset: Room.offset() });
  }, 8000);

  // voz: microfone (barra e painel), volume de cada pessoa, volume das vozes e do video
  function micClick() {
    if (!Voice) return;
    if (!Voice.isOn()) {
      roomMsg('Entrando na voz…');
      Voice.start().then(function (r) {
        roomMsg(!r.ok ? 'Não foi possível entrar na voz.' : (r.micError ? micErrorText(r.micError) : ''));
        if (r.micError && $('roomPanel').hidden) toast('Você entrou na voz só ouvindo');
        renderRoom();
      });
    } else {
      Voice.toggleMute().then(function () {
        var e = Voice.micError();
        roomMsg(e ? micErrorText(e) : '');
        renderRoom();
      });
    }
  }
  $('bMic').addEventListener('click', function () { micClick(); focusPlayer(); });
  $('rpMic').addEventListener('click', micClick);
  $('rpVoiceOff').addEventListener('click', function () { if (Voice) Voice.stop(); roomMsg(''); renderRoom(); });
  $('rpHear').addEventListener('click', toggleHear);
  $('rpVidVol').addEventListener('input', function () { setVideoVolume(+$('rpVidVol').value || 0); });
  $('rpVoiceVol').addEventListener('input', function () { if (Voice) Voice.masterVolume((+$('rpVoiceVol').value || 0) / 100); });
  $('rpMembers').addEventListener('input', function (e) {
    var t = e.target;
    if (Voice && t.classList && t.classList.contains('pv')) Voice.setPersonVolume(t.getAttribute('data-vid'), (+t.value || 0) / 100);
  });
  $('rpMembers').addEventListener('pointerdown', function (e) { if (e.target.classList && e.target.classList.contains('pv')) S.dragVol = true; });
  window.addEventListener('pointerup', function () { if (S.dragVol) { S.dragVol = false; renderRoom(); } });
  $('rpMembers').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.pm') : null;
    if (!b || !Voice) return;
    var id = b.getAttribute('data-vid');
    Voice.setPersonMute(id, !Voice.person(id).mute);
    renderRoom();
  });
  if (Voice) {
    Voice.hooks.changed = renderRoom;
    Voice.hooks.speaking = function (id, on) {                       // acende o aro de quem esta falando, sem refazer a lista
      var li = document.querySelector('.rp-m[data-mid="' + id + '"]');
      if (li) li.classList.toggle('speaking', on);
      if (id === 'me') $('bMic').classList.toggle('speaking', on);
    };
  }

  /* ---------- fila de videos: a da sala (todos veem) quando se esta numa sala, senao a SUA (neste computador) ---------- */

  function queueTabOpen() { return !$('roomPanel').hidden && S.rpTab === 'queue'; }

  // o que cada aba mostra: Sala = criar/entrar (fora da sala) ou os detalhes da sala; Fila = a fila que vale agora
  function renderRoomTab() {
    var q = S.rpTab === 'queue';
    var on = !!Room.code();
    $('roomPanel').classList.toggle('q-on', q);
    $('rpOut').hidden = q || on;
    $('rpIn').hidden = q || !on;
    $('rpPaneRoom').hidden = q;
    $('rpPaneQueue').hidden = !q;
    $('rpTabRoom').classList.toggle('on', !q);
    $('rpTabRoom').setAttribute('aria-selected', q ? 'false' : 'true');
    $('rpTabQueue').classList.toggle('on', q);
    $('rpTabQueue').setAttribute('aria-selected', q ? 'true' : 'false');
  }

  function setRoomTab(t) {
    S.rpTab = t === 'queue' ? 'queue' : 'room';
    roomMsg('');
    renderRoomTab();
    if (S.rpTab === 'queue') {
      renderQueue(true);
      if (ytAvailable()) toHost('yprep');                              // aquece a janela que acha o titulo dos links colados
      setTimeout(function () { if (queueTabOpen() && !S.qDrag) $('rpQInput').focus(); }, 30);
    }
    else renderRoom();
  }

  // ---- as operacoes valem para a fila de agora (sala: pelo servidor; fora da sala: guardada neste computador) ----

  function qItems() { return Room.code() ? Room.queue() : window.LMQueue.items(); }

  function qIsLocal() { return !Room.code(); }

  // toca um item tirado da SUA fila (se estava pesquisando, o video toca por tras sem tirar a pessoa da pesquisa)
  function playQueued(it, announce) {
    var info = window.LMLink.parse('https://youtu.be/' + it.vid);
    if (!info) return false;
    play(info, S.mode !== 'player');
    S.fromQueue = it.vid;                                            // (depois do play: ele zera isto para o que a pessoa escolhe)
    if (announce) toast('Próximo da fila: ' + qTitle(it));
    return true;
  }

  // o video acabou (ou nao tocou) e ha item na SUA fila: toca o primeiro (devolve o item, ou null se a fila estava vazia)
  function localAdvance(announce) {
    var it = window.LMQueue.shift();
    if (!it) { S.qIdle = true; return null; }
    return playQueued(it, announce) ? it : null;
  }

  // false = nao deu (fila cheia, sala reconectando); os avisos ao usuario saem daqui ou do servidor (na sala)
  function qAdd(vid, title) {
    if (!qIsLocal()) return Room.qAdd(vid, title);
    if (window.LMQueue.isFull()) { toast('A fila está cheia (' + window.LMQueue.MAX + ' vídeos)'); return false; }
    if (!window.LMQueue.add(vid, title)) return false;
    if (S.qIdle) {                                                     // com o player parado, o que entra ja comeca a tocar
      var first = localAdvance(false);
      if (first) { toast('Tocando agora: ' + qTitle(first)); return true; }
    }
    toast('Adicionado à sua fila (' + window.LMQueue.count() + ')');
    return true;
  }

  function qMove(id, to) { if (qIsLocal()) window.LMQueue.move(id, to); else Room.qMove(id, to); }
  function qRemove(id) { if (qIsLocal()) window.LMQueue.remove(id); else Room.qRemove(id); }
  function qClear() { if (qIsLocal()) window.LMQueue.clear(); else Room.qClear(); }
  function qPlay(id) {
    if (!qIsLocal()) { Room.qPlay(id); return; }
    var it = window.LMQueue.take(id);
    if (it) playQueued(it, false);
  }

  function qTitle(it) { return it.title || ('youtu.be/' + it.vid); }

  function qRow(it) {
    var li = el('li', 'qi');
    li.setAttribute('data-qid', it.id);
    var grip = el('button', 'qgrip');
    grip.type = 'button';
    grip.title = 'Arraste para mudar a ordem (ou use as setas ↑ ↓)';
    grip.setAttribute('aria-label', 'Mudar a ordem: ' + qTitle(it));
    grip.appendChild(icon('i-grip'));
    li.appendChild(grip);
    var img = document.createElement('img');
    img.className = 'qth';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.src = 'https://i.ytimg.com/vi/' + it.vid + '/mqdefault.jpg';
    li.appendChild(img);
    var tx = el('span', 'qtx');
    tx.appendChild(el('span', 'qtt', qTitle(it)));
    if (it.by) tx.appendChild(el('span', 'qby', 'por ' + it.by));
    li.appendChild(tx);
    var pl = el('button', 'ib qplay');
    pl.type = 'button';
    pl.title = qIsLocal() ? 'Tocar agora' : 'Tocar agora (para todos na sala)';
    pl.setAttribute('aria-label', 'Tocar agora: ' + qTitle(it));
    pl.appendChild(icon('i-play'));
    li.appendChild(pl);
    var rm = el('button', 'ib qrm');
    rm.type = 'button';
    rm.title = 'Tirar da fila';
    rm.setAttribute('aria-label', 'Tirar da fila: ' + qTitle(it));
    rm.appendChild(icon('i-x'));
    li.appendChild(rm);
    return li;
  }

  // desenha a fila de agora (titulos vem de outras pessoas: sempre como texto, nunca como HTML)
  function renderQueue(force) {
    if (S.qDrag) { S.qDirty = true; return; }
    var local = qIsLocal();
    var q = qItems();
    var n = q.length;
    var sig = (local ? 'L' : 'R') + JSON.stringify(q);
    var b = $('rpQCount');
    b.hidden = !n;
    b.textContent = String(n);
    var pb = $('bRoomQ');                                              // numero de videos na fila, no botao da barra
    pb.hidden = !n;
    pb.textContent = n > 9 ? '9+' : String(n);
    if (menuIsOpen()) renderMenu();
    pushTb();
    if (!force && sig === S.qSig) return;
    S.qSig = sig;
    $('rpQWho').textContent = local ? 'Sua fila · só neste computador' : 'Fila da sala · todos veem a mesma';
    $('rpQWho').title = local ? 'Fica guardada aqui, mesmo se você fechar o programa. Quando você entra numa sala, aparece a fila da sala.' : 'Qualquer pessoa da sala adiciona, muda a ordem ou tira. Quando você sai da sala, volta a sua fila.';
    var ul = $('rpQList');
    var focusId = S.qFocus;
    S.qFocus = null;
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    q.forEach(function (it) { ul.appendChild(qRow(it)); });
    $('rpQEmpty').hidden = n > 0;
    $('rpQHint').hidden = n < 2;
    $('rpQClear').parentNode.hidden = n === 0;
    if (focusId) {
      var rows = ul.children;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-qid') === focusId) { var g = rows[i].querySelector('.qgrip'); if (g) g.focus(); break; }
      }
    }
  }

  // colar/escrever um link de video: titulo pelo YouTube (ate 2,5 s) e vai para o fim da fila
  function addLinkToQueue(text) {
    var info = window.LMLink.parse(text);
    if (!info) { roomMsg('Isso não parece um link de vídeo do YouTube.'); return false; }
    if (!info.id) { roomMsg('A fila aceita vídeos, não listas. Cole o link de um vídeo.'); return false; }
    roomMsg('');
    var done = false;
    function go(title) {
      if (done) return;
      done = true;
      if (!qAdd(info.id, title || '') && !qIsLocal()) roomMsg('A sala está reconectando… tente de novo.');
    }
    var timer = setTimeout(function () { go(''); }, 2500);
    if (ytAvailable()) {
      window.LMYt.info(info.id).then(function (r) { clearTimeout(timer); go(r.title); }, function () { clearTimeout(timer); go(''); });
    } else { clearTimeout(timer); go(''); }
    return true;
  }

  Room.hooks.queue = function (ev) {
    renderQueue();
    if (!ev) return;
    var mine = ev.by === Room.myId();
    var t = ev.title || 'um vídeo';
    if (ev.k === 'add') toast(mine ? 'Adicionado à fila' : (ev.n || 'Alguém') + ' adicionou à fila: ' + t);
    else if (ev.k === 'play' && !mine) toast((ev.n || 'Alguém') + ' tocou: ' + t);
    else if (ev.k === 'next') toast('Próximo da fila: ' + t);
  };

  window.LMQueue.onChange(function () { if (qIsLocal()) renderQueue(); });      // a SUA fila mudou (aqui ou em outra janela do programa)

  $('rpTabRoom').addEventListener('click', function () { setRoomTab('room'); });
  $('rpTabQueue').addEventListener('click', function () { setRoomTab('queue'); });
  $('rpQForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('rpQInput').value;
    if (!v.trim()) return;
    if (addLinkToQueue(v)) $('rpQInput').value = '';
  });
  $('rpQInput').addEventListener('paste', function () {              // colou um link: entra na fila na hora (como no campo da tela de link)
    setTimeout(function () { var v = $('rpQInput').value; if (v.trim() && window.LMLink.parse(v) && addLinkToQueue(v)) $('rpQInput').value = ''; }, 0);
  });
  $('rpQClear').addEventListener('click', function () { qClear(); });
  $('rpQList').addEventListener('click', function (e) {
    var li = e.target.closest ? e.target.closest('.qi') : null;
    if (!li) return;
    var id = li.getAttribute('data-qid');
    if (e.target.closest('.qplay')) qPlay(id);
    else if (e.target.closest('.qrm')) qRemove(id);
  });
  $('rpQList').addEventListener('keydown', function (e) {             // alternativa ao mouse: seta para cima/baixo no cabo da linha
    var g = e.target.closest ? e.target.closest('.qgrip') : null;
    if (!g || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    var id = g.closest('.qi').getAttribute('data-qid');
    var q = qItems();
    var i = -1;
    for (var k = 0; k < q.length; k++) if (q[k].id === id) i = k;
    var to = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (i < 0 || to < 0 || to >= q.length) return;
    e.preventDefault();
    S.qFocus = id;
    qMove(id, to);
  });

  // arrastar para reordenar (mouse ou toque): a linha acompanha o ponteiro, as outras abrem espaco, e ao soltar o servidor confirma
  var qd = null;

  function qDragMove() {
    var ul = qd.ul, li = qd.li;
    var rect = ul.getBoundingClientRect();
    var top = (qd.y - rect.top + ul.scrollTop) - qd.grab;
    li.style.transform = 'translateY(' + (top - li.offsetTop) + 'px)';
    var center = top + li.offsetHeight / 2;
    var to = 0;
    qd.rows.forEach(function (r) { if (r !== li && r.offsetTop + r.offsetHeight / 2 < center) to++; });
    qd.to = to;
    qd.rows.forEach(function (r, idx) {
      if (r === li) return;
      var shift = 0;
      if (qd.from < to && idx > qd.from && idx <= to) shift = -qd.step;
      else if (qd.from > to && idx >= to && idx < qd.from) shift = qd.step;
      r.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
  }

  function qEdgeScroll() {                                            // perto da borda de cima/baixo a lista rola sozinha
    clearInterval(qd.timer);
    var rect = qd.ul.getBoundingClientRect();
    var dir = qd.y < rect.top + 26 ? -1 : (qd.y > rect.bottom - 26 ? 1 : 0);
    if (!dir) return;
    qd.timer = setInterval(function () {
      if (!qd) return;
      var before = qd.ul.scrollTop;
      qd.ul.scrollTop += dir * 8;
      if (qd.ul.scrollTop !== before) qDragMove();
    }, 30);
  }

  function qDragEnd(e, cancel) {
    if (!qd || (e && e.pointerId !== qd.pid)) return;
    clearInterval(qd.timer);
    var d = qd;
    qd = null;
    S.qDrag = null;
    d.li.classList.remove('dragging');
    d.ul.classList.remove('sorting');
    d.rows.forEach(function (r) { r.style.transform = ''; });
    if (!cancel && d.to !== d.from) {
      var after = d.rows.filter(function (r) { return r !== d.li; })[d.to];
      d.ul.insertBefore(d.li, after || null);                         // ja mostra a ordem nova (na sala o servidor confirma logo em seguida)
      qMove(d.id, d.to);
    }
    if (S.qDirty) { S.qDirty = false; renderQueue(true); }
  }

  $('rpQList').addEventListener('pointerdown', function (e) {
    var grip = e.target.closest ? e.target.closest('.qgrip') : null;
    if (!grip || e.button !== 0) return;
    var ul = $('rpQList');
    var li = grip.closest('.qi');
    var rows = [].slice.call(ul.children);
    var from = rows.indexOf(li);
    if (from < 0 || rows.length < 2) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignora */ }
    var rect = ul.getBoundingClientRect();
    qd = {
      li: li, ul: ul, rows: rows, id: li.getAttribute('data-qid'), from: from, to: from, pid: e.pointerId, y: e.clientY, timer: 0,
      grab: (e.clientY - rect.top + ul.scrollTop) - li.offsetTop,
      step: rows[1].offsetTop - rows[0].offsetTop                      // altura de uma linha + o espaco entre elas
    };
    S.qDrag = qd;
    li.classList.add('dragging');
    ul.classList.add('sorting');
  });
  $('rpQList').addEventListener('pointermove', function (e) {
    if (!qd || e.pointerId !== qd.pid) return;
    qd.y = e.clientY;
    qDragMove();
    qEdgeScroll();
  });
  $('rpQList').addEventListener('pointerup', function (e) { qDragEnd(e, false); });
  $('rpQList').addEventListener('pointercancel', function (e) { qDragEnd(e, true); });
  $('rpQList').addEventListener('lostpointercapture', function (e) { qDragEnd(e, true); });

  $('roomHome').addEventListener('click', openRoomPanel);
  $('rpClose').addEventListener('click', closeRoomPanel);
  $('rpCreate').addEventListener('click', function () {
    if (!ensureName()) return;
    roomMsg('Criando a sala…');
    Room.create(currentRoomState()).then(function () {
      roomMsg('Sala criada. Passe o código para as outras pessoas.');
      renderRoom();
    }, function (err) { roomMsg(roomError(err)); });
  });
  $('rpJoinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!ensureName()) return;
    roomMsg('Entrando…');
    Room.join($('rpCode').value).then(function () {
      roomMsg('');
      renderRoom();
      toast('Você entrou na sala ' + Room.code());
      closeRoomPanel();
    }, function (err) { roomMsg(roomError(err)); });
  });
  $('rpLeave').addEventListener('click', function () { Room.leave(); renderRoom(); roomMsg('Você saiu da sala.'); });
  $('rpCopy').addEventListener('click', function () { copyText(Room.code()); });
  ['rpCode', 'rpName', 'rpName2', 'rpQInput'].forEach(function (id) {
    $(id).addEventListener('focus', function () { S.typing = true; toHost('typing:1'); refreshUi(); });
    $(id).addEventListener('blur', function () { S.typing = false; toHost('typing:0'); refreshUi(); });
  });
  $('rpName').addEventListener('change', function () { Room.setName($('rpName').value); });
  $('rpName2').addEventListener('change', function () {
    var n = $('rpName2').value.replace(/\s+/g, ' ').trim();
    if (!n) { $('rpName2').value = Room.name(); return; }
    Room.setName(n);
    $('rpName').value = Room.name();
  });
  $('rpName2').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('rpName2').blur(); });

  /* ---------- atualizacao automatica ---------- */

  // o programa avisa que ha versao nova (ja baixada = "ready"; sem como instalar sozinho = "manual")
  var Upd = { kind: '', ver: '', hidden: false };

  function renderUpdate() {
    var show = !!Upd.kind && !Upd.hidden;
    $('upd').hidden = !show;
    if (!show) return;
    $('updVer').textContent = Upd.ver;
    var b = $('updGo');
    b.disabled = Upd.kind === 'busy';
    b.textContent = Upd.kind === 'busy' ? 'Atualizando…' : (Upd.kind === 'manual' ? 'Baixar' : 'Atualizar');
  }

  function onUpdate(arg) {
    var p = arg.split(':');
    if (p[0] === 'ready' || p[0] === 'manual') {
      if (Upd.ver !== (p[1] || '')) Upd.hidden = false;          // outra versao: avisa de novo
      Upd.kind = p[0];
      Upd.ver = p[1] || '';
    } else if (p[0] === 'busy') {
      Upd.kind = 'busy';
      Upd.hidden = false;
    } else if (p[0] === 'fail') {
      Upd.kind = 'manual';                                         // sobra baixar no site
      Upd.hidden = false;
      toast('Não foi possível atualizar agora. Você pode baixar a versão nova no site.');
    }
    renderUpdate();
  }

  // link do que esta tocando (com o minuto): a janela nova volta ao mesmo video
  function resumeLink() {
    var c = S.current;
    if (!c || (!c.id && !c.list)) return '';
    var t = 0;
    try { t = Math.floor((S.player && S.player.getCurrentTime && S.player.getCurrentTime()) || 0); } catch (e) { /* ignora */ }
    if (c.id) return 'https://youtu.be/' + c.id + '?t=' + t + (c.list ? '&list=' + c.list : '');
    return 'https://www.youtube.com/playlist?list=' + c.list;
  }

  $('updGo').addEventListener('click', function () {
    if (Upd.kind === 'manual') toHost('updweb');
    else if (Upd.kind === 'ready') toHost('update:' + resumeLink());
  });
  $('updX').addEventListener('click', function () { Upd.hidden = true; renderUpdate(); focusPlayer(); });

  /* ---------- tela de link ---------- */

  function openHome() {
    clearError();
    body.classList.add('home');
    refreshUi();
    setTimeout(function () { var u = $('url'); u.focus(); u.select(); }, 20);
  }

  function closeHome() {
    if (!S.current) return;               // sem video nao ha para onde voltar
    body.classList.remove('home');
    $('url').blur();
    refreshUi();
  }

  /* ---------- modulos: busca do YouTube e Spotify ---------- */

  // mostra o modo certo (a janela do site fica por conta do programa, por baixo da barra)
  function setMode(name) {
    if (name !== 'youtube' && name !== 'spotify') name = 'player';
    if (name !== S.mode) closeMenu(false);                          // trocou de tela (pelo teclado, por exemplo): o menu aberto nao fica para tras
    S.mode = name;
    body.classList.toggle('browse', name !== 'player');
    body.classList.toggle('mod-youtube', name === 'youtube');
    body.classList.toggle('mod-spotify', name === 'spotify');
    body.classList.toggle('yt-results', name === 'youtube' && S.ytView === 'results');
    $('tabYoutube').classList.toggle('on', name === 'youtube');
    $('tabSpotify').classList.toggle('on', name === 'spotify');
    if (name !== 'player') { body.classList.remove('home'); clearError(); }
    if (name !== 'spotify') $('modTitle').textContent = '';
    refreshUi();
  }

  function openModule(name) {
    if (S.mode === name) return;
    if (name === 'youtube') {
      if (S.ytq && window.LMYt && window.LMYt.available()) { showYtResults(); return; }    // volta a lista da ultima pesquisa
      S.ytView = 'site';                                                                // sem pesquisa: o site do YouTube
    }
    setMode(name);
    toHost('mod:' + name);
  }

  // ---------- resultados da pesquisa do YouTube (lista do programa) ----------

  function ytAvailable() { return !!(window.LMYt && window.LMYt.available()); }

  function showYtResults() {
    S.ytView = 'results';
    setMode('youtube');
    toHost('modhide');                                    // esconde a janela dos sites (se estava aberta)
    renderResults();
  }

  function searchYoutube(q) {
    if (!ytAvailable()) { S.ytView = 'site'; setMode('youtube'); toHost('search:' + q); return; }   // sem o programa: o site mesmo
    S.ytq = q;
    S.ytItems = [];
    S.ytMore = null;
    S.ytErr = '';
    S.ytBusy = false;
    S.ytGen++;
    var ul = $('resList');
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    $('results').scrollTop = 0;
    showYtResults();
    loadResults(false);
  }

  function ytErrorText(err) {
    var m = err && err.message;
    if (m === 'tempo' || m === 'rede') return 'Sem resposta do YouTube. Confira a internet e tente de novo.';
    if (m === 'formato') return 'Não consegui ler os resultados do YouTube agora (o formato da página veio diferente).' + (err.info ? ' [' + err.info + ']' : '');
    return 'Não consegui pesquisar agora.' + (m ? ' [' + m + ']' : '');
  }

  function loadResults(more) {
    if (S.ytBusy || (more && !S.ytMore)) return;
    var gen = S.ytGen;
    S.ytBusy = true;
    S.ytErr = '';
    renderResults();
    (more ? window.LMYt.more(S.ytMore) : window.LMYt.search(S.ytq)).then(function (r) {
      if (gen !== S.ytGen) return;
      S.ytBusy = false;
      var seen = {};
      S.ytItems.forEach(function (i) { seen[i.id] = 1; });
      (r.items || []).forEach(function (i) { if (!seen[i.id]) S.ytItems.push(i); });
      S.ytMore = r.more || null;
      renderResults();
      setTimeout(fillResults, 0);
    }, function (err) {
      if (gen !== S.ytGen) return;
      S.ytBusy = false;
      S.ytErr = ytErrorText(err);
      renderResults();
    });
  }

  // a lista ainda nao enche a janela (janela alta) e ha mais: busca a proxima pagina
  function fillResults() {
    var r = $('results');
    if (S.mode !== 'youtube' || S.ytView !== 'results' || S.ytBusy || !S.ytMore) return;
    if (r.scrollHeight <= r.clientHeight + 40) loadResults(true);
  }

  function resRow(it) {
    var li = el('li', 'res');
    li.setAttribute('data-vid', it.id);
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.title = it.title;
    var th = el('span', 'rth');
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = 'https://i.ytimg.com/vi/' + it.id + '/mqdefault.jpg';
    th.appendChild(img);
    if (it.live) th.appendChild(el('span', 'rdur live', 'AO VIVO'));
    else if (it.dur) th.appendChild(el('span', 'rdur', it.dur));
    li.appendChild(th);
    var tx = el('span', 'rtx');
    tx.appendChild(el('span', 'rtt', it.title));
    if (it.channel) tx.appendChild(el('span', 'rch', it.channel));
    var meta = [it.views, it.pub].filter(Boolean).join(' · ');
    if (meta) tx.appendChild(el('span', 'rmeta', meta));
    li.appendChild(tx);
    var q = el('button', 'ib rq');
    q.type = 'button';
    q.title = 'Adicionar à fila da sala';
    q.setAttribute('aria-label', 'Adicionar à fila da sala: ' + it.title);
    q.appendChild(icon('i-plus'));
    li.appendChild(q);
    return li;
  }

  function renderResults() {
    var ul = $('resList');
    if (ul.children.length > S.ytItems.length) { while (ul.firstChild) ul.removeChild(ul.firstChild); }
    for (var i = ul.children.length; i < S.ytItems.length; i++) ul.appendChild(resRow(S.ytItems[i]));     // so acrescenta: nao perde a rolagem
    var text = '';
    if (S.ytBusy) text = S.ytItems.length ? 'Carregando mais…' : 'Pesquisando…';
    else if (S.ytErr) text = S.ytErr;
    else if (!S.ytItems.length && S.ytq) text = 'Nada encontrado para “' + S.ytq + '”.';
    $('resMsg').textContent = text;
    $('resActions').hidden = !(S.ytErr && !S.ytBusy);
    $('resSite2').hidden = !(S.ytItems.length && !S.ytBusy && !S.ytErr);
  }

  function resItem(id) {
    for (var i = 0; i < S.ytItems.length; i++) if (S.ytItems[i].id === id) return S.ytItems[i];
    return null;
  }

  function playResult(it) {
    var info = window.LMLink.parse('https://www.youtube.com/watch?v=' + it.id);
    if (info) play(info);
  }

  // o + de um resultado: vai para a fila de agora (na sala, a da sala; fora dela, a SUA)
  function queueResult(it, li) {
    if (Room.code() && Room.status() !== 'ok') { toast('A sala está reconectando… tente de novo'); return; }
    if (!qAdd(it.id, it.title)) return;
    if (qIsLocal()) S.rpTab = 'queue';                               // da proxima vez o painel abre na fila
    if (li) { li.classList.add('queued'); setTimeout(function () { li.classList.remove('queued'); }, 1400); }
  }

  function backToPlayer() {
    if (S.mode === 'player') return;
    setMode('player');
    toHost('mod:player');
    if (S.current) setTimeout(focusPlayer, 60);
  }

  // Ctrl+L: no player abre a tela de pesquisa/link; no modo navegacao vai para o campo de busca
  function openOmnibox() {
    if (S.mode === 'player') { openHome(); return; }
    if (S.mode !== 'youtube') openModule('youtube');
    setTimeout(function () { var u = $('searchInput'); u.focus(); u.select(); }, 20);
  }

  // o que foi digitado: link do YouTube toca; qualquer outro texto vira pesquisa no YouTube
  function submitOmni(text) {
    var info = window.LMLink.parse(text);
    if (info) { play(info); return true; }
    text = (text || '').trim();
    if (!text) { toast('Digite um link ou o que quer pesquisar'); return false; }
    $('searchInput').value = text;
    searchYoutube(text);
    return true;
  }

  function handleText(text) {
    var info = window.LMLink.parse(text);
    if (!info) {
      toast('Isso não parece um link do YouTube');
      return false;
    }
    play(info);
    return true;
  }

  function pasteFromClipboard() {
    if (HAS_HOST) { toHost('paste'); return; }
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(handleText, function () { toast('Sem acesso à área de transferência'); });
    }
  }

  /* ---------- player do YouTube ---------- */

  // stay: o video do proximo da fila toca por tras sem tirar a pessoa da pesquisa (o audio continua)
  function play(info, stay) {
    if (S.current && !S.histNav && histKey(S.current) !== histKey(info)) pushHist(S.current);   // o que tocava vira o "anterior"
    S.current = info;
    S.qIdle = false;                                                 // tem video tocando: a fila so comeca sozinha quando ele acabar
    S.fromQueue = null;                                              // (playQueued marca de novo logo depois, se foi a fila que escolheu)
    if (!S.remoteLoad && Room.code()) Room.publishLoad(info);        // numa sala, trocar de video troca para todos
    clearError();
    if (S.mode !== 'player' && !stay) { setMode('player'); toHost('mod:player'); }   // tocou um link: sai da busca
    $('url').value = '';
    $('goText').textContent = 'Reproduzir';
    body.classList.remove('empty', 'home');
    body.classList.add('playing');
    setTitle('Carregando…');
    refreshUi();
    pushTb();

    if (window.YT && window.YT.Player) S.apiReady = true;
    if (!S.apiReady) { S.pending = info; requestApi(); return; }
    createPlayer(info);
  }

  function requestApi() {
    if (S.apiRequested) return;
    S.apiRequested = true;
    window.onYouTubeIframeAPIReady = function () {
      S.apiReady = true;
      if (S.pending) { var p = S.pending; S.pending = null; createPlayer(p); }
    };
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = function () { S.apiRequested = false; showError('net'); };
    document.head.appendChild(s);
  }

  function destroyPlayer() {
    try { if (S.player && S.player.destroy) S.player.destroy(); } catch (e) { /* ignora */ }
    S.player = null;
    var st = $('stage');
    while (st.firstChild) st.removeChild(st.firstChild);
  }

  function createPlayer(info) {
    destroyPlayer();
    var holder = document.createElement('div');
    holder.id = 'yt';
    $('stage').appendChild(holder);

    var vars = { autoplay: 1, playsinline: 1, rel: 0, enablejsapi: 1 };
    if (/^https?:$/.test(location.protocol)) vars.origin = location.origin;
    if (info.start) vars.start = info.start;
    if (info.list) {
      vars.listType = 'playlist';
      vars.list = info.list;
      if (!info.id && info.index > 1) vars.index = info.index - 1;
    }

    var opts = {
      width: '100%',
      height: '100%',
      playerVars: vars,
      events: { onReady: onPlayerReady, onStateChange: onPlayerState, onError: onPlayerError }
    };
    if (info.id) opts.videoId = info.id;
    S.player = new window.YT.Player('yt', opts);
  }

  function onPlayerReady(e) {
    try {
      if (TEST_MUTE || S.muteOnReady) e.target.mute();
      e.target.playVideo();
    } catch (err) { /* ignora */ }
    updateTitleFromPlayer();
    focusPlayer();
    sendToFrame('hello');
    if (Room.code()) {                                                // video novo numa sala: poe igual ao da sala
      sendToFrameRaw({ type: 'roomOn', on: true });
      var rs = Room.state();
      if (rs) sendRoomToFrame(rs);
    }
  }

  function onPlayerState(e) {
    // 0 = acabou, 1 = tocando, 3 = carregando, 5 = pronto
    if (e && e.data === 0) onVideoEnded();
    if (e && (e.data === 1 || e.data === 3 || e.data === 5)) updateTitleFromPlayer();
    pushTb();                                                        // o botao play/pause da miniatura acompanha o player
  }

  // o video acabou: passa para o proximo da fila. Na sala varias pessoas pedem ao mesmo tempo e so a primeira vale;
  // fora dela e a SUA fila, neste computador.
  function onVideoEnded() {
    if (!S.current || S.current.list) return;                       // lista do YouTube passa sozinha de um video para o outro
    if (Room.code()) { Room.qNext(); return; }
    localAdvance(true);                                              // (fila vazia: o player fica parado e o proximo que entrar comeca a tocar)
  }

  function updateTitleFromPlayer() {
    try {
      var d = S.player && S.player.getVideoData && S.player.getVideoData();
      if (d && d.title) setTitle(d.title);
    } catch (err) { /* ignora */ }
  }

  function onPlayerError(e) {
    var code = e && e.data;
    var kind = 'other';
    if (code === 101 || code === 150) kind = 'embed';
    else if (code === 100) kind = 'gone';
    else if (code === 2) kind = 'badlink';
    else if (code === 5) kind = 'html5';
    else if (code === 152 || code === 153) kind = 'refused';
    // um video da SUA fila que nao pode tocar aqui (bloqueado, removido): passa para o proximo em vez de parar a fila
    if ((kind === 'embed' || kind === 'gone' || kind === 'badlink') && !Room.code() && S.current && S.fromQueue && S.current.id === S.fromQueue && window.LMQueue.count() > 0) {
      var bad = S.fromQueue;
      var next = localAdvance(false);
      if (next) { toast('Esse vídeo não toca aqui, passei para o próximo: ' + qTitle(next)); return; }
      S.fromQueue = bad;
    }
    showError(kind, code);
  }

  /* ---------- erros ---------- */

  var ERRORS = {
    embed:   { t: 'Este vídeo não pode ser exibido aqui', d: 'O dono bloqueou a reprodução fora do YouTube, ou o vídeo não existe mais.', retry: false },
    gone:    { t: 'Vídeo não encontrado', d: 'Ele pode ter sido removido, estar privado ou o link está incompleto.', retry: false },
    badlink: { t: 'Link inválido', d: 'O YouTube não reconheceu este endereço.', retry: false },
    html5:   { t: 'Erro no player do YouTube', d: 'Isso costuma passar. Tente de novo em alguns segundos.', retry: true },
    refused: { t: 'O YouTube recusou a exibição', d: 'Pode ser temporário ou uma restrição deste vídeo.', retry: true },
    net:     { t: 'Sem conexão com o YouTube', d: 'Confira a internet e tente de novo.', retry: true },
    other:   { t: 'Não foi possível reproduzir', d: 'Tente de novo ou abra o vídeo no YouTube.', retry: true }
  };

  function showError(kind, code) {
    var e = ERRORS[kind] || ERRORS.other;
    setTitle('');                                    // tira o "Carregando..." da barra
    $('errTitle').textContent = e.t;
    $('errText').textContent = e.d + (code ? ' (erro ' + code + ')' : '');
    $('errRetry').style.display = e.retry && S.current ? '' : 'none';
    $('errOpen').style.display = S.current ? '' : 'none';
    body.classList.add('err');
    refreshUi();
    pushTb();
  }

  function clearError() {
    body.classList.remove('err');
    refreshUi();
  }

  /* ---------- eventos ---------- */

  // arrastar a janela pela barra (ou por um espaco vazio das telas de link e erro)
  function startDragOnBackground(e) {
    if (e.button !== 0) return;
    if (e.target.closest('input, button, a, textarea, select')) return;
    e.preventDefault();
    toHost('drag');
  }
  $('bar').addEventListener('mousedown', startDragOnBackground);   // a barra toda arrasta, menos os botoes
  $('home').addEventListener('mousedown', startDragOnBackground);
  $('err').addEventListener('mousedown', startDragOnBackground);

  // redimensionar pelas bordas e cantos
  Array.prototype.forEach.call(document.querySelectorAll('.rz'), function (el) {
    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      toHost('size:' + el.getAttribute('data-d'));
    });
  });

  // a barra fica visivel enquanto o mouse esta em cima dela
  $('bar').addEventListener('mouseenter', function () { S.barHover = true; refreshUi(); });
  $('bar').addEventListener('mouseleave', function () { S.barHover = false; refreshUi(); });

  // botoes da barra
  $('bMin').addEventListener('click', function () { toHost('min'); });
  $('bClose').addEventListener('click', function () { toHost('close'); });
  $('bLink').addEventListener('click', openHome);
  $('bRoom').addEventListener('click', openRoomPanel);
  $('bPin').addEventListener('click', function () {
    S.pin = !S.pin;
    renderPin();
    toHost('pin:' + (S.pin ? 1 : 0));
    toast(S.pin ? 'Sempre por cima: ligado' : 'Sempre por cima: desligado');
    focusPlayer();
  });
  // menu ≡ (na barra do video e na barra do modo navegacao)
  function toggleMenu() { if (menuIsOpen()) closeMenu(true); else openMenu(); }
  $('bMenu').addEventListener('click', toggleMenu);
  $('mMenu').addEventListener('click', toggleMenu);
  // transparencia: a janela mostra o efeito enquanto a barra e arrastada (de 10 a 100%)
  $('mnOp').addEventListener('pointerdown', function () { if (!S.opDrag) { S.opDrag = true; toHost('opdrag:1'); } });
  $('mnOp').addEventListener('input', function () {
    var v = Math.max(10, Math.min(100, +$('mnOp').value || 100));
    S.opacity = v / 100;
    renderOpacity();
    toHost('op:' + S.opacity.toFixed(2));
  });
  window.addEventListener('pointerup', endOpDrag);
  window.addEventListener('pointercancel', endOpDrag);
  // volume do video no menu: barra, botao de som e a rodinha do mouse (de 5 em 5)
  $('mnVol').addEventListener('input', function () { setVideoVolume(+$('mnVol').value || 0); });
  $('mnMute').addEventListener('click', toggleVideoMute);
  $('mnVol').addEventListener('wheel', function (e) {                 // (so sobre a barra: no resto o menu rola normalmente)
    var cur = videoVolume();
    if (cur === null) return;
    e.preventDefault();
    setVideoVolume(Math.round(cur / 5) * 5 + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false });
  setInterval(function () { if (menuIsOpen()) syncVolumes(); }, 700);   // o YouTube nao avisa quando o volume muda pelas teclas dele (M, setas)
  // clicar fora do menu ou tirar o foco da janela fecha o menu
  document.addEventListener('pointerdown', function (e) {
    if (!menuIsOpen()) return;
    if (e.target && e.target.closest && e.target.closest('#menu, #bMenu, #mMenu')) return;
    closeMenu(false);
  }, true);
  window.addEventListener('blur', function () { endOpDrag(); closeMenu(false); });
  function menuAct(fn) { return function () { closeMenu(false); fn(); }; }
  $('mnSearch').addEventListener('click', menuAct(openOmnibox));
  $('mnRoom').addEventListener('click', menuAct(openRoomPanel));
  $('mnMic').addEventListener('click', menuAct(micClick));
  $('mnHear').addEventListener('click', menuAct(toggleHear));
  $('mnSpeed').addEventListener('click', menuAct(function () { sendToFrame('reset'); }));
  $('mnPin').addEventListener('click', menuAct(function () { $('bPin').click(); }));
  $('menu').addEventListener('keydown', function (e) {                // setas para cima/baixo andam pelos itens
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.target && e.target.type === 'range') return;                // na barra as setas mudam o valor
    var items = Array.prototype.filter.call($('menu').querySelectorAll('.mn-i, .mn-range'), function (b) { return !b.hidden && b.offsetParent !== null; });
    var i = items.indexOf(document.activeElement);
    var to = e.key === 'ArrowDown' ? i + 1 : i - 1;
    if (to < 0) to = items.length - 1;
    if (to >= items.length) to = 0;
    e.preventDefault();
    if (items[to]) items[to].focus();
  });
  $('bSpeed').addEventListener('click', function () {
    sendToFrame('reset');
    focusPlayer();
  });

  // tela de link
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!submitOmni($('url').value)) { $('url').focus(); $('url').select(); }
  });
  $('url').addEventListener('paste', function () {
    // colou um link: toca na hora; colou outro texto: espera o Enter para pesquisar
    setTimeout(function () { var v = $('url').value; if (v.trim() && window.LMLink.parse(v)) submitOmni(v); }, 0);
  });
  $('url').addEventListener('input', function () {
    var v = $('url').value.trim();
    $('goText').textContent = (!v || window.LMLink.parse(v)) ? 'Reproduzir' : 'Buscar';
  });
  $('url').addEventListener('focus', function () { S.typing = true; toHost('typing:1'); refreshUi(); });
  $('url').addEventListener('blur', function () { S.typing = false; toHost('typing:0'); refreshUi(); });
  $('pasteHome').addEventListener('click', pasteFromClipboard);
  $('modYoutube').addEventListener('click', function () { openModule('youtube'); });
  $('modSpotify').addEventListener('click', function () { openModule('spotify'); });

  // barra do modo navegacao (busca do YouTube, Spotify)
  $('browseBar').addEventListener('mousedown', startDragOnBackground);
  $('mBack').addEventListener('click', backToPlayer);
  $('tabYoutube').addEventListener('click', function () { openModule('youtube'); });
  $('tabSpotify').addEventListener('click', function () { openModule('spotify'); });
  $('mHome').addEventListener('click', function () {
    if (S.mode === 'youtube') { S.ytView = 'site'; setMode('youtube'); toHost('yhome'); }       // pagina inicial do YouTube (o site)
    else toHost('modhome');
  });

  // resultados da pesquisa (lista do programa)
  $('resList').addEventListener('click', function (e) {
    var li = e.target.closest ? e.target.closest('.res') : null;
    if (!li) return;
    var it = resItem(li.getAttribute('data-vid'));
    if (!it) return;
    if (e.target.closest('.rq')) queueResult(it, li); else playResult(it);
  });
  $('resList').addEventListener('keydown', function (e) {
    var li = e.target.closest ? e.target.closest('.res') : null;
    if (!li) return;
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target.closest('.rq')) return;                            // o botao + trata o proprio Enter
      e.preventDefault();
      var it = resItem(li.getAttribute('data-vid'));
      if (it) playResult(it);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      var nx = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
      if (nx) { e.preventDefault(); nx.focus(); }
    }
  });
  $('results').addEventListener('scroll', function () {
    var r = $('results');
    if (S.ytMore && !S.ytBusy && r.scrollTop + r.clientHeight >= r.scrollHeight - 160) loadResults(true);
  });
  $('resRetry').addEventListener('click', function () { loadResults(S.ytItems.length > 0); });
  function openYtSite() { S.ytView = 'site'; setMode('youtube'); toHost('search:' + S.ytq); }
  $('resSite').addEventListener('click', openYtSite);
  $('resSite2').addEventListener('click', openYtSite);
  $('mMin').addEventListener('click', function () { toHost('min'); });
  $('mClose').addEventListener('click', function () { toHost('close'); });
  $('mPin').addEventListener('click', function () { $('bPin').click(); });
  $('searchForm').addEventListener('submit', function (e) {
    e.preventDefault();
    submitOmni($('searchInput').value);
  });
  $('searchInput').addEventListener('focus', function () { S.typing = true; toHost('typing:1'); refreshUi(); });
  $('searchInput').addEventListener('blur', function () { S.typing = false; toHost('typing:0'); refreshUi(); });

  // tela de erro
  $('errRetry').addEventListener('click', function () { if (S.current) play(S.current); });
  $('errOpen').addEventListener('click', function () { if (S.current) toHost('open:' + S.current.url); });
  $('errNew').addEventListener('click', openHome);

  // teclado e area de transferencia (quando o foco esta nesta pagina; com o foco dentro do video quem trata e o programa)
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if (k === 'escape' && menuIsOpen()) { closeMenu(true); return; }
    if (k === 'escape' && !$('roomPanel').hidden) { closeRoomPanel(); return; }
    if (k === 'escape' && S.current && body.classList.contains('home')) { closeHome(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && k === 'l') { e.preventDefault(); openOmnibox(); return; }

    // velocidade e saltos (D, S, R, X, Z): com o foco dentro do video o proprio script do player trata;
    // com o foco nesta pagina (por exemplo depois de clicar na barra) a pagina repassa o comando
    var cmd = speedCmdFor(e);
    if (cmd && S.current && S.mode === 'player' && $('roomPanel').hidden && !S.typing && !e.ctrlKey && !e.altKey && !e.metaKey && !body.classList.contains('home')) {
      e.preventDefault();
      if (cmd === 'reset' && e.repeat) return;
      if (e.shiftKey && (cmd === 'faster' || cmd === 'slower')) cmd += 'Big';
      sendToFrame(cmd);
    }
  });
  document.addEventListener('paste', function (e) {
    if (e.target && (e.target.id === 'url' || e.target.id === 'searchInput' || e.target.id === 'rpCode' || e.target.id === 'rpName' || e.target.id === 'rpName2' || e.target.id === 'rpQInput')) return;   // os campos cuidam do proprio colar
    var t = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (!t) return;
    e.preventDefault();
    if (queueTabOpen()) addLinkToQueue(t); else handleText(t);       // com a aba Fila aberta, colar um link poe na fila
  });

  // o script que vive dentro do player do YouTube (speed-frame.js) informa a velocidade atual
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.lmmp !== 1) return;
    if (!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin)) return;
    if (d.type === 'rate') { S.rate = +d.rate || 1; renderRate(); }
    else if (d.type === 'rev') { Room.onFrameEvent(d); }               // a pessoa tocou/pausou/pulou: sobe para a sala
  });

  // arrastar um link de outro lugar e soltar na tela de link
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    var dt = e.dataTransfer;
    var t = dt ? (dt.getData('text/uri-list') || dt.getData('text/plain')) : '';
    if (t) handleText(t);
  });

  // sem menu de contexto do navegador (so no campo de texto)
  document.addEventListener('contextmenu', function (e) {
    if (!e.target || e.target.tagName !== 'INPUT') e.preventDefault();
  });

  // fora do programa (teste no navegador) nao ha quem avise do mouse: a pagina mesma faz isso
  if (!HAS_HOST) {
    var idle = 0;
    document.addEventListener('mousemove', function () {
      S.hostActive = true;
      refreshUi();
      clearTimeout(idle);
      idle = setTimeout(function () { S.hostActive = false; refreshUi(); }, 2500);
    });
  }

  window.addEventListener('resize', fitBarIfNeeded);
  setInterval(pushTb, 1000);                                         // rede de seguranca: a miniatura da barra de tarefas sempre acompanha
  renderPin();
  renderOpacity();
  renderRoom();
  refreshUi();
  toHost('ready');
})();
