/*
 * LM Mini Player - voz na sala (WebRTC): conversar durante o video.
 *
 * O audio vai DIRETO de um computador para o outro (conexao WebRTC, uma por par de pessoas, "malha");
 * o servidor de salas so leva as mensagens de combinacao (SDP e candidatos ICE) pela conexao da sala.
 * Cada pessoa tem o proprio volume e pode ser silenciada so para voce; o video tem o volume dele
 * (separado), e o microfone tem cancelamento de eco, reducao de ruido e ganho automatico.
 *
 * Quem tem o id MENOR oferece a conexao; as renegociacoes seguem o padrao "perfect negotiation".
 *
 *   LMVoice.supported()            o computador tem microfone/WebRTC?
 *   LMVoice.start()                entra na voz (pede o microfone; se nao der, entra so ouvindo) -> Promise
 *   LMVoice.stop()                 sai da voz
 *   LMVoice.isOn() / isMuted() / hasMic() / micError()
 *   LMVoice.setMuted(mudo) / toggleMute()
 *   LMVoice.person(id)             { vol, mute } preferencias SO suas sobre aquela pessoa; setPersonVolume / setPersonMute
 *   LMVoice.masterVolume([v])      volume de todas as vozes (0 a 1)
 *   LMVoice.peerState(id)          conectando | conectado | falhou
 *   LMVoice.hooks                  { changed, speaking(id, falando) }
 */
