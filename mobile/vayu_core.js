/**
 * VayuCore — the browser-safe classify/correction engine for mobile Vayu.
 *
 * Mirrors the pure algorithms of the desktop `vayu_automations.js` (wake
 * alternation, corrections, spelled-word assembly, route classification) with
 * NO Node deps (no fs / js-yaml / child_process), so it runs in a PWA against
 * the Web Speech transcript. Config is a plain object (embedded default below);
 * dispatch (cave.send / add_correction / flag) is the caller's job.
 *
 * Works in both the browser (window.VayuCore) and node (module.exports) so the
 * same logic is unit-tested under node.
 */
(function (root) {
  const DEFAULT_WAKE = [
    'vayu', 'vayou', 'vayoo', 'vaya', 'vayo', 'vite', 'value', 'bayou', 'via',
    'veyu', 'viyu', 'veo', 'vio', 'vaio', 'veja', 'wayu', 'wahoo', 'vahoo',
  ];

  const LETTER_NAMES = {
    ay: 'a', bee: 'b', be: 'b', cee: 'c', see: 'c', sea: 'c', dee: 'd', ee: 'e',
    ef: 'f', eff: 'f', gee: 'g', jee: 'g', aitch: 'h', haitch: 'h', eye: 'i', ai: 'i',
    jay: 'j', kay: 'k', cay: 'k', el: 'l', ell: 'l', em: 'm', en: 'n', oh: 'o', ow: 'o',
    pee: 'p', pea: 'p', cue: 'q', queue: 'q', kew: 'q', ar: 'r', are: 'r', es: 's', ess: 's',
    tee: 't', tea: 't', yew: 'u', vee: 'v', ex: 'x', eks: 'x', wye: 'y', why: 'y',
    zee: 'z', zed: 'z', dub: 'w', doubleu: 'w',
  };

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function buildWakeAlternation(forms) {
    const escaped = [...new Set((forms || []).map((f) => String(f).trim().toLowerCase()).filter(Boolean))]
      .sort((a, b) => b.length - a.length)
      .map(escapeRe);
    return escaped.length ? `(?:${escaped.join('|')})` : 'vayu';
  }

  function compileRoutes(routes, wakeForms) {
    const alt = buildWakeAlternation(wakeForms && wakeForms.length ? wakeForms : DEFAULT_WAKE);
    return (routes || []).map((r) => {
      try { return { ...r, _re: new RegExp(String(r.match).replace(/\{wake\}/g, alt), 'i') }; }
      catch (e) { return null; }
    }).filter(Boolean);
  }

  function buildCorrectionMatchers(corrections) {
    const rows = [];
    for (const [intended, forms] of Object.entries(corrections || {})) {
      for (const heard of (Array.isArray(forms) ? forms : [forms])) {
        const term = String(heard || '').trim();
        if (term) rows.push({ intended: String(intended), heard: term });
      }
    }
    rows.sort((a, b) => b.heard.length - a.heard.length);
    return rows.map(({ intended, heard }) => ({
      intended,
      re: new RegExp(`\\b${escapeRe(heard).replace(/\\ /g, '\\s+').replace(/ /g, '\\s+')}\\b`, 'gi'),
    }));
  }

  function assembleSpelledWord(spelled) {
    const tokens = String(spelled || '').toLowerCase().replace(/[.,!?]/g, ' ').split(/\s+/).filter(Boolean);
    let out = '';
    for (const t of tokens) {
      if (t === 'stop') break;
      if (LETTER_NAMES[t]) { out += LETTER_NAMES[t]; continue; }
      const cleaned = t.replace(/[^a-z0-9]/g, '');
      if (cleaned) out += cleaned;
    }
    return out;
  }

  function matchCase(from, intended) {
    if (from && from === from.toUpperCase() && from !== from.toLowerCase()) return intended.toUpperCase();
    if (from && from[0] === from[0].toUpperCase()) return intended.charAt(0).toUpperCase() + intended.slice(1);
    return intended;
  }

  function wordIndexAt(prefix) {
    const t = String(prefix).replace(/\s+$/, '');
    return t ? t.split(/\s+/).length : 0;
  }

  class VayuCore {
    constructor(config) {
      this.setConfig(config || {});
    }
    setConfig(config) {
      this.config = { wake: config.wake || DEFAULT_WAKE, corrections: config.corrections || {}, routes: config.routes || [] };
      this._routes = compileRoutes(this.config.routes, this.config.wake);
      this._matchers = buildCorrectionMatchers(this.config.corrections);
      return this;
    }
    // First route whose regex matches for this kind ('paste' | 'final').
    classify(kind, text) {
      const clean = String(text || '').trim();
      if (!clean) return null;
      for (const route of this._routes) {
        if ((route.on || 'paste') !== kind) continue;
        route._re.lastIndex = 0;
        const m = route._re.exec(clean);
        if (m) return { route, groups: m.groups || {}, match: { text: m[0], index: m.index } };
      }
      return null;
    }
    // Rewrite a dictation transcript; returns { text, spans:[{wordStart,wordEnd,from,to}] }.
    applyCorrections(text) {
      const src = String(text || '');
      if (!src || !this._matchers.length) return { text: src, spans: [] };
      const hits = [];
      for (const { intended, re } of this._matchers) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
          hits.push({ start: m.index, end: m.index + m[0].length, from: m[0], intended });
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      }
      if (!hits.length) return { text: src, spans: [] };
      hits.sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
      const kept = [];
      let cursor = -1;
      for (const h of hits) { if (h.start >= cursor) { kept.push(h); cursor = h.end; } }
      let out = '', last = 0;
      const spans = [];
      for (const h of kept) {
        out += src.slice(last, h.start);
        const to = matchCase(h.from, h.intended);
        const wordStart = wordIndexAt(out);
        out += to;
        spans.push({ wordStart, wordEnd: wordStart + to.trim().split(/\s+/).length - 1, from: h.from, to });
        last = h.end;
      }
      out += src.slice(last);
      return { text: out, spans };
    }
    assembleSpelledWord(s) { return assembleSpelledWord(s); }
  }

  const api = { VayuCore, DEFAULT_WAKE, buildWakeAlternation, assembleSpelledWord, buildCorrectionMatchers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VayuCore = api;
})(typeof self !== 'undefined' ? self : this);
