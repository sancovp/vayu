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

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('Automation classifier tests passed (contacts, fuzzy matching, fail-safe, play_sound, alias persistence)');
  process.exit(0); // the config fs.watch keeps the loop alive; tests are done
})().catch(e => { console.error(e); process.exit(1); });
