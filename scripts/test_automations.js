const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { VayuAutomations, editDistance } = require('../vayu_automations.js');

// isolated data dir so the test never touches the real config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vayu-auto-test-'));

const calls = { dashboard: 0, caveSends: [] };
const auto = new VayuAutomations({
  dataDir: tmpDir,
  log: () => {},
  actions: { open_dashboard: () => { calls.dashboard += 1; } },
  caveLink: { sendToAgent: async (agent, message) => { calls.caveSends.push({ agent, message }); return { routed: true }; } },
}).init();

(async () => {
  // 1. default config seeded, contacts present
  assert.ok(fs.existsSync(path.join(tmpDir, 'automations.yaml')), 'default config seeded');
  assert.ok(auto.config.routes.length >= 3, 'default routes loaded (open vayu / tell an agent / done sound)');
  assert.ok(Object.keys(auto.config.contacts).length >= 2, 'default contacts loaded');

  // 2. "open vayu" command -> dashboard action, consumed (dictation punctuation tolerated)
  let v = await auto.handle('paste', 'Hey Vayu, open the dashboard.');
  assert.strictEqual(v.consumed, true);
  assert.strictEqual(calls.dashboard, 1);

  // 2b. WAKE-WORD HOMOPHONES — the English-only model can't emit "vayu", so it
  // hears "vite" / "value" / "bayou" etc. The {wake} token must still fire the
  // open-dashboard command for every one of those mis-transcriptions.
  for (const heard of ['Hey Vite, open the dashboard.', 'Value open the dashboard', 'Hey bayou, open the app.', 'Wahoo, open vayu.']) {
    const before = calls.dashboard;
    const r = await auto.handle('paste', heard);
    assert.strictEqual(r.consumed, true, `wake homophone should consume: "${heard}"`);
    assert.strictEqual(calls.dashboard, before + 1, `wake homophone should open dashboard: "${heard}"`);
  }
  // ...and a genuinely different utterance must NOT trip the wake word
  {
    const before = calls.dashboard;
    const r = await auto.handle('paste', 'Please open the dashboard.');
    assert.strictEqual(r.consumed, false, 'non-wake utterance must not fire wake route');
    assert.strictEqual(calls.dashboard, before, 'non-wake utterance must not open dashboard');
  }

  // 3. "tell <agent> <msg>" -> cave.send, agent resolved through the contacts list
  v = await auto.handle('paste', 'Tell Conductor, review the vayu design doc');
  assert.strictEqual(v.consumed, true);
  assert.deepStrictEqual(calls.caveSends[0], { agent: 'conductor', message: 'review the vayu design doc' });

  // 4. plain dictation matches nothing -> not consumed (gets pasted)
  v = await auto.handle('paste', 'Hello testing the new app.');
  assert.strictEqual(v.consumed, false);
  assert.strictEqual(v.route, null);

  // 5. finals don't match paste-only routes
  v = await auto.handle('final', 'Hey Vayu, open the dashboard.');
  assert.strictEqual(v.consumed, false);

  // 6. HARDENING — a known alias (a real mis-transcription) resolves to the
  // same canonical contact, exact alias match, not fuzzy
  v = await auto.handle('paste', 'Tell conducter, ship the release');
  assert.strictEqual(v.consumed, true);
  assert.deepStrictEqual(calls.caveSends[1], { agent: 'conductor', message: 'ship the release' });

  // 7. HARDENING — a typo NOT in the alias list resolves via fuzzy matching
  v = await auto.handle('paste', 'Tell conductorr, check the logs');
  assert.strictEqual(v.consumed, true);
  assert.deepStrictEqual(calls.caveSends[2], { agent: 'conductor', message: 'check the logs' });

  // 8. HARDENING — an unrelated/unknown name fails SAFE: does not dispatch,
  // does not consume (so the raw utterance still gets pasted as plain text)
  const sendsBefore = calls.caveSends.length;
  v = await auto.handle('paste', 'Tell submarine, dive now');
  assert.strictEqual(v.consumed, false, 'unknown contact must not consume');
  assert.strictEqual(calls.caveSends.length, sendsBefore, 'unknown contact must not dispatch');

  // 9. play_sound action — a real, system-agnostic local action (no CAVE
  // involved at all). Exercise it for real against a real macOS system sound.
  v = await auto.handle('final', 'done.');
  assert.strictEqual(v.consumed, true);
  assert.strictEqual(v.route, 'done sound');

  // 10. addContactAlias persists a new nickname and it's immediately usable
  const addResult = auto.addContactAlias('conductor', 'boss');
  assert.strictEqual(addResult.ok, true);
  assert.ok(addResult.contacts.conductor.includes('boss'), 'new alias present in returned contacts');
  const onDisk = fs.readFileSync(path.join(tmpDir, 'automations.yaml'), 'utf8');
  assert.ok(onDisk.includes('boss'), 'new alias persisted to disk');
  v = await auto.handle('paste', 'Tell boss, standup at 10');
  assert.strictEqual(v.consumed, true);
  assert.deepStrictEqual(calls.caveSends[3], { agent: 'conductor', message: 'standup at 10' });

  // 11. editDistance sanity (used by the fuzzy matcher)
  assert.strictEqual(editDistance('conductor', 'conductor'), 0);
  assert.strictEqual(editDistance('conductor', 'conductorr'), 1);
  assert.strictEqual(editDistance('', 'abc'), 3);

  // 12. hot-reload with a completely custom config (routes + contacts) still works
  fs.writeFileSync(path.join(tmpDir, 'automations.yaml'), `
contacts:
  scribe:
    - scribe
routes:
  - name: live marker
    match: "^note to self[,:]? (?<note>.+)$"
    on: final
    action: cave.send
    args: { agent: "scribe", message: "{note}" }
`);
  auto.load();
  v = await auto.handle('final', 'Note to self: buy more RAM');
  assert.strictEqual(v.consumed, false); // no consume flag on this route
  assert.deepStrictEqual(calls.caveSends[4], { agent: 'scribe', message: 'buy more RAM' });

  // (reset to a vocabulary-carrying config — test 12 left a minimal one)
  fs.writeFileSync(path.join(tmpDir, 'automations.yaml'), `
wake: [vayu, vite, value]
bias: [Vayu, CAVE]
corrections:
  onionmorph: [onion morph, union morph]
routes:
  - name: flag bad translation
    match: "^{wake},? (?:bad|wrong)(?: (?:translation|transcription|term|word))?[,:]? (?<term>.+?)[.!?]*$"
    on: paste
    action: flag_bad_term
    args: { term: "{term}" }
    consume: true
  - name: correct a term by spelling
    match: "^{wake},? (?:correct|fix|change)[,:]? (?<from>.+?) (?:to|as|into|with) letters?[,:]? (?<spelled>.+?)(?: stop)?[.!?]*$"
    on: paste
    action: add_correction_spelled
    args: { from: "{from}", spelled: "{spelled}" }
    consume: true
  - name: correct a term
    match: "^{wake},? (?:correct|fix|change)[,:]? (?<from>.+?) (?:to|as|into|with) (?<to>.+?)[.!?]*$"
    on: paste
    action: add_correction
    args: { from: "{from}", to: "{to}" }
    consume: true
  - name: open vayu
    match: "^(hey,? )?{wake},? open( the)?( dashboard| app| vayu)?[.!]?$"
    on: paste
    action: open_dashboard
    consume: true
`);
  auto.load();

  // 13. VOCABULARY — corrections rewrite a misheard term and report the fixed
  // word span (for juice). Multiword mishearing collapses to one word.
  {
    const r = auto.applyCorrections('please open onion morph now');
    assert.strictEqual(r.text, 'please open onionmorph now', 'multiword correction applied');
    assert.strictEqual(r.spans.length, 1, 'one correction span reported');
    assert.deepStrictEqual([r.spans[0].wordStart, r.spans[0].wordEnd], [2, 2], 'span points at the fixed word');
    assert.strictEqual(r.spans[0].to, 'onionmorph');
  }
  // case is carried from the heard form onto the intended word
  assert.strictEqual(auto.applyCorrections('Onion Morph rocks').text, 'Onionmorph rocks', 'title-case preserved');
  // no correction -> text unchanged, no spans
  assert.deepStrictEqual(auto.applyCorrections('nothing to fix here'), { text: 'nothing to fix here', spans: [] });

  // 14. SPOKEN "vayu bad translation X" -> flagged to jsonl, consumed (ablated)
  {
    const r = await auto.handle('paste', 'Vite bad translation onion morph');
    assert.strictEqual(r.consumed, true, 'bad-translation command is consumed (ablated, not pasted)');
    assert.strictEqual(r.action, 'flag_bad_term');
    const flagged = auto.getBadTerms();
    assert.ok(flagged.some((e) => e.heard === 'onion morph'), 'term appended to bad_terms.jsonl');
  }

  // 15. SPOKEN "vayu correct X to Y" -> persists a correction, immediately live
  {
    const r = await auto.handle('paste', 'Value correct see ave to CAVE');
    assert.strictEqual(r.consumed, true, 'correct command consumed');
    assert.strictEqual(r.action, 'add_correction');
    assert.ok(auto.config.corrections.CAVE, 'new correction key persisted');
    // and it now rewrites transcripts
    assert.strictEqual(auto.applyCorrections('tell see ave to run').text, 'tell CAVE to run');
  }

  // 15b. SPELL-OUT — "vayu correct <heard> to letters ... stop" assembles the
  // intended word letter-by-letter (tiny.en can't say it, but CAN say letters).
  {
    const r = await auto.handle('paste', 'Value correct onion more to letters O N I O N M O R P H stop');
    assert.strictEqual(r.consumed, true, 'spelled correction consumed');
    assert.strictEqual(r.action, 'add_correction_spelled');
    assert.strictEqual(r.correction.to, 'onionmorph', 'letters assembled into the intended word');
    assert.strictEqual(auto.applyCorrections('open onion more now').text, 'open onionmorph now', 'spelled correction is live');
  }
  // assembler unit checks: letter names, single letters, collapsed run, mixed word
  assert.strictEqual(auto._assembleSpelledWord('C A V E'), 'cave');
  assert.strictEqual(auto._assembleSpelledWord('see ay vee ee'), 'cave');
  assert.strictEqual(auto._assembleSpelledWord('o n i o n morph'), 'onionmorph');
  assert.strictEqual(auto._assembleSpelledWord('a b c stop and more'), 'abc', 'stop terminates assembly');

  // 16. a real command reports its matched span back for juicing
  {
    calls.dashboard = 0;
    const r = await auto.handle('paste', 'Hey Vayu, open the dashboard.');
    assert.strictEqual(r.consumed, true);
    assert.ok(r.match && typeof r.match.text === 'string', 'command match span returned for juice');
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('Automation classifier tests passed (contacts, fuzzy matching, fail-safe, play_sound, alias persistence, wake homophones, corrections, bad-term flag, spoken correct)');
  process.exit(0); // the config fs.watch keeps the loop alive; tests are done
})().catch(e => { console.error(e); process.exit(1); });