(function () {
  'use strict';

  var Room = window.LMRoom;
  var ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
  var SPEAK_LEVEL = 0.02;          // volume (RMS 0..1) a partir do qual "esta falando"
  var SPEAK_HOLD_MS = 400;         // continua "falando" por um instante depois que o som some

  var hooks = {};
  var V = {
    on: false,
    muted: false,
    stream: null,                  // MediaStream do microfone (null = so ouvindo)
    track: null,
    micError: '',
    peers: {},                     // id -> pessoa conectada
    people: {},                    // id -> { vol, mute } (so nesta sessao)
    master: 1,
    ctx: null,
    local: { speaking: false, lastLoud: 0, analyser: null, src: null },
    timer: 0,
    starting: null
  };

  try {
    var saved = JSON.parse(window.localStorage.getItem('lmmp.voice') || '{}');
    if (saved && saved.master >= 0 && saved.master <= 1) V.master = saved.master;
  } catch (e) { /* ignora */ }
  function savePrefs() { try { window.localStorage.setItem('lmmp.voice', JSON.stringify({ master: V.master })); } catch (e) { /* ignora */ } }

  function changed() { if (hooks.changed) { try { hooks.changed(); } catch (e) { /* ignora */ } } }
  function supported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function me() { return Room.myId(); }

  // ---------- microfone ----------
  function acquireMic() {
    if (V.track && V.track.readyState === 'live') return Promise.resolve(true);
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false
    }).then(function (stream) {
      V.stream = stream;
      V.track = stream.getAudioTracks()[0] || null;
      V.micError = '';
      if (V.track) {
        V.track.onended = function () { if (V.track === this) { V.track = null; V.stream = null; V.muted = true; announce(); changed(); } };
        V.track.enabled = !V.muted;
        listenTo(stream, V.local);
      }
      Object.keys(V.peers).forEach(function (id) {                 // quem ja esta conectado passa a ouvir o microfone (sem renegociar)
        var p = V.peers[id];
        if (p.tr && V.track) p.tr.sender.replaceTrack(V.track).catch(function () { /* ignora */ });
      });
      return true;
    }, function (err) {
      V.micError = (err && err.name) || 'erro';
      return false;
    });
  }

  function releaseMic() {
    if (V.stream) V.stream.getTracks().forEach(function (t) { try { t.onended = null; t.stop(); } catch (e) { /* ignora */ } });
    V.stream = null;
    V.track = null;
    unlisten(V.local);
  }

  function announce() { Room.setVoice(V.on, V.muted || !V.track); }

  // ---------- entrar e sair da voz ----------
  function start() {
    if (V.on) return Promise.resolve({ ok: true, micError: V.micError });
    if (V.starting) return V.starting;
    if (!supported() || !Room.code()) return Promise.resolve({ ok: false, micError: 'sem_suporte' });
    V.starting = acquireMic().then(function (hasMic) {
      V.starting = null;
      if (!Room.code()) { releaseMic(); return { ok: false, micError: 'sem_sala' }; }
      V.on = true;
      V.muted = !hasMic;                                           // sem microfone: entra so ouvindo
      announce();
      Room.members().forEach(function (m) { if (m.id !== me() && m.voice) connectTo(m.id); });
      startTimer();
      changed();
      return { ok: true, micError: V.micError };
    });
    return V.starting;
  }

  function stop() {
    var was = V.on;
    V.on = false;
    V.muted = false;
    Object.keys(V.peers).forEach(closePeer);
    releaseMic();
    stopTimer();
    V.micError = '';
    if (was && Room.code()) Room.setVoice(false, false);
    changed();
  }

  function setMuted(m) {
    if (!V.on) return Promise.resolve();
    if (!m && !V.track) {                                          // quem estava so ouvindo liga o microfone agora
      return acquireMic().then(function (ok) {
        V.muted = !ok;
        announce();
        changed();
      });
    }
    V.muted = !!m;
    if (V.track) V.track.enabled = !V.muted;
    announce();
    changed();
    return Promise.resolve();
  }

  function toggleMute() { return setMuted(!(V.muted || !V.track)); }

  // ---------- conexoes com as outras pessoas ----------
  function sig(to, data) { Room.send({ t: 'sig', to: to, data: data }); }

  function connectTo(id) {
    if (!V.on || V.peers[id]) return;
    if (me() < id) createPeer(id, true);                           // o id menor oferece; o outro espera a oferta
  }

  function createPeer(id, offerer) {
    var pc = new RTCPeerConnection({ iceServers: ICE });
    var peer = {
      id: id, pc: pc, polite: me() > id, makingOffer: false, ignoreOffer: false, tr: null, fresh: !!offerer,
      audio: null, stream: null, state: 'conectando', restarts: 0, retryTimer: 0,
      speaking: false, lastLoud: 0, analyser: null, src: null
    };
    V.peers[id] = peer;

    pc.onicecandidate = function (e) { if (e.candidate) sig(id, { candidate: e.candidate }); };
    pc.ontrack = function (e) {
      peer.stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      attachAudio(peer);
    };
    pc.onnegotiationneeded = function () {
      peer.makingOffer = true;
      pc.setLocalDescription().then(function () {
        sig(id, peer.fresh ? { description: pc.localDescription, fresh: true } : { description: pc.localDescription });
        peer.fresh = false;
      })
        .catch(function () { /* ignora */ })
        .then(function () { peer.makingOffer = false; });
    };
    pc.onconnectionstatechange = function () {
      var s = pc.connectionState;
      if (s === 'connected') { peer.state = 'conectado'; peer.restarts = 0; }
      else if (s === 'failed') { peer.state = 'falhou'; retry(peer); }
      else if (s === 'disconnected') { peer.state = 'conectando'; clearTimeout(peer.retryTimer); peer.retryTimer = setTimeout(function () { if (pc.connectionState === 'disconnected') retry(peer); }, 5000); }
      else if (s === 'closed') { return; }
      else { peer.state = 'conectando'; }
      changed();
    };

    if (offerer) {
      peer.tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (V.track) peer.tr.sender.replaceTrack(V.track).catch(function () { /* ignora */ });
    }
    changed();
    return peer;
  }

  // a conexao caiu: primeiro reinicia o ICE; se continuar ruim, refaz a conexao inteira (algumas vezes)
  function retry(peer) {
    if (!V.on || V.peers[peer.id] !== peer) return;
    peer.restarts++;
    if (peer.restarts <= 2) { try { peer.pc.restartIce(); } catch (e) { /* ignora */ } return; }
    if (peer.restarts > 5) return;
    var id = peer.id;
    closePeer(id);
    setTimeout(function () { if (V.on) { var m = Room.members().filter(function (x) { return x.id === id; })[0]; if (m && m.voice) connectTo(id); } }, 3000);
  }

  function closePeer(id) {
    var p = V.peers[id];
    if (!p) return;
    delete V.peers[id];
    clearTimeout(p.retryTimer);
    p.pc.onicecandidate = p.pc.ontrack = p.pc.onnegotiationneeded = p.pc.onconnectionstatechange = null;
    try { p.pc.close(); } catch (e) { /* ignora */ }
    if (p.audio) { try { p.audio.pause(); p.audio.srcObject = null; } catch (e) { /* ignora */ } }
    unlisten(p);
    changed();
  }

  // chegou uma mensagem de combinacao de outra pessoa ("perfect negotiation")
  function onSignal(from, data) {
    if (!V.on || !data || typeof data !== 'object') return;
    if (data.reset) {                                                            // o outro lado recomecou: joga fora a conexao velha e oferece uma nova
      if (V.peers[from]) closePeer(from);
      var who = Room.members().filter(function (x) { return x.id === from; })[0];
      if (who && who.voice) connectTo(from);
      return;
    }
    var peer = V.peers[from];
    if (data.fresh && peer) { closePeer(from); peer = null; }                    // primeira oferta de uma conexao nova: a velha nao serve mais
    if (!peer) {
      if (!data.description || data.description.type !== 'offer') return;        // candidato solto de quem nao conhecemos
      peer = createPeer(from, false);
    }
    var pc = peer.pc;
    var work;
    if (data.description) {
      var d = data.description;
      var collision = d.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      work = pc.setRemoteDescription(d).then(function () {
        if (d.type !== 'offer') return;
        pc.getTransceivers().some(function (tr) {                                    // a oferta criou o transceiver de audio: responde ouvindo E falando
          if (tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'audio') {
            peer.tr = tr;
            try { tr.direction = 'sendrecv'; } catch (e) { /* ignora */ }
            if (V.track) tr.sender.replaceTrack(V.track).catch(function () { /* ignora */ });
            return true;
          }
          return false;
        });
        return pc.setLocalDescription().then(function () { sig(from, { description: pc.localDescription }); });
      });
    } else if (data.candidate) {
      work = pc.addIceCandidate(data.candidate).catch(function (e) { if (!peer.ignoreOffer) throw e; });
    }
    if (work) work.catch(function () { /* ignora */ });
  }

  // ---------- audio recebido: volume, silenciar e "quem esta falando" ----------
  function person(id) {
    if (!V.people[id]) V.people[id] = { vol: 1, mute: false };
    return V.people[id];
  }

  function applyVolume(peer) {
    if (!peer || !peer.audio) return;
    var p = person(peer.id);
    peer.audio.volume = Math.max(0, Math.min(1, V.master * p.vol));
    peer.audio.muted = !!p.mute;
  }

  function attachAudio(peer) {
    if (!peer.audio) { peer.audio = new Audio(); peer.audio.autoplay = true; }
    peer.audio.srcObject = peer.stream;
    applyVolume(peer);
    var pr = peer.audio.play();
    if (pr && pr.catch) pr.catch(function () { /* o play automatico foi barrado: o proximo clique resolve */ });
    listenTo(peer.stream, peer);
  }

  function audioCtx() {
    if (!V.ctx) { try { V.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { V.ctx = null; } }
    if (V.ctx && V.ctx.state === 'suspended') V.ctx.resume().catch(function () { /* ignora */ });
    return V.ctx;
  }

  function listenTo(stream, holder) {
    unlisten(holder);
    var ctx = audioCtx();
    if (!ctx || !stream) return;
    try {
      holder.src = ctx.createMediaStreamSource(stream);
      holder.analyser = ctx.createAnalyser();
      holder.analyser.fftSize = 512;
      holder.src.connect(holder.analyser);                         // so mede: nao liga em nenhuma saida (o som sai pelo <audio>)
    } catch (e) { holder.src = holder.analyser = null; }
  }

  function unlisten(holder) {
    try { if (holder.src) holder.src.disconnect(); } catch (e) { /* ignora */ }
    holder.src = null;
    holder.analyser = null;
    if (holder.speaking) { holder.speaking = false; if (hooks.speaking) hooks.speaking(holder === V.local ? 'me' : holder.id, false); }
  }

  var buf = null;
  function level(analyser) {
    if (!analyser) return 0;
    if (!buf || buf.length !== analyser.fftSize) buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function tick() {
    var now = Date.now();
    function update(holder, id, muted) {
      var lv = muted ? 0 : level(holder.analyser);
      if (lv > SPEAK_LEVEL) holder.lastLoud = now;
      var s = now - holder.lastLoud < SPEAK_HOLD_MS;
      if (s !== !!holder.speaking) { holder.speaking = s; if (hooks.speaking) { try { hooks.speaking(id, s); } catch (e) { /* ignora */ } } }
    }
    update(V.local, 'me', V.muted || !V.track);
    Object.keys(V.peers).forEach(function (id) { var p = V.peers[id]; update(p, id, person(id).mute); });
  }
  function startTimer() { if (!V.timer) V.timer = setInterval(tick, 100); }
  function stopTimer() { clearInterval(V.timer); V.timer = 0; }

  // ---------- ligacao com a sala ----------
  Room.hooks.signal = onSignal;
  Room.hooks.memberJoined = function (m) { if (m && m.id !== me() && m.voice) connectTo(m.id); };
  Room.hooks.memberUpdated = function (m) {
    if (!m || m.id === me()) return;
    if (m.voice) connectTo(m.id); else if (V.peers[m.id]) closePeer(m.id);
  };
  Room.hooks.memberLeft = function (id) { closePeer(id); delete V.people[id]; };
  Room.hooks.opened = function () {                                // voltou a conexao com o servidor: avisa de novo que estou na voz
    if (!V.on) return;
    Object.keys(V.peers).forEach(closePeer);                       // recomeca as conexoes: o outro lado pode ter jogado fora a ponta dele
    announce();
    Room.members().forEach(function (m) {
      if (m.id === me() || !m.voice) return;
      if (me() < m.id) connectTo(m.id); else sig(m.id, { reset: true });
    });
  };
  Room.hooks.left = function () { if (V.on || V.starting) stop(); };

  window.LMVoice = {
    hooks: hooks,
    supported: supported,
    start: start,
    stop: stop,
    isOn: function () { return V.on; },
    isMuted: function () { return V.on && (V.muted || !V.track); },
    hasMic: function () { return !!V.track; },
    micError: function () { return V.micError; },
    setMuted: setMuted,
    toggleMute: toggleMute,
    person: function (id) { var p = person(id); return { vol: p.vol, mute: p.mute }; },
    setPersonVolume: function (id, v) { person(id).vol = Math.max(0, Math.min(1, +v || 0)); applyVolume(V.peers[id]); },
    setPersonMute: function (id, m) { person(id).mute = !!m; applyVolume(V.peers[id]); },
    masterVolume: function (v) {
      if (v === undefined) return V.master;
      V.master = Math.max(0, Math.min(1, +v || 0));
      savePrefs();
      Object.keys(V.peers).forEach(function (id) { applyVolume(V.peers[id]); });
      return V.master;
    },
    peerState: function (id) { return V.peers[id] ? V.peers[id].state : ''; },
    speaking: function (id) { return id === 'me' ? !!V.local.speaking : !!(V.peers[id] && V.peers[id].speaking); },
    // so para testes: situacao das conexoes e dos audios
    debug: function () {
      return Object.keys(V.peers).map(function (id) {
        var p = V.peers[id];
        return { id: id, state: p.state, conn: p.pc.connectionState, ice: p.pc.iceConnectionState, sig: p.pc.signalingState, hasStream: !!p.stream,
                 vol: p.audio ? p.audio.volume : null, muted: p.audio ? p.audio.muted : null, paused: p.audio ? p.audio.paused : null };
      });
    },
    stats: function () {
      return Promise.all(Object.keys(V.peers).map(function (id) {
        return V.peers[id].pc.getStats().then(function (rep) {
          var out = { id: id, inBytes: 0, inPackets: 0, outBytes: 0, outPackets: 0, level: null };
          rep.forEach(function (r) {
            if (r.type === 'inbound-rtp' && r.kind === 'audio') { out.inBytes = r.bytesReceived; out.inPackets = r.packetsReceived; if (r.audioLevel !== undefined) out.level = r.audioLevel; }
            if (r.type === 'outbound-rtp' && r.kind === 'audio') { out.outBytes = r.bytesSent; out.outPackets = r.packetsSent; }
          });
          return out;
        });
      }));
    }
  };
})();
