/**
 * VayuAutomations — a system-agnostic YAML hook table: trigger pattern -> action.
 *
 * "System agnostic" means the trigger/action surface does NOT assume CAVE.
 * `cave.send` is just one of several action kinds; `play_sound`/`shell`/`http`
 * are plain local actions with no agent runtime involved at all. CAVE, when
 * present, is one consumer of this table — not the reason it exists.
 *
 * Route schema (automations.yaml):
 *   routes:
 *     - name: tell an agent
 *       match: "^tell (?<agent>[a-z0-9_-]+)[,:]? (?<msg>.+)$"   # regex, case-insensitive
 *       on: paste            # paste (default) = full utterance | final = per closed segment
 *       action: cave.send    # cave.send | open_dashboard | play_sound | shell | http
 *       args: { agent: "{agent}", message: "{msg}" }            # {group} substitution
 *       consume: true        # matched utterance is a COMMAND — not pasted
 *
 * First match wins, top to bottom.
 *
 * Contacts (automations.yaml):
 *   contacts:
 *     conductor: [conductor, conducter, the conductor]   # canonical: [aliases/nicknames]
 *   Any route arg named "agent" (or "contact") is resolved through this list
 *   before dispatch: exact alias match -> fuzzy match (typo-tolerant) -> fail
 *   safe (does NOT fire, does NOT consume, so the utterance still pastes as
 *   plain text instead of silently vanishing into a bad dispatch).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const yaml = require('js-yaml');

// The wake word "vayu" is out-of-vocabulary for the whisperflow_clone server's
// English-only `tiny.en` model — it CANNOT emit "vayu", it snaps the sound to
// the nearest real English word ("vite", "value", "bayou", "via"...). So a
// route that matches the literal token "vayu" never fires. Instead, routes use
// the `{wake}` placeholder, which compiles to an alternation over every form
// tiny.en actually produces for /ˈvɑːjuː/. Extend it via `wake:` in the yaml.
const DEFAULT_WAKE = [
  'vayu', 'vayou', 'vayoo', 'vaya', 'vayo',
  'vite', 'value', 'bayou', 'via',
  'veyu', 'viyu', 'veo', 'vio', 'vaio', 'veja',
  'wayu', 'wahoo', 'vahoo',
  'buy you', 'by you', 'why you', 'oh you',
];

const DEFAULT_CONFIG = `# Vayu automations — hot-reloaded on save.
# A system-agnostic hook table: trigger pattern -> action. CAVE is just one
# possible action (cave.send); play_sound/shell/http need no agent runtime.

cave:
  base_url: "http://localhost:8765"
  enabled: true

# The wake word. The local whisper model is English-only (tiny.en) and never
# actually transcribes "vayu" — it hears the nearest real word ("vite",
# "value", "bayou", ...). Routes below use the {wake} token, which expands to
# an alternation over ALL of these accepted spoken/mis-transcribed forms. If
# your voice trips a form not listed here, just add a line.
wake:
  - vayu
  - vite
  - value
  - bayou
  - via
  - vayou
  - wahoo

# Vocabulary bias — proper nouns / jargon the recognizer keeps missing. These
# are (a) protected from being rewritten by corrections and (b) surfaced to the
# transcription server as hotword bias where supported. Add your names here.
bias:
  - Vayu
  - CAVE
  - onionmorph

# Corrections — misheard -> intended, applied to the transcript AFTER
# recognition (word-boundary, case-preserving, longest-match wins). This is the
# reliable in-app vocabulary fix: tiny.en can't say "onionmorph", so teach Vayu
# what it says instead. Grows via "vayu correct <heard> to <intended>" and the
# dashboard highlight-to-flag UI. Shape mirrors contacts: canonical -> [heard].
corrections:
  onionmorph:
    - onion morph
    - union morph

# Canonical contact name -> aliases/nicknames (what you might actually say,
# including likely mis-transcriptions). Add a nickname by adding a line here.
contacts:
  conductor:
    - conductor
    - conducter
    - the conductor
  researcher:
    - researcher
    - research agent
    - the researcher

routes:
  - name: open vayu
    match: "^(hey,? )?{wake},? open( the)?( dashboard| app| vayu)?[.!]?$"
    on: paste
    action: open_dashboard
    consume: true

  - name: tell an agent
    match: "^tell (the )?(?<agent>[a-zA-Z0-9_-]+)[,:]? (?<msg>.+)$"
    on: paste
    action: cave.send
    args: { agent: "{agent}", message: "{msg}" }
    consume: true

  - name: flag bad translation
    match: "^{wake},? (?:bad|wrong)(?: (?:translation|transcription|term|word))?[,:]? (?<term>.+?)[.!?]*$"
    on: paste
    action: flag_bad_term
    args: { term: "{term}" }
    consume: true

  - name: correct a term
    match: "^{wake},? (?:correct|fix|change)[,:]? (?<from>.+?) (?:to|as|into|with) (?<to>.+?)[.!?]*$"
    on: paste
    action: add_correction
    args: { from: "{from}", to: "{to}" }
    consume: true

  - name: done sound
    match: "^(done|task complete|all done|finished)[.!]?$"
    on: final
    action: play_sound
    args: { sound: "/System/Library/Sounds/Glass.aiff" }
    consume: true
`;

/** Levenshtein edit distance — small, dependency-free, used only for
 * typo-tolerant contact matching (short strings, cheap either way). */
