import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPlan } from "../lib/reviews.js";
import { lessons } from "../public/content.js";
const day = 86400000,
  origin = Date.UTC(2026, 0, 1);
const completed = (lesson, offset) => ({
  lesson,
  finished: new Date(origin + offset * day).toISOString(),
});

test("review plan is voluntary, safety-only, and has 3 / 10 / 30 day intervals", () => {
  assert.deepEqual(buildReviewPlan([], lessons, origin), []);
  const sessions = [
    completed("bank", 0),
    completed("family-memory", 0),
    { lesson: "parcel", finished: null },
  ];
  let plan = buildReviewPlan(sessions, lessons, origin + 2 * day);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].intervalDays, 3);
  assert.equal(plan[0].due, false);
  assert.equal(
    buildReviewPlan(sessions, lessons, origin + 3 * day)[0].due,
    true,
  );
  sessions.push(completed("bank", 3));
  plan = buildReviewPlan(sessions, lessons, origin + 12 * day);
  assert.equal(plan[0].dueAt, new Date(origin + 13 * day).toISOString());
  assert.equal(plan[0].intervalDays, 10);
  sessions.push(completed("bank", 13));
  plan = buildReviewPlan(sessions, lessons, origin + 42 * day);
  assert.equal(plan[0].dueAt, new Date(origin + 43 * day).toISOString());
  assert.equal(plan[0].intervalDays, 30);
  sessions.push(completed("bank", 100));
  assert.equal(
    buildReviewPlan(sessions, lessons, origin + 120 * day)[0].dueAt,
    new Date(origin + 130 * day).toISOString(),
  );
});

test("all 36 lessons have original structured content and conversation endings impose no rule", () => {
  assert.equal(lessons.length, 36);
  assert.equal(new Set(lessons.map((l) => l.id)).size, lessons.length);
  for (const l of lessons) {
    assert.match(l.id, /^[a-z-]+$/);
    for (const field of [
      "title",
      "description",
      "story",
      "question",
      "explanation",
      "discussion",
    ])
      assert.ok(
        typeof l[field] === "string" && l[field].trim().length > 5,
        `${l.id}.${field}`,
      );
    assert.ok(["safety", "practice", "conversation"].includes(l.kind));
    assert.equal(l.options.length, 3);
    assert.equal(new Set(l.options).size, 3);
    assert.ok(l.minutes >= 3 && l.minutes <= 10);
    if (l.kind === "conversation") assert.equal(l.agreement, "");
    else assert.ok(l.agreement.length > 10);
  }
});
