const assert = require('assert');
const { VayuCore, assembleSpelledWord } = require('./vayu_core.js');

const config = {
  wake: ['vayu', 'vite', 'value', 'bayou'],
  corrections: { onionmorph: ['onion morph', 'union morph'], CAVE: ['see ave'] },
  routes: [
    { name: 'open', match: '^(hey,? )?{wake},? open( the)?( dashboard| app)?[.!]?$', on: 'paste', action: 'open_dashboard', consume: true },
    { name: 'tell', match: '^tell (the )?(?<agent>[a-z0-9_-]+)[,:]? (?<msg>.+)$', on: 'paste', action: 'cave.send', consume: true },
  ],
};

const core = new VayuCore(config);

// wake homophones classify the open command
for (const t of ['Hey Vite, open the dashboard.', 'Value open the app', 'bayou open']) {
  const hit = core.classify('paste', t);
  assert.ok(hit && hit.route.name === 'open', `wake homophone matches: "${t}"`);
  assert.ok(hit.match && hit.match.text, 'match span present');
}
// a non-wake utterance does not match
assert.strictEqual(core.classify('paste', 'please open the app'), null);

// tell command captures groups
const tell = core.classify('paste', 'tell conductor, ship it');
assert.deepStrictEqual({ a: tell.groups.agent, m: tell.groups.msg }, { a: 'conductor', m: 'ship it' });

// corrections rewrite + report spans (multiword collapses, case carried)
let r = core.applyCorrections('please open onion morph now');
assert.strictEqual(r.text, 'please open onionmorph now');
assert.deepStrictEqual([r.spans[0].wordStart, r.spans[0].wordEnd], [2, 2]);
assert.strictEqual(core.applyCorrections('Onion Morph rules').text, 'Onionmorph rules');
assert.strictEqual(core.applyCorrections('tell see ave to run').text, 'tell CAVE to run');
assert.deepStrictEqual(core.applyCorrections('nothing here'), { text: 'nothing here', spans: [] });

// spelled-word assembly
assert.strictEqual(assembleSpelledWord('O N I O N M O R P H'), 'onionmorph');
assert.strictEqual(assembleSpelledWord('see ay vee ee'), 'cave');
assert.strictEqual(assembleSpelledWord('a b c stop x y z'), 'abc');

// live config mutation (add a correction at runtime, as the PWA does)
core.setConfig({ ...config, corrections: { ...config.corrections, vayu: ['vite'] } });
assert.strictEqual(core.applyCorrections('open vite now').text, 'open vayu now');

console.log('vayu_core tests passed (wake, classify, corrections, spelling, live config)');