function editDistance(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

class VayuAutomations {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir      where automations.yaml lives
   * @param {function} opts.log        appendRuntimeLog
   * @param {object} opts.actions      { open_dashboard: fn }
   * @param {object} opts.caveLink     CaveLink instance (sendToAgent, listAgents)
   */
  constructor({ dataDir, log, actions, caveLink }) {
    this.configPath = path.join(dataDir, 'automations.yaml');
    this.badTermsPath = path.join(dataDir, 'bad_terms.jsonl'); // append-only flag log
    this.log = log || (() => {});
    this.actions = actions || {};
    this.caveLink = caveLink || null;
    this.config = { cave: {}, contacts: {}, wake: [], bias: [], corrections: {}, routes: [] };
    this._rawDoc = { cave: {}, contacts: {}, routes: [] };
    this._correctionMatchers = []; // [{ intended, re }] longest-first
    this._watchDebounce = null;
    this._liveAgents = {}; // best-effort cache from CAVE's /cave_agents, supplementary only
  }

  init() {
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, DEFAULT_CONFIG);
      this.log(`automations: seeded default config at ${this.configPath}`);
    }
    this.load();
    try {
      fs.watch(this.configPath, () => {
        clearTimeout(this._watchDebounce);
        this._watchDebounce = setTimeout(() => this.load(), 250);
      });
    } catch (e) {
      this.log(`automations: watch failed ${e.message}`);
    }
    this.refreshLiveAgents().catch(() => {});
    return this;
  }

  load() {
    try {
      const raw = yaml.load(fs.readFileSync(this.configPath, 'utf8')) || {};
      // The accepted spoken forms of the wake word (canonical "vayu" + every
      // form tiny.en actually emits for it). yaml `wake:` overrides the default.
      const wake = (Array.isArray(raw.wake) && raw.wake.length) ? raw.wake : DEFAULT_WAKE;
      const wakeAlternation = this._buildWakeAlternation(wake);
      const routes = (raw.routes || []).map((r, i) => {
        try {
          // Expand the {wake} placeholder to the homophone alternation before
          // compiling, so a route never has to hardcode "vayu" (which the
          // English-only model can't produce).
          const pattern = String(r.match).replace(/\{wake\}/g, wakeAlternation);
          return { ...r, _re: new RegExp(pattern, 'i') };
        } catch (e) {
          this.log(`automations: bad regex in route ${r.name || i}: ${e.message}`);
          return null;
        }
      }).filter(Boolean);
      const bias = Array.isArray(raw.bias) ? raw.bias.map((b) => String(b)) : [];
      const corrections = (raw.corrections && typeof raw.corrections === 'object') ? raw.corrections : {};
      this._correctionMatchers = this._buildCorrectionMatchers(corrections);
      this._rawDoc = raw;
      this.config = { cave: raw.cave || {}, contacts: raw.contacts || {}, wake, bias, corrections, routes };
      this.log(`automations: loaded ${routes.length} routes, ${Object.keys(this.config.contacts).length} contacts, ${wake.length} wake forms, ${Object.keys(corrections).length} corrections, ${bias.length} bias terms (cave ${this.config.cave.enabled ? 'enabled' : 'disabled'})`);
    } catch (e) {
      this.log(`automations: config load failed ${e.message}`);
    }
  }

  /** Compile the corrections map (intended -> [heard forms]) into ordered
   * word-boundary regex matchers, longest heard-form first so a multiword
   * mishearing ("onion morph") wins over any single-word one. */
  _buildCorrectionMatchers(corrections) {
    const rows = [];
    for (const [intended, heardForms] of Object.entries(corrections || {})) {
      for (const heard of (Array.isArray(heardForms) ? heardForms : [heardForms])) {
        const term = String(heard || '').trim();
        if (!term) continue;
        rows.push({ intended: String(intended), heard: term });
      }
    }
    rows.sort((a, b) => b.heard.length - a.heard.length);
    return rows.map(({ intended, heard }) => {
      const esc = heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return { intended, re: new RegExp(`\\b${esc}\\b`, 'gi') };
    });
  }

  /** Build a non-capturing regex alternation from the wake-word forms, longest
   * first (so "value" wins over a hypothetical "val"), each escaped. */
  _buildWakeAlternation(forms) {
    const escaped = [...new Set(forms.map((f) => String(f).trim().toLowerCase()).filter(Boolean))]
      .sort((a, b) => b.length - a.length)
      .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return escaped.length ? `(?:${escaped.join('|')})` : 'vayu';
  }

  /** Best-effort refresh of CAVE's live agent registry. Supplementary only —
   * the yaml `contacts:` list is the primary, always-available source. */
  async refreshLiveAgents() {
    if (!this.caveLink || typeof this.caveLink.listAgents !== 'function') return;
    try {
      this._liveAgents = await this.caveLink.listAgents();
      const n = Object.keys(this._liveAgents).length;
      if (n) this.log(`automations: refreshed ${n} live CAVE agent(s)`);
    } catch (e) {
      this.log(`automations: refreshLiveAgents failed ${e.message}`);
    }
  }

  /**
   * Resolve a raw spoken/transcribed name to a canonical contact id.
   * Order: exact alias match -> live-CAVE exact match -> fuzzy (typo-tolerant)
   * match against all known aliases+live agents. Returns null (fail-safe,
   * caller must not dispatch) if nothing resolves with confidence.
   */
  resolveContact(rawName) {
    const clean = String(rawName || '').trim().toLowerCase();
    if (!clean) return null;

    // 1. Exact alias match against the yaml contacts list.
    for (const [canonical, aliases] of Object.entries(this.config.contacts)) {
      const all = [canonical, ...(aliases || [])].map((a) => String(a).toLowerCase());
      if (all.includes(clean)) return canonical;
    }

    // 2. Exact match against CAVE's live registry (if reachable).
    const liveNames = Object.keys(this._liveAgents);
    if (liveNames.some((n) => n.toLowerCase() === clean)) {
      return liveNames.find((n) => n.toLowerCase() === clean);
    }

    // 3. Fuzzy match — typo tolerance for ASR mishearings (e.g. "conducter").
    // Candidate pool = every alias + every live agent name. Accept the
    // closest candidate only if it's a SMALL edit relative to word length
    // (avoids matching wildly different short words to each other).
    const candidates = [];
    for (const [canonical, aliases] of Object.entries(this.config.contacts)) {
      for (const a of [canonical, ...(aliases || [])]) candidates.push({ canonical, term: String(a).toLowerCase() });
    }
    for (const n of liveNames) candidates.push({ canonical: n, term: n.toLowerCase() });

    let best = null;
    for (const c of candidates) {
      const dist = editDistance(clean, c.term);
      const threshold = Math.max(1, Math.floor(c.term.length * 0.25)); // ~25% of term length
      if (dist <= threshold && (!best || dist < best.dist)) {
        best = { canonical: c.canonical, dist };
      }
    }
    if (best) {
      this.log(`automations: fuzzy-resolved "${clean}" -> "${best.canonical}" (edit distance ${best.dist})`);
      return best.canonical;
    }

    return null;
  }

  /** Add a nickname/alias for a contact and persist it to automations.yaml.
   * Creates the contact if it doesn't exist yet. Used by the Settings UI. */
  addContactAlias(canonical, alias) {
    const key = String(canonical || '').trim().toLowerCase();
    const term = String(alias || '').trim().toLowerCase();
    if (!key || !term) return { ok: false, error: 'canonical and alias are both required' };

    const doc = yaml.load(fs.readFileSync(this.configPath, 'utf8')) || {};
    doc.contacts = doc.contacts || {};
    doc.contacts[key] = doc.contacts[key] || [key];
    if (!doc.contacts[key].map((a) => String(a).toLowerCase()).includes(term)) {
      doc.contacts[key].push(term);
    }
    fs.writeFileSync(this.configPath, yaml.dump(doc, { lineWidth: -1 }));
    this.log(`automations: added alias "${term}" -> contact "${key}"`);
    // fs.watch will pick this up and reload, but reload synchronously too so
    // an immediate follow-up call sees the change without waiting on the
    // debounce.
    this.load();
    return { ok: true, contacts: this.config.contacts };
  }

  /** Apply the corrections dictionary to a finished transcript. Returns the
   * rewritten text plus the WORD-index spans that changed, so the renderer can
   * highlight/juice each fix. Non-destructive: recognition text in, clean text
   * out — the {wake} command layer is separate (it runs on raw text). */
  applyCorrections(text) {
    const src = String(text || '');
    if (!src || !this._correctionMatchers.length) return { text: src, spans: [] };

    // 1. Collect every match across all matchers over the ORIGINAL text.
    const hits = [];
    for (const { intended, re } of this._correctionMatchers) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length, from: m[0], intended });
        if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width
      }
    }
    if (!hits.length) return { text: src, spans: [] };

    // 2. Resolve overlaps: earliest start wins, then longest match.
    hits.sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
    const kept = [];
    let cursor = -1;
    for (const h of hits) {
      if (h.start >= cursor) { kept.push(h); cursor = h.end; }
    }

    // 3. Rebuild the string, preserving the capitalisation of the heard form,
    //    and record each replacement's span in FINAL-text word coordinates.
    let out = '';
    let last = 0;
    const spans = [];
    for (const h of kept) {
      out += src.slice(last, h.start);
      const to = this._matchCase(h.from, h.intended);
      const wordStart = this._wordIndexAt(out); // words before this point
      out += to;
      const wordEnd = wordStart + to.trim().split(/\s+/).length - 1;
      spans.push({ wordStart, wordEnd, from: h.from, to });
      last = h.end;
    }
    out += src.slice(last);
    return { text: out, spans };
  }

  /** Count how many whole words precede the given (end-of-string) build point. */
  _wordIndexAt(prefix) {
    const t = prefix.replace(/\s+$/, '');
    return t ? t.split(/\s+/).length : 0;
  }

  /** Carry the heard form's casing onto the intended word (ALLCAPS / Title / as-is). */
  _matchCase(from, intended) {
    if (from && from === from.toUpperCase() && from !== from.toLowerCase()) return intended.toUpperCase();
    if (from && from[0] === from[0].toUpperCase()) return intended.charAt(0).toUpperCase() + intended.slice(1);
    return intended;
  }

  /** Flag a mis-transcribed term for later resolution. Append-only jsonl so a
   * flood of flags can never corrupt the human-tuned yaml. This is the ablate
   * path: the spoken "vayu bad translation X" is consumed (never pasted), X is
   * logged, and you (or Claude) later turn it into a bias/correction entry. */
  flagBadTerm(term, context) {
    const clean = String(term || '').trim();
    if (!clean) return { ok: false, error: 'empty term' };
    const entry = { heard: clean, context: String(context || '').trim(), at: new Date().toISOString() };
    try {
      fs.appendFileSync(this.badTermsPath, JSON.stringify(entry) + '\n');
      this.log(`automations: flagged bad term "${clean}" -> ${this.badTermsPath}`);
      return { ok: true, entry };
    } catch (e) {
      this.log(`automations: flagBadTerm failed ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /** Read back the flagged (still-unresolved) bad terms. */
  getBadTerms() {
    try {
      if (!fs.existsSync(this.badTermsPath)) return [];
      return fs.readFileSync(this.badTermsPath, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  /** Add a correction (heard -> intended) and persist it. Creates the intended
   * entry if new. Mirrors addContactAlias. Used by the spoken "correct X to Y"
   * command and the dashboard highlight-to-fix UI. */
  addCorrection(intended, heard) {
    const key = String(intended || '').trim();
    const term = String(heard || '').trim().toLowerCase();
    if (!key || !term) return { ok: false, error: 'intended and heard are both required' };

    const doc = yaml.load(fs.readFileSync(this.configPath, 'utf8')) || {};
    doc.corrections = doc.corrections || {};
    doc.corrections[key] = doc.corrections[key] || [];
    if (!doc.corrections[key].map((a) => String(a).toLowerCase()).includes(term)) {
      doc.corrections[key].push(term);
    }
    fs.writeFileSync(this.configPath, yaml.dump(doc, { lineWidth: -1 }));
    this.log(`automations: added correction "${term}" -> "${key}"`);
    this.load();
    return { ok: true, corrections: this.config.corrections };
  }

  /** Bias terms surfaced to the recognizer / protected from correction. */
  getBias() {
    return this.config.bias || [];
  }

  /** Full vocabulary view for the dashboard UI. */
  getVocabulary() {
    return { bias: this.getBias(), corrections: this.config.corrections || {}, badTerms: this.getBadTerms() };
  }

  getContacts() {
    return this.config.contacts;
  }

  getRoutes() {
    return this.config.routes.map((r) => ({
      name: r.name, match: r.match, on: r.on || 'paste', action: r.action, consume: !!r.consume,
    }));
  }

  /** First route whose regex matches and whose `on` covers this kind. */
  classify(kind, text) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    for (const route of this.config.routes) {
      const routeOn = route.on || 'paste';
      if (routeOn !== kind) continue;
      route._re.lastIndex = 0;
      const m = route._re.exec(clean);
      if (m) return { route, groups: m.groups || {}, match: { text: m[0], index: m.index } };
    }
    return null;
  }

  _subst(template, groups, text) {
    return String(template)
      .replace(/\{text\}/g, text)
      .replace(/\{(\w+)\}/g, (_, k) => (groups[k] !== undefined ? groups[k] : `{${k}}`));
  }

  /**
   * Classify + dispatch an utterance. Returns { consumed, route } —
   * consumed=true means the caller must NOT paste (it was a command).
   */
  async handle(kind, text) {
    const hit = this.classify(kind, text);
    if (!hit) return { consumed: false, route: null };

    const { route, groups, match } = hit;
    const args = {};
    for (const [k, v] of Object.entries(route.args || {})) {
      args[k] = this._subst(v, groups, text);
    }
    this.log(`automations: route "${route.name}" matched (${kind}) action=${route.action}`);
    // match info travels back so the renderer can juice the matched span.
    const verdict = { consumed: !!route.consume, route: route.name, action: route.action, match };

    try {
      if (route.action === 'open_dashboard' && this.actions.open_dashboard) {
        this.actions.open_dashboard();
      } else if (route.action === 'flag_bad_term') {
        const res = this.flagBadTerm(args.term, text);
        return { ...verdict, badTerm: res.entry, error: res.ok ? undefined : res.error };
      } else if (route.action === 'add_correction') {
        const res = this.addCorrection(args.to, args.from);
        return { ...verdict, correction: { from: args.from, to: args.to }, error: res.ok ? undefined : res.error };
      } else if (route.action === 'cave.send' && this.caveLink) {
        const resolved = this.resolveContact(args.agent);
        if (!resolved) {
          this.log(`automations: route "${route.name}" — unknown contact "${args.agent}", not dispatching (fail-safe)`);
          return { consumed: false, route: route.name, error: `unknown contact "${args.agent}"` };
        }
        verdict.agent = resolved;
        await this.caveLink.sendToAgent(resolved, args.message || text);
      } else if (route.action === 'play_sound' && route.args && route.args.sound) {
        const soundPath = this._subst(route.args.sound, groups, text);
        execFile('afplay', [soundPath], (err) => {
          if (err) this.log(`automations: play_sound "${route.name}" failed ${err.message}`);
        });
      } else if (route.action === 'shell' && route.command) {
        const cmd = this._subst(route.command, groups, text);
        execFile('/bin/sh', ['-c', cmd], (err) => {
          if (err) this.log(`automations: shell "${route.name}" failed ${err.message}`);
        });
      } else if (route.action === 'http' && args.url) {
        fetch(args.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, kind, route: route.name, groups }),
        }).catch(e => this.log(`automations: http "${route.name}" failed ${e.message}`));
      } else {
        this.log(`automations: route "${route.name}" has unknown/unwired action ${route.action}`);
        return { consumed: false, route: route.name };
      }
    } catch (e) {
      this.log(`automations: dispatch "${route.name}" failed ${e.message}`);
      // A failed COMMAND should not silently turn into pasted text
      return { ...verdict, error: e.message };
    }

    return verdict;
  }
}

module.exports = { VayuAutomations, editDistance };
