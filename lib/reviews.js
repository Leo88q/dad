// Voluntary in-app repetition, not push notifications. Intervals are counted
// from the most recent completion: 3 days, then 10, then 30, thereafter 30.
export function buildReviewPlan(sessions, lessons, now = Date.now()) {
  return lessons
    .filter((l) => l.kind === "safety")
    .flatMap((lesson) => {
      const finished = sessions
        .filter((s) => s.lesson === lesson.id && s.finished)
        .map((s) => Date.parse(s.finished))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (!finished.length) return [];
      const intervalDays = [3, 10, 30][Math.min(finished.length - 1, 2)];
      const dueAt = new Date(
        finished.at(-1) + intervalDays * 86400000,
      ).toISOString();
      return [
        {
          lesson: lesson.id,
          completed: finished.length,
          intervalDays,
          dueAt,
          due: Date.parse(dueAt) <= now,
        },
      ];
    })
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}
