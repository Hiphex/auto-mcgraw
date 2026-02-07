const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../lib/shared.js");

test("normalizeComparableText removes prefixes and punctuation noise", () => {
  assert.equal(shared.normalizeComparableText("A.  Photosynthesis."), "photosynthesis");
  assert.equal(shared.normalizeComparableText("  B) Newton's law  "), "newton's law");
  assert.equal(shared.normalizeComparableText("C -   Gravity"), "gravity");
});

test("areChoiceTextsEquivalent matches common option variants", () => {
  assert.equal(
    shared.areChoiceTextsEquivalent("A. Mitochondria.", "mitochondria"),
    true
  );
  assert.equal(
    shared.areChoiceTextsEquivalent("B) Potential Energy", "potential energy."),
    true
  );
  assert.equal(shared.areChoiceTextsEquivalent("Kinetic", "Momentum"), false);
});

test("parseAiResponseText parses fenced JSON with surrounding prose", () => {
  const raw = [
    "Here is the result:",
    "```json",
    '{ "answer": "Mitochondria", "explanation": "It is the powerhouse." }',
    "```",
  ].join("\n");

  const parsed = shared.parseAiResponseText(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.answer, "Mitochondria");
});

test("parseAiResponseText extracts balanced object with additional text", () => {
  const raw =
    'I think this is correct: {"answer":["A","C"],"explanation":"Both are true."} end.';
  const parsed = shared.parseAiResponseText(raw);

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload.answer, ["A", "C"]);
});

test("rankTabs prefers preferred tab, then active, then most recently accessed", () => {
  const tabs = [
    { id: 10, active: false, lastAccessed: 1000 },
    { id: 20, active: true, lastAccessed: 2000 },
    { id: 30, active: false, lastAccessed: 5000 },
  ];

  const rankedPreferred = shared.rankTabs(tabs, {
    preferredTabId: 10,
    lastActiveTabId: 20,
    activationTimes: { 10: 3000, 20: 4000, 30: 2000 },
  });
  assert.equal(rankedPreferred[0].id, 10);

  const rankedNoPreferred = shared.rankTabs(tabs, {
    lastActiveTabId: 20,
    activationTimes: { 10: 1000, 20: 4000, 30: 2000 },
  });
  assert.equal(rankedNoPreferred[0].id, 20);
});

test("buildQuestionSignature is deterministic", () => {
  const sig1 = shared.buildQuestionSignature(
    "multiple_choice",
    "A.  What is energy?",
    4
  );
  const sig2 = shared.buildQuestionSignature(
    "multiple_choice",
    "What is energy?.",
    4
  );
  assert.equal(sig1, sig2);
});
