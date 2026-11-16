/*
 * LM Mini Player - fila de videos SUA (fora das salas), guardada neste computador.
 *
 * Dentro de uma sala a fila e a da sala (guardada no servidor, igual para todos: veja room.js). Fora dela vale esta,
 * que fica no armazenamento local do programa (localStorage): sobrevive a fechar o programa, e duas janelas do
 * programa abertas ao mesmo tempo enxergam a mesma lista. Ate 50 videos; cada item e { id, vid, title }.
 *
 *   LMQueue.items()                    copia da lista
 *   LMQueue.count() / LMQueue.isFull() / LMQueue.MAX
 *   LMQueue.add(vid, titulo, posicao?) -> o item, ou null (id de video invalido ou fila cheia)
 *   LMQueue.move(id, para)             poe o item na posicao "para" (0 = o proximo); false se nao achou
 *   LMQueue.remove(id) / LMQueue.take(id) (tira e devolve o item) / LMQueue.shift() (tira o primeiro) / LMQueue.clear()
 *   LMQueue.onChange(fn)               chama fn quando a lista muda (inclusive por outra janela do programa)
 */
(function () {
  'use strict';

  var KEY = 'lmmp.queue';
  var MAX = 50;
  var MAX_TITLE = 100;
  var VID_RE = /^[A-Za-z0-9_-]{11}$/;
  var listeners = [];
  var list = load();

  // titulo que aparece na lista: sem caracteres de controle nem de direcao de texto, espacos arrumados, ate 100 letras
  function cleanTitle(t) {
    t = typeof t === 'string' ? t : '';
    var out = '';
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      if (c < 32 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) continue;
      out += t.charAt(i);
    }
    return Array.from(out.replace(/\s+/g, ' ').trim()).slice(0, MAX_TITLE).join('');
  }

  function newId() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // le do armazenamento aceitando so o que parece uma fila valida (lixo ou versao antiga nao derruba nada)
  function load() {
    var out = [];
    try {
      var raw = JSON.parse(window.localStorage.getItem(KEY) || '[]');
      if (Array.isArray(raw)) {
        var seen = {};
        raw.forEach(function (x) {
          if (out.length >= MAX || !x || typeof x !== 'object' || typeof x.vid !== 'string' || !VID_RE.test(x.vid)) return;
          var id = typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x.id) && !seen[x.id] ? x.id : newId();
          seen[id] = 1;
          out.push({ id: id, vid: String(x.vid), title: cleanTitle(x.title) });
        });
      }
    } catch (e) { /* sem armazenamento ou texto estragado: comeca vazia */ }
    return out;
  }

  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* sem armazenamento: vale so ate fechar */ }
  }

  function changed() {
    listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { /* ignora */ } });
  }

  function indexOf(id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  function copy(it) { return { id: it.id, vid: it.vid, title: it.title }; }

  // outra janela do programa mexeu na fila: recarrega e avisa
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY && e.key !== null) return;
    list = load();
    changed();
  });

  window.LMQueue = {
    MAX: MAX,
    items: function () { return list.map(copy); },
    count: function () { return list.length; },
    isFull: function () { return list.length >= MAX; },
    add: function (vid, title, at) {
      if (typeof vid !== 'string' || !VID_RE.test(vid) || list.length >= MAX) return null;
      var it = { id: newId(), vid: vid, title: cleanTitle(title) };
      var pos = (typeof at === 'number' && isFinite(at)) ? Math.max(0, Math.min(list.length, Math.floor(at))) : list.length;
      list.splice(pos, 0, it);
      save();
      changed();
      return copy(it);
    },
    move: function (id, to) {
      var i = indexOf(id);
      if (i < 0 || typeof to !== 'number' || !isFinite(to)) return false;
      var dest = Math.max(0, Math.min(list.length - 1, Math.floor(to)));
      if (dest === i) return true;
      list.splice(dest, 0, list.splice(i, 1)[0]);
      save();
      changed();
      return true;
    },
    remove: function (id) { return !!window.LMQueue.take(id); },
    take: function (id) {
      var i = indexOf(id);
      if (i < 0) return null;
      var it = list.splice(i, 1)[0];
      save();
      changed();
      return copy(it);
    },
    shift: function () {
      if (!list.length) return null;
      var it = list.shift();
      save();
      changed();
      return copy(it);
    },
    clear: function () {
      if (!list.length) return;
      list = [];
      save();
      changed();
    },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    _reload: function () { list = load(); }                    // so para testes
  };
})();
