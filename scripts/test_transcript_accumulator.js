const assert = require('assert');

// Mirrors the accumulator in index.html. Server contract (whisperflow_clone
// server.py): every message re-transcribes the ENTIRE current segment buffer,
// so a partial REPLACES the previous partial; is_partial=false closes the
// segment (server flushes its buffer) and the text is committed.

function normalizeTranscriptText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function joinTranscriptParts(committed, partial) {
  if (!committed) return partial;
  if (!partial) return committed;
  return `${committed} ${partial}`;
}

function runSequence(messages) {
  let committedText = '';
  let currentPartial = '';
  let transcribedText = '';

  for (const data of messages) {
    const incoming = normalizeTranscriptText(data.text);
    if (!incoming) continue;

    if (data.is_partial === false) {
      committedText = joinTranscriptParts(committedText, incoming);
      currentPartial = '';
    } else {
      currentPartial = incoming;
    }

    transcribedText = joinTranscriptParts(committedText, currentPartial);
  }

  return transcribedText;
}

// The doubling repro (2026-07-02): Whisper revises the segment prefix as it
// re-transcribes; only the last hypothesis counts.
assert.strictEqual(
  runSequence([
    { is_partial: true, text: 'Help.' },
    { is_partial: true, text: 'Hello testing.' },
    { is_partial: true, text: 'Hello testing the new...' },
    { is_partial: false, text: 'Hello testing the new app.' },
  ]),
  'Hello testing the new app.'
);

// Multi-segment: each final commits, next segment starts fresh.
assert.strictEqual(
  runSequence([
    { is_partial: true, text: 'Hello' },
    { is_partial: true, text: 'Hello world.' },
    { is_partial: false, text: 'Hello world.' },
    { is_partial: true, text: 'This is' },
    { is_partial: true, text: 'This is Vayu.' },
    { is_partial: false, text: 'This is Vayu.' },
  ]),
  'Hello world. This is Vayu.'
);

// Dangling partial at stop time is still included in the paste.
assert.strictEqual(
  runSequence([
    { is_partial: false, text: 'First segment.' },
    { is_partial: true, text: 'second par' },
    { is_partial: true, text: 'second part' },
  ]),
  'First segment. second part'
);

// Empty / whitespace-only messages are ignored.
assert.strictEqual(
  runSequence([
    { is_partial: true, text: '  ' },
    { is_partial: true, text: 'Testing' },
    { is_partial: false, text: 'Testing.' },
    { is_partial: true, text: '' },
  ]),
  'Testing.'
);

console.log('Transcript accumulator tests passed');
