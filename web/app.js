/*
 * LM Mini Player - interface.
 * Roda dentro da janela do programa (WebView2) e tambem num navegador comum, para teste.
 *
 * Conversa com o programa (C#) por mensagens de texto "comando:argumento":
 *   pagina -> programa:  ready | drag | size:<borda> | min | close | pin:0/1 | op:0.85
 *                        paste | typing:0/1 | open:<url>
 *   programa -> pagina:  cfg:pin=1;op=1 | url:<texto> | link | ui:0/1 | dragend
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var HAS_HOST = !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage);
  var APP_NAME = 'LM Mini Player';
  var OPACITY_STEPS = [1, 0.85, 0.7, 0.55, 0.4];
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
    var i = text.indexOf(':');
    var cmd = i < 0 ? text : text.slice(0, i);
    var arg = i < 0 ? '' : text.slice(i + 1);
    if (cmd === 'cfg') {
      applyCfg(arg);
    } else if (cmd === 'url') {
      handleText(arg);
    } else if (cmd === 'link') {
      openHome();
    } else if (cmd === 'ui') {
      S.hostActive = arg === '1';
      if (!S.hostActive && !$('bar').matches(':hover')) S.barHover = false;
      refreshUi();
    } else if (cmd === 'dragend') {
      S.barHover = false;
      refreshUi();
    }
  }

  if (HAS_HOST) {
    window.chrome.webview.addEventListener('message', function (e) { onHostMessage(e.data); });
  }
  window.__lm = { fromHost: onHostMessage, state: S };   // gancho para testes

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
    var always = body.classList.contains('empty') || body.classList.contains('home') || body.classList.contains('err');
    body.classList.toggle('ui', always || S.hostActive || S.barHover || S.typing);
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
  }

  function renderPin() {
    var b = $('bPin');
    b.classList.toggle('on', S.pin);
    b.setAttribute('aria-pressed', S.pin ? 'true' : 'false');
    b.title = S.pin
      ? 'Sempre por cima: ligado (clique para desligar)'
      : 'Sempre por cima: desligado (clique para ligar)';
  }

  function renderOpacity() {
    $('bOp').title = 'Transparência: ' + Math.round(S.opacity * 100) + '% (clique para alternar)';
  }

  function nextOpacity() {
    for (var i = 0; i < OPACITY_STEPS.length; i++) {
      if (OPACITY_STEPS[i] < S.opacity - 0.001) return OPACITY_STEPS[i];
    }
    return 1;
  }

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

  function play(info) {
    S.current = info;
    clearError();
    $('url').value = '';
    body.classList.remove('empty', 'home');
    body.classList.add('playing');
    setTitle('Carregando…');
    refreshUi();

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
  }

  function onPlayerState(e) {
    // 1 = tocando, 3 = carregando, 5 = pronto
    if (e && (e.data === 1 || e.data === 3 || e.data === 5)) updateTitleFromPlayer();
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
  }

  function clearError() {
    body.classList.remove('err');
    refreshUi();
  }

  /* ---------- eventos ---------- */

  // arrastar a janela pela barra (ou por um espaco vazio das telas de link e erro)
  function startDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    toHost('drag');
  }
  function startDragOnBackground(e) {
    if (e.button !== 0) return;
    if (e.target.closest('input, button, a, textarea, select')) return;
    e.preventDefault();
    toHost('drag');
  }
  $('drag').addEventListener('mousedown', startDrag);
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
  $('bPaste').addEventListener('click', pasteFromClipboard);
  $('bPin').addEventListener('click', function () {
    S.pin = !S.pin;
    renderPin();
    toHost('pin:' + (S.pin ? 1 : 0));
    toast(S.pin ? 'Sempre por cima: ligado' : 'Sempre por cima: desligado');
  });
  $('bOp').addEventListener('click', function () {
    S.opacity = nextOpacity();
    renderOpacity();
    toHost('op:' + S.opacity);
    toast('Transparência: ' + Math.round(S.opacity * 100) + '%');
  });

  // tela de link
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!handleText($('url').value)) { $('url').focus(); $('url').select(); }
  });
  $('url').addEventListener('paste', function () {
    setTimeout(function () { var v = $('url').value; if (v.trim()) handleText(v); }, 0);
  });
  $('url').addEventListener('focus', function () { S.typing = true; toHost('typing:1'); refreshUi(); });
  $('url').addEventListener('blur', function () { S.typing = false; toHost('typing:0'); refreshUi(); });
  $('pasteHome').addEventListener('click', pasteFromClipboard);

  // tela de erro
  $('errRetry').addEventListener('click', function () { if (S.current) play(S.current); });
  $('errOpen').addEventListener('click', function () { if (S.current) toHost('open:' + S.current.url); });
  $('errNew').addEventListener('click', openHome);

  // teclado e area de transferencia (quando o foco esta nesta pagina; com o foco dentro do video quem trata e o programa)
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if (k === 'escape' && S.current && body.classList.contains('home')) { closeHome(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && k === 'l') { e.preventDefault(); openHome(); }
  });
  document.addEventListener('paste', function (e) {
    if (e.target && e.target.id === 'url') return;       // o campo cuida do proprio colar
    var t = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (t) { e.preventDefault(); handleText(t); }
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

  renderPin();
  renderOpacity();
  refreshUi();
  toHost('ready');
})();
