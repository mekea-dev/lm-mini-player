/*
 * LM Mini Player - interface.
 * Roda dentro da janela do programa (WebView2) e tambem num navegador comum, para teste.
 *
 * Conversa com o programa (C#) por mensagens de texto "comando:argumento":
 *   pagina -> programa:  ready | drag | size:<borda> | min | close | pin:0/1 | op:0.85
 *                        paste | typing:0/1 | open:<url>
 *                        mod:<player|youtube|spotify> | search:<texto> | modhome
 *                        update:<link do video atual> | updweb
 *   programa -> pagina:  cfg:pin=1;op=1 | url:<texto> | link | ui:0/1 | dragend
 *                        mod:<modulo> | modtitle:<texto> | modfail:<modulo>
 *                        upd:ready:<versao> | upd:manual:<versao> | upd:busy | upd:fail
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var HAS_HOST = !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage);
  var Room = window.LMRoom;
  var APP_NAME = 'LM Mini Player';
  var OPACITY_STEPS = [1, 0.85, 0.7, 0.55, 0.4];
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
    }
  }

  if (HAS_HOST) {
    window.chrome.webview.addEventListener('message', function (e) { onHostMessage(e.data); });
  }
  window.__lm = { fromHost: onHostMessage, state: S, renderRate: function () { renderRate(); }, resumeLink: function () { return resumeLink(); } };   // ganchos para testes

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
    body.classList.toggle('ui', always || S.hostActive || S.barHover || S.typing);
    renderRate();
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
    var m = $('mPin');                               // o mesmo botao na barra do modo navegacao
    m.classList.toggle('on', S.pin);
    m.setAttribute('aria-pressed', S.pin ? 'true' : 'false');
    m.title = b.title;
  }

  function renderOpacity() {
    $('bOp').title = 'Transparência: ' + Math.round(S.opacity * 100) + '% (clique para alternar)';
  }

  // selo da velocidade na barra: so aparece quando ha video e a velocidade nao e 1x
  function renderRate() {
    var b = $('bSpeed');
    var on = Math.abs(S.rate - 1) > 0.001 && S.current &&
      !body.classList.contains('empty') && !body.classList.contains('err');
    b.hidden = !on;
    b.textContent = (Math.round(S.rate * 100) / 100) + '×';
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
      if (f && S.mode === 'player' && !body.classList.contains('home')) f.focus();
    } catch (err) { /* ignora */ }
  }

  function nextOpacity() {
    for (var i = 0; i < OPACITY_STEPS.length; i++) {
      if (OPACITY_STEPS[i] < S.opacity - 0.001) return OPACITY_STEPS[i];
    }
    return 1;
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
  function syncVolumes() {
    var v = $('rpVidVol');
    if (document.activeElement !== v) {
      try { if (S.player && S.player.getVolume) v.value = S.player.isMuted && S.player.isMuted() ? 0 : S.player.getVolume(); } catch (e) { /* ignora */ }
    }
    var vv = $('rpVoiceVol');
    if (Voice && document.activeElement !== vv) vv.value = Math.round(Voice.masterVolume() * 100);
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
  }

  function openRoomPanel() {
    clearError();
    $('roomPanel').hidden = false;
    $('rpName').value = Room.name();
    $('rpName2').value = Room.name();
    renderRoom();
    roomMsg('');
    syncVolumes();
    if (!Room.code()) setTimeout(function () { (Room.name() ? $('rpCode') : $('rpName')).focus(); }, 30);
  }

  function closeRoomPanel() { $('roomPanel').hidden = true; focusPlayer(); }

  // desenha o botao da barra e o painel conforme a sala (e esconde tudo se o servidor de salas nao esta configurado)
  function renderRoom() {
    var avail = Room.available();
    $('bRoom').hidden = !avail;
    $('roomHome').hidden = !avail;
    var code = Room.code();
    var on = !!code;
    var list = Room.members();
    var n = list.length || 1;
    var b = $('bRoom');
    b.classList.toggle('room-on', on);
    b.title = on
      ? 'Sala ' + code + ': ' + n + (n === 1 ? ' pessoa' : ' pessoas') + ' (clique para ver)'
      : 'Sala: ver o mesmo vídeo junto com outras pessoas';
    body.classList.toggle('in-room', on);
    $('rpOut').hidden = on;
    $('rpIn').hidden = !on;
    if (on) {
      $('rpCodeShow').textContent = code;
      $('rpInfo').textContent = (Room.status() === 'reconectando' ? 'Reconectando… ' : '') +
        n + (n === 1 ? ' pessoa na sala' : ' pessoas na sala');
      renderMembers(list);
      syncVolumes();
    }
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
    try { play(info); } finally { S.remoteLoad = false; }
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
  $('rpVidVol').addEventListener('input', function () {
    var v = Math.max(0, Math.min(100, +$('rpVidVol').value || 0));
    try { if (S.player && S.player.setVolume) { S.player.setVolume(v); if (v > 0 && S.player.isMuted && S.player.isMuted()) S.player.unMute(); } } catch (e) { /* ignora */ }
  });
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
  ['rpCode', 'rpName', 'rpName2'].forEach(function (id) {
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
    S.mode = name;
    body.classList.toggle('browse', name !== 'player');
    body.classList.toggle('mod-youtube', name === 'youtube');
    body.classList.toggle('mod-spotify', name === 'spotify');
    $('tabYoutube').classList.toggle('on', name === 'youtube');
    $('tabSpotify').classList.toggle('on', name === 'spotify');
    if (name !== 'player') { body.classList.remove('home'); clearError(); }
    if (name !== 'spotify') $('modTitle').textContent = '';
    refreshUi();
  }

  function openModule(name) {
    if (S.mode === name) return;
    setMode(name);
    toHost('mod:' + name);
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
    setMode('youtube');
    toHost('search:' + text);
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

  function play(info) {
    S.current = info;
    if (!S.remoteLoad && Room.code()) Room.publishLoad(info);        // numa sala, trocar de video troca para todos
    clearError();
    if (S.mode !== 'player') { setMode('player'); toHost('mod:player'); }   // tocou um link: sai da busca
    $('url').value = '';
    $('goText').textContent = 'Reproduzir';
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
    focusPlayer();
    sendToFrame('hello');
    if (Room.code()) {                                                // video novo numa sala: poe igual ao da sala
      sendToFrameRaw({ type: 'roomOn', on: true });
      var rs = Room.state();
      if (rs) sendRoomToFrame(rs);
    }
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
  $('bOp').addEventListener('click', function () {
    S.opacity = nextOpacity();
    renderOpacity();
    toHost('op:' + S.opacity);
    toast('Transparência: ' + Math.round(S.opacity * 100) + '%');
    focusPlayer();
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
  $('mHome').addEventListener('click', function () { toHost('modhome'); });
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
    if (e.target && (e.target.id === 'url' || e.target.id === 'searchInput' || e.target.id === 'rpCode' || e.target.id === 'rpName' || e.target.id === 'rpName2')) return;   // os campos cuidam do proprio colar
    var t = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (t) { e.preventDefault(); handleText(t); }
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

  renderPin();
  renderOpacity();
  renderRoom();
  refreshUi();
  toHost('ready');
})();
