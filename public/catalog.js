// Search only public lesson metadata, never a person's answers or private drafts.
const normalized = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .trim();
export function selectLessons(
  lessons,
  {
    query = "",
    category = "Все темы",
    view = "all",
    saved = [],
    completed = [],
    collectionIds = null,
    maxMinutes = 0,
  } = {},
) {
  const words = normalized(query).slice(0, 80).split(/\s+/).filter(Boolean);
  const savedIds = new Set(saved),
    finished = new Set(completed);
  const collection = collectionIds === null ? null : new Set(collectionIds);
  return lessons.filter((lesson) => {
    if (collection && !collection.has(lesson.id)) return false;
    if (
      typeof maxMinutes === "number" &&
      maxMinutes > 0 &&
      lesson.minutes > maxMinutes
    )
      return false;
    if (category !== "Все темы" && lesson.category !== category) return false;
    if (view === "saved" && !savedIds.has(lesson.id)) return false;
    if (view === "new" && finished.has(lesson.id)) return false;
    const text = normalized(
      `${lesson.title} ${lesson.description} ${lesson.category}`,
    );
    return words.every((word) => text.includes(word));
  });
}
