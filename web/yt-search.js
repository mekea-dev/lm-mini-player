/*
 * LM Mini Player - pesquisa de videos do YouTube para a lista de resultados do programa.
 *
 * O programa injeta este arquivo numa pagina do YouTube que fica ESCONDIDA (uma janela auxiliar que nunca aparece).
 * Daqui ele pede os resultados ao proprio YouTube, como o navegador faz (mesma origem, mesmos cookies), le a lista
 * de videos e devolve para a tela do programa por mensagem. Nada vai para nenhum outro lugar.
 *
 *   __lmYt.search(seq, texto)   ->  "yres:<seq>:" + JSON { ok, items:[{id,title,channel,dur,views,pub,live}], more }
 *   __lmYt.more(seq, token)     ->  o mesmo, a proxima pagina (token vem em "more")
 *   __lmYt.info(seq, idDoVideo) ->  "yinfo:<seq>:" + JSON { ok, id, title, channel }
 *
 * Se o YouTube mudar o formato da pagina, so este arquivo precisa mudar.
 */
(function () {
  'use strict';

  try {
    if (!window.__lmYtTest) {                        // (so os testes em tests\yt-test.html ligam isto)
      if (window !== window.top) return;
      if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return;
    }
  } catch (e) { return; }
  if (window.__lmYt) return;

  var VID_RE = /^[A-Za-z0-9_-]{11}$/;
  var FILTER_VIDEOS = 'EgIQAQ%253D%253D';       // filtro "Tipo: Video" do YouTube: sem playlists, canais nem carrosseis de Shorts
  var cfg = null;                                // { key, ver, hl, gl }, lido da pagina de resultados

  // o que o programa recebe por baixo dos panos; os testes trocam isto
  var api = {
    post: function (msg) {
      try { if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(msg); } catch (e) { /* ignora */ }
    }
  };

  // ---------- leitura dos dados do YouTube ----------

  function textOf(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map(function (r) { return (r && r.text) || ''; }).join('');
    if (typeof t.content === 'string') return t.content;
    return '';
  }

  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function fromVideoRenderer(v) {
    if (!v || !VID_RE.test(v.videoId || '')) return null;
    var live = false;
    var dur = clean(textOf(v.lengthText));
    (v.thumbnailOverlays || []).forEach(function (o) {
      var s = o && o.thumbnailOverlayTimeStatusRenderer;
      if (!s) return;
      if (s.style === 'LIVE') live = true;
      if (!dur) dur = clean(textOf(s.text));
    });
    (v.badges || []).forEach(function (b) {
      var st = b && b.metadataBadgeRenderer && b.metadataBadgeRenderer.style;
      if (st === 'BADGE_STYLE_TYPE_LIVE_NOW') live = true;
    });
    return {
      id: v.videoId,
      title: clean(textOf(v.title)),
      channel: clean(textOf(v.ownerText) || textOf(v.longBylineText) || textOf(v.shortBylineText)),
      dur: live ? '' : dur,
      views: clean(textOf(v.viewCountText) || textOf(v.shortViewCountText)),
      pub: clean(textOf(v.publishedTimeText)),
      live: live
    };
  }

  // formato novo do YouTube (lockupViewModel) para videos, caso passe a aparecer na pesquisa
  function fromLockup(l) {
    if (!l || l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !VID_RE.test(l.contentId || '')) return null;
    var md = l.metadata && l.metadata.lockupMetadataViewModel;
    var rows = (md && md.metadata && md.metadata.contentMetadataViewModel && md.metadata.contentMetadataViewModel.metadataRows) || [];
    var parts = [];
    rows.forEach(function (r) { (r.metadataParts || []).forEach(function (p) { parts.push(clean(textOf(p.text))); }); });
    var dur = '', live = false;
    var ov = (l.contentImage && l.contentImage.thumbnailViewModel && l.contentImage.thumbnailViewModel.overlays) || [];
    ov.forEach(function (o) {
      var bs = (o && o.thumbnailBottomOverlayViewModel && o.thumbnailBottomOverlayViewModel.badges) || [];
      bs.forEach(function (b) {
        var t = clean(textOf(b && b.thumbnailBadgeViewModel && b.thumbnailBadgeViewModel.text));
        if (t) dur = t;
      });
    });
    return { id: l.contentId, title: clean(textOf(md && md.title)), channel: parts[0] || '', dur: dur, views: parts[1] || '', pub: parts[2] || '', live: live };
  }

  function tokenOf(c) {
    var e = c && c.continuationEndpoint;
    if (!e) return null;
    if (e.continuationCommand && typeof e.continuationCommand.token === 'string') return e.continuationCommand.token;
    var cmds = e.commandExecutorCommand && e.commandExecutorCommand.commands;
    if (Array.isArray(cmds)) {
      for (var i = 0; i < cmds.length; i++) {
        var cc = cmds[i] && cmds[i].continuationCommand;
        if (cc && typeof cc.token === 'string') return cc.token;
      }
    }
    return null;
  }

  // sections = lista de itemSectionRenderer + continuationItemRenderer (primeira pagina ou continuacao)
  function collect(sections) {
    var items = [], token = null, seen = {};
    function add(it) { if (it && it.title && !seen[it.id]) { seen[it.id] = 1; items.push(it); } }
    (sections || []).forEach(function (s) {
      if (!s) return;
      if (s.itemSectionRenderer) {
        (s.itemSectionRenderer.contents || []).forEach(function (c) {
          if (!c) return;
          if (c.videoRenderer) add(fromVideoRenderer(c.videoRenderer));
          else if (c.lockupViewModel) add(fromLockup(c.lockupViewModel));
        });
      } else if (s.continuationItemRenderer) {
        token = tokenOf(s.continuationItemRenderer) || token;
      }
    });
    return { items: items, token: token };
  }

  function firstPageSections(data) {
    try { return data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents; } catch (e) { return null; }
  }

  function continuationSections(resp) {
    try {
      var cmds = resp.onResponseReceivedCommands || [];
      for (var i = 0; i < cmds.length; i++) {
        var a = cmds[i] && (cmds[i].appendContinuationItemsAction || cmds[i].reloadContinuationItemsCommand);
        if (a && a.continuationItems) return a.continuationItems;
      }
    } catch (e) { /* ignora */ }
    return null;
  }

  // o JSON da pagina vem como  var ytInitialData = {...};</script>
  function extractData(html) {
    var i = html.indexOf('ytInitialData = ');
    if (i < 0) return null;
    var start = html.indexOf('{', i);
    var end = html.indexOf(';</script>', start);
    if (start < 0 || end < 0) return null;
    try { return JSON.parse(html.slice(start, end)); } catch (e) { return null; }
  }

  function readCfg(html) {
    function pick(re) { var m = re.exec(html); return m ? m[1] : ''; }
    var key = pick(/"INNERTUBE_API_KEY":"([^"]+)"/);
    var ver = pick(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
    if (!key || !ver) return null;
    return { key: key, ver: ver, hl: pick(/"HL":"([^"]+)"/) || 'pt', gl: pick(/"GL":"([^"]+)"/) || 'BR' };
  }

  // ---------- pedidos ----------

  function getText(url) {
    return fetch(url, { credentials: 'include' }).then(function (r) {
      if (!r.ok) throw new Error('http' + r.status);
      return r.text();
    });
  }

  function runSearch(q) {
    q = String(q || '').trim();
    if (!q) return Promise.resolve({ ok: true, items: [], more: null });
    var hl = (cfg && cfg.hl) || (navigator.language || 'pt-BR');
    return getText('/results?search_query=' + encodeURIComponent(q) + '&sp=' + FILTER_VIDEOS + '&hl=' + encodeURIComponent(hl)).then(function (html) {
      var c = readCfg(html);
      if (c) cfg = c;
      var data = extractData(html);
      var sections = data && firstPageSections(data);
      if (!sections) throw new Error('formato');
      var r = collect(sections);
      return { ok: true, items: r.items, more: r.token };
    });
  }

  function runMore(token) {
    if (!cfg || !token) return Promise.reject(new Error('sem_config'));
    var body = { context: { client: { clientName: 'WEB', clientVersion: cfg.ver, hl: cfg.hl, gl: cfg.gl } }, continuation: token };
    return fetch('/youtubei/v1/search?key=' + encodeURIComponent(cfg.key) + '&prettyPrint=false', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('http' + r.status);
      return r.json();
    }).then(function (j) {
      var sections = continuationSections(j);
      if (!sections) throw new Error('formato');
      var r = collect(sections);
      return { ok: true, items: r.items, more: r.token };
    });
  }

  function runInfo(id) {
    if (!VID_RE.test(String(id || ''))) return Promise.resolve({ ok: false, error: 'id' });
    var u = 'https://www.youtube.com/watch?v=' + id;
    return fetch('/oembed?format=json&url=' + encodeURIComponent(u), { credentials: 'include' }).then(function (r) {
      if (!r.ok) throw new Error('http' + r.status);
      return r.json();
    }).then(function (j) {
      return { ok: true, id: id, title: clean(j && j.title), channel: clean(j && j.author_name) };
    });
  }

  function fail(e) {
    var m = (e && e.message) || 'erro';
    return { ok: false, error: /^http|formato|sem_config/.test(m) ? m : 'rede' };
  }

  function reply(prefix, seq, promise) {
    promise.then(function (p) { return p; }, fail).then(function (p) {
      api.post(prefix + ':' + seq + ':' + JSON.stringify(p));
    });
  }

  window.__lmYt = {
    search: function (seq, q) { reply('yres', seq, runSearch(q)); },
    more: function (seq, token) { reply('yres', seq, runMore(token)); },
    info: function (seq, id) { reply('yinfo', seq, runInfo(id)); },
    _api: api,                       // para testes
    _collect: collect,
    _extractData: extractData,
    _readCfg: readCfg,
    _fromVideo: fromVideoRenderer,
    _fromLockup: fromLockup,
    _run: { search: runSearch, more: runMore, info: runInfo }
  };
})();
