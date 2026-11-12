/*
 * LM Mini Player - le o que a pessoa colou e devolve os dados do video.
 *
 *   LMLink.parse(texto) -> { id, list, start, index, url } | null
 *
 *   id     ID do video (11 caracteres) ou null quando for so uma playlist
 *   list   ID da playlist ou null
 *   start  segundo inicial (0 quando o link nao tem tempo)
 *   index  posicao na playlist, contando de 1 (0 quando nao tem)
 *   url    endereco "normal" do YouTube, usado para abrir no navegador
 *
 * Nao depende de tela (so de URL), por isso da para testar em tests/links.html.
 */
(function (root) {
  'use strict';

  var ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var LIST_RE = /^[A-Za-z0-9_-]{10,80}$/;
  var YT_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i;

  // "90", "90s", "1m30s", "1h2m3s", "2m30" -> segundos
  function toSeconds(value) {
    if (value === null || value === undefined) return 0;
    var s = String(value).trim().toLowerCase();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(s);
    if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return 0;
    return parseInt(m[1] || '0', 10) * 3600 + parseInt(m[2] || '0', 10) * 60 + parseInt(m[3] || '0', 10);
  }

  // Acha o "pedaco" que parece link dentro do texto colado.
  function firstToken(text) {
    var t = String(text === null || text === undefined ? '' : text).trim();
    if (!t) return '';
    var m = /https?:\/\/[^\s<>"']+/i.exec(t);
    if (m) return m[0];
    // dominio sem "https://": so vale no comeco do texto ou depois de espaco/abre-parenteses
    // (assim "ftp://youtube.com/..." nao e confundido com um link comum)
    m = /(?:^|[\s(\[<"'])((?:[a-z0-9-]+\.)*(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\/[^\s<>"']*)/i.exec(t);
    if (m) return 'https://' + m[1];
    return t.split(/\s+/)[0];
  }

  function build(id, list, start, index) {
    var url = id
      ? 'https://www.youtube.com/watch?v=' + id
      : 'https://www.youtube.com/playlist?list=' + list;
    if (id && list) url += '&list=' + list;
    if (start > 0) url += '&t=' + start + 's';
    return { id: id, list: list, start: start || 0, index: index || 0, url: url };
  }

  function parse(text, depth) {
    var tok = firstToken(text);
    if (!tok) return null;
    // pontuacao que sobra quando o link vem no meio de uma frase: "(https://...)."
    tok = tok.replace(/[)\]>.,;!?]+$/, '');

    // so o ID do video
    if (ID_RE.test(tok)) return build(tok, null, 0, 0);

    var u;
    try { u = new URL(tok); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    var host = u.hostname.toLowerCase();
    var seg = u.pathname.split('/').filter(Boolean);
    var first = (seg[0] || '').toLowerCase();
    var id = null;
    var list = u.searchParams.get('list');
    var index = parseInt(u.searchParams.get('index') || '0', 10) || 0;
    var timeRaw = u.searchParams.get('t') || u.searchParams.get('start');
    if (!timeRaw && /^#t=/.test(u.hash)) timeRaw = u.hash.slice(3);

    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = seg[0];
    } else if (YT_HOST_RE.test(host)) {
      if (first === 'watch') {
        id = u.searchParams.get('v');
      } else if (first === 'shorts' || first === 'live' || first === 'embed' || first === 'v' || first === 'e') {
        id = seg[1];
      } else if (first === 'playlist') {
        id = null;
      } else if (first === 'attribution_link') {
        var inner = u.searchParams.get('u');
        if (!inner || inner.charAt(0) !== '/' || (depth || 0) > 0) return null;
        return parse('https://www.youtube.com' + inner, 1);
      } else if (!first) {
        id = u.searchParams.get('v');
      } else {
        return null;
      }
    } else {
      return null;
    }

    if (id === 'videoseries') id = null;               // embed/videoseries?list=...
    if (id && !ID_RE.test(id)) id = null;
    if (list && !LIST_RE.test(list)) list = null;
    // Mix/radio (RD...), "assistir mais tarde" (WL) e "curtidos" (LL) nao tocam no player incorporado.
    if (list && (/^RD/.test(list) || list === 'WL' || list === 'LL')) list = null;
    if (!id && !list) return null;

    return build(id, list, toSeconds(timeRaw), index);
  }

  root.LMLink = { parse: parse, toSeconds: toSeconds };
})(typeof window !== 'undefined' ? window : this);
