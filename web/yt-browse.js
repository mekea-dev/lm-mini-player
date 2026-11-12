/*
 * LM Mini Player - busca do YouTube dentro do programa.
 *
 * O programa injeta este arquivo nas paginas do YouTube que abre na janela de busca (modulo
 * "youtube"). Quando voce clica num video (ou short, ou transmissao ao vivo), em vez de o site
 * tocar o video ali, o clique e capturado e o link vai para o nosso player (velocidade livre,
 * atalhos, sempre por cima...). Links de canal, playlist e pesquisa continuam navegando
 * normalmente na janela de busca.
 */
(function () {
  'use strict';

  try {
    if (window !== window.top) return;
    if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return;
  } catch (e) { return; }

  var WATCH = /^https:\/\/(m|www|music)\.youtube\.com\/(watch\?|shorts\/|live\/)/i;

  // Em janelas baixas o cabecalho do YouTube come o espaco dos resultados (e a barra do programa ja tem
  // um campo de busca): some. Em janelas maiores ele fica, com as sugestoes de pesquisa do YouTube.
  function addStyle() {
    var st = document.createElement('style');
    st.textContent =
      '@media (max-height: 400px) { ' +
      'ytd-masthead, #masthead-container { display: none !important; } ' +
      'html, :root { --ytd-masthead-height: 0px !important; } }';
    (document.head || document.documentElement).appendChild(st);
  }
  if (document.documentElement) addStyle();
  else document.addEventListener('DOMContentLoaded', addStyle);

  // o <a> clicado, mesmo quando o clique vem de dentro de um componente com shadow DOM
  function anchorFrom(e) {
    var path = (e.composedPath && e.composedPath()) || [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.tagName === 'A' && n.href) return n;
    }
    var t = e.target;
    while (t && t !== document) {
      if (t.tagName === 'A' && t.href) return t;
      t = t.parentNode;
    }
    return null;
  }

  document.addEventListener('click', function (e) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var a = anchorFrom(e);
    if (!a || !WATCH.test(a.href)) return;
    if (!(window.chrome && window.chrome.webview)) return;       // sem ponte com o programa: deixa o site agir
    e.preventDefault();
    e.stopImmediatePropagation();
    window.chrome.webview.postMessage('lmmp-play:' + a.href);
  }, true);
})();
