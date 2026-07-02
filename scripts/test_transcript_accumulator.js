const assert = require('assert');

function normalizeTranscriptText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function findSuffixPrefixOverlap(left, right) {
  const max = Math.min(left.length, right.length);
  for (let size = max; size > 0; size--) {
    if (left.slice(-size).toLowerCase() === right.slice(0, size).toLowerCase()) {
      return size;
    }
  }
  return 0;
}

function appendTranscriptWithOverlap(existing, incoming) {
  const current = normalizeTranscriptText(existing);
  const next = normalizeTranscriptText(incoming);

  if (!next) return current;
  if (!current) return next;
  if (next === current) return current;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;

  const overlap = findSuffixPrefixOverlap(current, next);
  const suffix = next.slice(overlap).trim();
  if (!suffix) return current;

  if (/^[.,!?;:]/.test(suffix)) {
    return `${current}${suffix}`;
  }

  return `${current} ${suffix}`;
}

function runSequence(chunks) {
  let text = '';
  let lastIncoming = '';

  for (const chunk of chunks) {
    const incoming = normalizeTranscriptText(chunk);
    if (!incoming) continue;
    if (lastIncoming && lastIncoming.endsWith(incoming)) continue;
    text = appendTranscriptWithOverlap(text, incoming);
    lastIncoming = incoming;
  }

  return text;
}

assert.strictEqual(
  runSequence(['Hello', 'Hello testing', 'testing done.', 'done. works.']),
  'Hello testing done. works.'
);

assert.strictEqual(
  runSequence(['The quick brown', 'brown fox jumps', 'jumps over the lazy dog']),
  'The quick brown fox jumps over the lazy dog'
);

assert.strictEqual(
  runSequence(['Testing', 'Testing', 'Testing.']),
  'Testing.'
);

assert.strictEqual(
  runSequence(['hello', 'lo there', 'there friend']),
  'hello there friend'
);

console.log('Transcript accumulator tests passed');
