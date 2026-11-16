/*
 * LM Mini Player - pesquisa do YouTube para a lista de resultados (e titulo de videos para a fila).
 *
 * A pagina nao fala com o YouTube: pede ao programa, que usa uma janela auxiliar ESCONDIDA do youtube.com
 * (web\yt-search.js roda la dentro) e devolve a lista pronta. Mensagens (pagina <-> programa):
 *   pagina -> programa:  ysearch:<n>:<texto> | ymore:<n>:<token> | yinfo:<n>:<id do video>
 *   programa -> pagina:  yres:<n>:<json>  | yinfo:<n>:<json>
 *
 *   LMYt.available()    o programa esta por tras? (so ele sabe pesquisar)
 *   LMYt.search(texto)  -> Promise({ items:[{id,title,channel,dur,views,pub,live}], more })
 *   LMYt.more(token)    -> Promise({ items, more })
 *   LMYt.info(id)       -> Promise({ id, title, channel })
 *   LMYt.onHost(texto)  trata a resposta do programa; devolve true se era uma resposta nossa
 */
(function () {
  'use strict';

  var TIMEOUT_MS = 25000;
  var seq = 0;
  var waiting = {};
  var api = {
    test: false,                                                          // so os testes ligam isto (e trocam o post)
    post: function (msg) { window.chrome.webview.postMessage(msg); }
  };

  function available() { return api.test || !!(window.chrome && window.chrome.webview); }

  function ask(cmd, payload) {
    return new Promise(function (resolve, reject) {
      if (!available()) { reject(new Error('sem_programa')); return; }
      var n = ++seq;
      var t = setTimeout(function () { delete waiting[n]; reject(new Error('tempo')); }, TIMEOUT_MS);
      waiting[n] = { resolve: resolve, reject: reject, t: t };
      try { api.post(cmd + ':' + n + ':' + payload); }
      catch (e) { clearTimeout(t); delete waiting[n]; reject(new Error('sem_programa')); }
    });
  }

  function onHost(text) {
    if (typeof text !== 'string') return false;
    var m = /^(yres|yinfo):(\d+):/.exec(text);
    if (!m) return false;
    var n = +m[2];
    var w = waiting[n];
    if (!w) return true;                              // resposta atrasada de um pedido que ja desistiu
    delete waiting[n];
    clearTimeout(w.t);
    var p;
    try { p = JSON.parse(text.slice(m[0].length)); } catch (e) { w.reject(new Error('formato')); return true; }
    if (p && p.ok) w.resolve(p);
    else { var er = new Error((p && p.error) || 'erro'); if (p && p.info) er.info = String(p.info); w.reject(er); }
    return true;
  }

  window.LMYt = {
    available: available,
    search: function (q) { return ask('ysearch', String(q || '').slice(0, 300)); },
    more: function (token) { return ask('ymore', String(token || '')); },
    info: function (id) { return ask('yinfo', String(id || '')); },
    onHost: onHost,
    _api: api,
    _waiting: waiting
  };
})();
