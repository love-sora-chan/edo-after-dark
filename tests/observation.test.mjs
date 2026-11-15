import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observationQuestions, observationSources, observationArtworkOrder, selectObservationSession, shuffled } from '../src/data/observation.ts';
import { parseObservationSnapshot, observationVersion } from '../src/lib/observation-session.ts';
import { quizQuestions, scoreQuiz, roleIds } from '../src/data/activities.ts';

const artworks = JSON.parse(readFileSync(new URL('../src/data/artworks.json', import.meta.url), 'utf8'));
const byId = new Map(observationQuestions.map((q) => [q.id, q]));
function generator(seed) {
  return () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

test('all eleven exhibition works have multiple sourced, usable questions', () => {
  assert.equal(observationQuestions.length, 26);
  assert.equal(byId.size, observationQuestions.length);
  assert.deepEqual([...observationArtworkOrder].sort(), artworks.map((a) => a.id).sort());
  for (const artwork of artworks) {
    assert.ok(observationQuestions.filter((q) => q.artworkId === artwork.id).length >= 2, artwork.id);
  }
  for (const q of observationQuestions) {
    assert.ok(artworks.find((a) => a.id === q.artworkId)?.image, q.id);
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length, q.id);
    assert.ok(q.focus.x >= 0 && q.focus.x <= 1 && q.focus.y >= 0 && q.focus.y <= 1 && q.focus.scale >= 1, q.id);
    assert.ok(q.evidence.some((e) => e.sources.length > 0), q.id);
    for (const evidence of q.evidence) for (const source of evidence.sources) {
      assert.ok(observationSources[source]?.scope, q.id + ': ' + source);
      assert.equal(new URL(observationSources[source].url).protocol, 'https:');
    }
  }
});

test('complete and single-painting routes retain all questions in context', () => {
  const full = selectObservationSession('full');
  assert.equal(new Set(full).size, 26);
  assert.equal(full[0], observationQuestions.find((q) => q.artworkId === 'B03').id);
  for (const id of observationArtworkOrder) {
    assert.deepEqual(selectObservationSession('painting', id), observationQuestions.filter((q) => q.artworkId === id).map((q) => q.id));
  }
});

test('random routes cover exactly three paintings, two unique questions each, grouped with an introduction', () => {
  const sessions = new Set();
  for (let seed = 1; seed <= 100; seed++) {
    const session = selectObservationSession('random', 'A03', generator(seed));
    sessions.add(session.join(','));
    assert.equal(session.length, 6);
    assert.equal(new Set(session).size, 6);
    assert.equal(new Set(session.map((id) => byId.get(id).artworkId)).size, 3);
    for (let i = 0; i < session.length; i += 2) {
      const first = byId.get(session[i]);
      assert.equal(byId.get(session[i + 1]).artworkId, first.artworkId);
      assert.equal(first.id, observationQuestions.find((q) => q.artworkId === first.artworkId).id);
    }
  }
  assert.ok(sessions.size > 20, 'replays should produce varied sessions');
});

test('shuffling answer display order preserves answer identities and does not mutate data', () => {
  for (const q of observationQuestions) {
    const options = q.choices.map((text, id) => ({ text, id }));
    const original = structuredClone(options);
    const display = shuffled(options, generator(67));
    assert.deepEqual(options, original);
    assert.equal(display.find((option) => option.id === q.answer).text, q.choices[q.answer]);
    assert.deepEqual(display.map((option) => option.id).sort(), options.map((option) => option.id).sort());
  }
});

test('each revised question has distinct option feedback and valid viewing/reading targets', () => {
  for (const q of observationQuestions) {
    assert.equal(q.choices.length, 3, q.id);
    assert.equal(new Set(q.choices).size, 3, q.id);
    assert.equal(q.feedback.length, 3, q.id);
    assert.equal(q.feedback[q.answer], '', q.id);
    assert.equal(new Set(q.feedback.filter(Boolean)).size, 2, q.id);
    for (const [index, message] of q.feedback.entries()) if (index !== q.answer) {
      assert.ok(message.length > 12, q.id);
      assert.ok(!message.includes(q.choices[q.answer]), q.id + ' must guide rather than repeat the correct choice');
    }
    for (const focus of q.focuses ?? [q.focus]) {
      assert.ok(focus.x >= 0 && focus.x <= 1 && focus.y >= 0 && focus.y <= 1 && focus.scale >= 1 && focus.scale <= 5, q.id);
    }
    for (const id of q.readingArtworkIds ?? [q.artworkId]) assert.ok(artworks.some(a => a.id === id && a.sections.observe && a.sections.people), q.id);
    if (q.compareArtworkId) {
      assert.ok(q.readingArtworkIds.includes(q.compareArtworkId), q.id);
      assert.ok(artworks.some(a => a.id === q.compareArtworkId && a.image), q.id);
    }
  }
  assert.equal(byId.get('suruga-brand').phase, '延伸');
});

const snapshot = () => {
  const session = selectObservationSession('painting', 'A05');
  const first = byId.get(session[0]);
  return {version: observationVersion, mode: 'painting', painting: 'A05', session, index: 1,
    outcomes: {[first.id]: 'answered'}, answers: {[first.id]: first.answer},
    notes: {[first.id]: '餐具的位置改變了我對空房間的看法。\n<script>文字應原樣顯示</script>'}, view: 'play'};
};

test('saved progress restores route, answer identities and unmodified optional notes', () => {
  const value = snapshot();
  assert.deepEqual(parseObservationSnapshot(JSON.stringify(value)), value);
  const id = value.session[1];
  value.outcomes[id] = 'skipped'; value.view = 'notebook';
  assert.deepEqual(parseObservationSnapshot(JSON.stringify(value)), value);
});

test('stale, corrupt, forged or incomplete progress is rejected safely', () => {
  assert.equal(parseObservationSnapshot('{'), null);
  assert.equal(parseObservationSnapshot(null), null);
  const cases = [
    value => {value.version = 'old';},
    value => {value.index = 20;},
    value => {value.session[1] = value.session[0];},
    value => {value.session[1] = 'unknown';},
    value => {value.answers[value.session[0]] = (value.answers[value.session[0]] + 1) % 3;},
    value => {value.notes[value.session[0]] = '字'.repeat(2001);},
    value => {value.notes[value.session[1]] = '尚未作答';},
    value => {value.outcomes = {};},
    value => {value.view = 'notebook';},
    value => {value.mode = 'full';},
    value => {value.outcomes.unknown = 'answered';},
  ];
  for (const mutate of cases) {
    const value = snapshot(); mutate(value);
    assert.equal(parseObservationSnapshot(JSON.stringify(value)), null);
  }
});

test('random progress validates all three groups and keeps extension works out of the short route', () => {
  const session = selectObservationSession('random', 'A03', generator(41));
  const value = {...snapshot(), mode: 'random', session, index: 0, outcomes: {}, answers: {}, notes: {}};
  assert.deepEqual(parseObservationSnapshot(JSON.stringify(value)), value);
  assert.ok(session.every(id => byId.get(id).artworkId.startsWith('A')));
  [value.session[1], value.session[2]] = [value.session[2], value.session[1]];
  assert.equal(parseObservationSnapshot(JSON.stringify(value)), null);
});

test('four scenario quiz keeps all viewing approaches available and handles ties', () => {
  assert.equal(quizQuestions.length, 4);
  for (const q of quizQuestions) assert.deepEqual(q.choices.map(c => c.role).sort(), [...roleIds].sort());
  assert.deepEqual(scoreQuiz(roleIds).winners, [...roleIds]);
  assert.deepEqual(scoreQuiz(['night-workers', 'night-workers', 'merchants', null]).winners, ['night-workers']);
});
