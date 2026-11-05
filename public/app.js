import { lessons } from "./content.js";
import { collections } from "./scenarios.js";
import { selectLessons } from "./catalog.js";
import { maxPlatform } from "./max.js";
let platformError = null,
  maxAuthPending = null,
  maxIdentityChecked = false;
try {
  await maxPlatform.init();
} catch (err) {
  platformError = err.message;
}
const $ = (s) => document.querySelector(s),
  root = $("#app"),
  modalRoot = $("#modal-root");
const paths = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  book: '<path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1v15"/>',
  heart:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M16 5a3 3 0 0 1 0 6m3 4a6 6 0 0 1 3 6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  shield:
    '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z"/><path d="m8 12 3 3 5-6"/>',
  message:
    '<path d="M21 11a9 9 0 0 1-9 9 10 10 0 0 1-4-.8L2 21l1.8-6A9 9 0 1 1 21 11Z"/><path d="M7 8h9M7 12h6"/>',
  box: '<path d="m12 2 10 5-10 5L2 7zM2 7v10l10 5 10-5V7M12 12v10M7 4.5l10 5"/>',
  phone: '<path d="m7 3 3 5-3 3a14 14 0 0 0 6 6l3-3 5 3-1 4C10 23 1 14 3 4z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings:
    '<path d="m9 3-1 3-3 1 1 4-2 2 2 4 3-1 2 3h4l1-3 3-1-1-4 2-2-2-4-3 1-2-3z"/><circle cx="12" cy="11" r="3"/>',
  leaf: '<path d="M20 3C9 2 2 7 5 15c8 6 16-1 15-12ZM3 21 16 8"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  volume:
    '<path d="m11 4-6 5H2v6h3l6 5zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  spark: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>',
  print: '<path d="M6 9V2h12v7M6 18H3V9h18v9h-3M6 14h12v8H6z"/>',
};
const icon = (n) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[n] || paths.heart}</svg>`;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let token = platformError ? null : await maxPlatform.getToken(),
  state = null,
  page = "home",
  filter = "Все темы",
  catalogQuery = "",
  catalogView = "all",
  catalogCollection = "all",
  catalogMinutes = 0,
  activeId = null,
  stage = "story",
  choice = null,
  person = "first",
  pendingLesson = null,
  modal = null,
  offline = false,
  large = maxPlatform.readSetting("ryadom-large") === "true";
let invite = new URLSearchParams(location.search).get("invite");
let previousFocus = null,
  recoverySecret = null,
  recoveryAcknowledged = false,
  devicePairingSecret = null,
  pendingDeviceId = null;
function defaultDeviceLabel() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad/i.test(ua)) return "Мой iPhone / iPad";
  if (/Android/i.test(ua)) return "Мой Android";
  return "Мой компьютер";
}
function deviceSection() {
  if (!state) return "";
  const current = state.devices?.find((d) => d.current);
  return `<section class="settings-section"><h2>Мои устройства</h2><p>До пяти подключений к вашему профилю. Это ваши телефоны и браузеры — не устройства близкого. Название задаётся для удобства и не подтверждает личность.</p><div class="device-list">${(state.devices || []).map((d) => `<div class="device-row"><div><h3>${esc(d.label)}</h3><p>${d.current ? "Это устройство · " : ""}Последнее обращение: ${new Date(d.lastSeen).toLocaleString("ru")}</p></div>${!d.current ? `<button class="btn outline" data-revoke-device="${d.id}" aria-label="Отключить ${esc(d.label)}">Отключить</button>` : '<span class="pill">Вы здесь</span>'}</div>`).join("")}</div><form id="device-name-form"><label for="device-label">Название этого устройства</label><input id="device-label" name="label" maxlength="40" required value="${esc(current?.label || defaultDeviceLabel())}"><div class="lesson-actions"><button class="btn secondary">Сохранить название</button></div></form><div class="lesson-actions"><button class="btn primary" data-action="prepare-device">Подключить моё другое устройство</button>${(state.devices?.length || 0) > 1 ? '<button class="btn outline" data-action="revoke-others">Отключить все остальные</button>' : ""}</div>${state.deviceCodeExpiresAt ? '<div class="notice">Есть действующий одноразовый код подключения. Не передавайте его другим людям.<button class="link-btn" data-action="cancel-device-code">Отозвать код</button></div>' : ""}<p class="muted">Выход отключает только текущий браузер. Аварийное восстановление по личному коду отключает все старые устройства и отменяет коды подключения.</p></section>`;
}
function download(name, text, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
let editingProposal = false;
const draftKey = () =>
  state && activeId ? `ryadom-draft:${state.me}:${activeId}` : null;
function clearDraft() {
  const key = draftKey();
  if (key) sessionStorage.removeItem(key);
}
function clearLocalDrafts() {
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith("ryadom-draft:")) sessionStorage.removeItem(key);
}
function getDraft(s, lesson) {
  const key = draftKey();
  try {
    const saved = JSON.parse(sessionStorage.getItem(key));
    if (
      saved &&
      typeof saved.text === "string" &&
      Number.isInteger(saved.revision)
    )
      return saved;
  } catch {}
  return {
    text: s.proposal?.text ?? lesson.agreement,
    revision: s.proposal?.revision ?? 0,
  };
}
function showRecovery(code) {
  recoverySecret = code;
  recoveryAcknowledged = false;
  openModal("recovery-save");
}
document.documentElement.classList.toggle("large", large);
async function api(path, body, method) {
  const requestToken = token,
    controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res, data;
  try {
    res = await fetch("/api" + path, {
      method: method || (body ? "POST" : "GET"),
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(requestToken ? { Authorization: "Bearer " + requestToken } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    try {
      data = await res.json();
    } catch (err) {
      if (controller.signal.aborted) throw err;
      throw new Error("Сервер временно недоступен. Попробуйте ещё раз.");
    }
  } catch (err) {
    if (controller.signal.aborted)
      throw new Error(
        "Сервер не ответил вовремя. Проверьте связь и повторите действие.",
      );
    if (err instanceof TypeError)
      throw new Error(
        "Нет связи с сервером. Проверьте интернет и повторите действие.",
      );
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 401 && token === requestToken) {
      await maxPlatform.setToken(null);
      clearLocalDrafts();
      token = null;
      state = null;
      modal = null;
      recoverySecret = null;
      devicePairingSecret = null;
      modalRoot.innerHTML = "";
    }
    throw new Error(data.error || "Не удалось выполнить запрос");
  }
  return data;
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 4000);
}
const me = () => state?.members.find((m) => m.id === state.me);
const partner = () => state?.members.find((m) => m.id !== state.me);
const active = () => state?.sessions.find((s) => s.id === activeId);
const completed = () =>
  new Set(state?.sessions.filter((s) => s.finished).map((s) => s.lesson) || []);
function go(p) {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  page = p;
  activeId = null;
  render();
  $("#main-content")?.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "instant" });
}
function nav(p, title, ic) {
  return `<button data-nav="${p}" class="${page === p ? "active" : ""}" ${page === p ? 'aria-current="page"' : ""}>${icon(ic)}${title}</button>`;
}
function render() {
  const focused = document.activeElement;
  const focusKey = [
    "data-save-lesson",
    "data-catalog-view",
    "data-choice",
    "data-action",
    "data-nav",
    "data-filter",
  ]
    .map((a) =>
      focused?.hasAttribute?.(a) ? [a, focused.getAttribute(a)] : null,
    )
    .find(Boolean);
  if (platformError) {
    document.title = "Вход в MAX — Рядом";
    root.innerHTML = `<main class="entry-gate" id="main-content" tabindex="-1"><a class="brand" href="/" data-action="max-retry"><img src="/icon.svg" alt="">рядом</a><section class="entry-card"><div class="modal-icon">${icon("shield")}</div><div class="eyebrow">Спокойно, мы поможем</div><h1>Давайте вернёмся в приложение</h1><p class="connection" role="alert">${esc(platformError)}</p><p>Занятия и договорённости сохраняются на сервере. После восстановления доступа можно продолжить.</p><div class="entry-actions"><button class="btn primary" data-action="max-retry">Повторить вход</button>${maxPlatform.botName ? `<a class="btn outline" href="https://max.ru/${encodeURIComponent(maxPlatform.botName)}" target="_blank" rel="noopener noreferrer">Открыть бота в MAX</a>` : ""}${token ? '<button class="btn outline" data-action="max-clear-cached">Выйти из сохранённого профиля</button>' : ""}</div><p class="muted">Если запуск устарел, закройте мини-приложение и снова откройте его кнопкой в MAX.</p></section></main>`;
    maxPlatform.syncUI({ back: false, unsaved: false, sensitive: false });
    return;
  }
  root.innerHTML = `${platformError ? `<div class="connection" role="alert">${esc(platformError)} <button class="btn outline" data-action="max-retry">Повторить вход через MAX</button>${token ? '<button class="btn outline" data-action="max-clear-cached">Выйти из сохранённого профиля</button>' : ""}</div>` : ""}${offline ? '<div class="connection" role="status">Нет связи с сервером. Ответы пока не отправлены. Восстановим соединение автоматически.</div>' : ""}<a class="skip-link" href="#main-content">Перейти к содержимому</a><div class="shell"><aside class="sidebar"><a href="/" data-action="home" class="brand"><img src="/icon.svg" alt="">рядом</a><div class="brand-sub">ВРЕМЯ ДРУГ ДЛЯ ДРУГА</div><nav class="nav" aria-label="Главное меню">${nav("home", "Главная", "home")}${nav("lessons", "Занятия", "book")}${nav("agreements", "Договорённости", "heart")}${nav("family", "Наша пара", "users")}</nav><div class="side-bottom"><div class="side-note">${icon("leaf")}<br>В своём ритме.<br>С теми, кто дорог.</div><button class="settings-btn" data-nav="settings">${icon("settings")}Настройки</button></div></aside><main class="main" id="main-content" tabindex="-1"><header class="topbar"><span class="breadcrumb">Ваше пространство заботы</span><a href="/" data-action="home" class="brand mobile-brand"><img src="/icon.svg" alt="">рядом</a><div class="top-actions"><button class="text-size" data-action="font" aria-label="${large ? "Обычный" : "Увеличенный"} размер текста" aria-pressed="${large}">А <b>А</b></button><button class="profile" data-nav="settings"><span>${esc(me()?.name || "Добро пожаловать")}</span><span class="avatar">${esc((me()?.name || "Р")[0].toUpperCase())}</span></button></div></header>${page === "session" ? sessionPage() : page === "lessons" ? lessonsPage() : page === "agreements" ? agreementsPage() : page === "family" ? familyPage() : page === "settings" ? settingsPage() : homePage()}<footer class="bottom-note">${icon("heart")}Здесь не бывает плохих оценок. Только разговоры, которые делают нас ближе.</footer></main></div>`;
  if (maxPlatform.active)
    root
      .querySelectorAll(
        '[data-action="restore"],[data-action="connect-device"]',
      )
      .forEach((el) => el.remove());
  maxPlatform.syncUI({
    back: page !== "home" || !!modal,
    unsaved: page === "session" && !active()?.finished,
    sensitive:
      page === "settings" ||
      ["recovery-save", "device-code", "invite"].includes(modal),
  });
  const title = {
    home: "Главная",
    lessons: "Занятия",
    agreements: "Договорённости",
    family: "Наша пара",
    settings: "Настройки",
    session: "Совместное занятие",
  }[page];
  document.title = `${title} — Рядом`;
  if (focusKey) {
    const target = [...root.querySelectorAll(`[${focusKey[0]}]`)].find(
      (el) => el.getAttribute(focusKey[0]) === focusKey[1],
    );
    target?.focus({ preventScroll: true });
  }
}
const heroArt =
  '<img src="/art/together.webp" alt="" width="1100" height="733" fetchpriority="high" decoding="async">';
function heading(eyebrow, title, sub, extra = "") {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="intro">${sub}</p></div>${extra}</div>`;
}
function card(l) {
  const saved = state?.savedLessons?.includes(l.id) || false;
  return `<article class="lesson-tile"><button class="lesson-card" data-lesson="${l.id}"><div class="card-art ${l.color}">${l.tag ? `<span class="card-badge">${completed().has(l.id) ? "Уже знакомая история" : esc(l.tag)}</span>` : completed().has(l.id) ? '<span class="card-badge">Пройдено вместе ✓</span>' : ""}${icon(l.icon)}</div><div class="card-body"><div class="category">${l.category}</div><h3>${l.title}</h3><p>${l.description}</p><div class="card-footer"><span>${icon("clock")}${l.minutes} минут</span><span>· Вдвоём</span>${icon("arrow")}</div></div></button><button class="save-lesson" data-action="save-lesson" data-save-lesson="${l.id}" aria-pressed="${saved}" aria-label="${saved ? "Убрать из избранного" : "Сохранить на потом"}: ${esc(l.title)}">${icon("heart")}${saved ? "В избранном" : "На потом"}</button></article>`;
}
function reviewSection() {
  if (!state?.preferences?.reviews) return "";
  const plan = state.reviewPlan || [];
  return `<section class="review-panel"><div class="section-head"><h2>Можно освежить в памяти</h2><button class="link-btn" data-nav="settings">Настроить</button></div><p class="muted">Только если хочется. Здесь нет просрочек, штрафов и обязательных занятий.</p>${
    plan.length
      ? plan
          .slice(0, 3)
          .map((item) => {
            const l = lessons.find((l) => l.id === item.lesson);
            return `<div class="review-item"><div><h3>${esc(l.title)}</h3><p>${item.due ? "Можно повторить в удобное время" : "Следующее предложение: " + new Date(item.dueAt).toLocaleDateString("ru")}</p></div><button class="btn secondary" data-lesson="${l.id}">Повторить</button></div>`;
          })
          .join("")
      : '<p class="notice">После первого занятия по безопасности здесь появится предложение повторить его через 3 дня. Затем — через 10 и 30 дней после следующих завершений.</p>'
  }</section>`;
}
function savedSection() {
  if (!state?.savedLessons?.length) return "";
  const saved = selectLessons(lessons, {
    view: "saved",
    saved: state.savedLessons,
  });
  return `<section class="saved-section"><div class="section-head"><h2>Вы отложили на потом</h2><button class="link-btn" data-action="open-saved">Все избранные (${saved.length}) ${icon("arrow")}</button></div><p class="muted">Ваш личный список. Близкий его не видит — выберите удобный момент для разговора.</p><div class="cards">${saved.slice(0, 3).map(card).join("")}</div></section>`;
}
function collectionSection() {
  return `<section class="collection-section"><div class="section-head"><h2>Что хочется сегодня?</h2></div><p class="muted">${lessons.length} занятий: поговорить, потренироваться или разобраться в сложной ситуации.</p><div class="collection-grid">${collections.map((c) => `<button class="collection-card" data-action="open-collection" data-collection-id="${c.id}">${icon(c.icon)}<span><strong>${esc(c.title)}</strong><small>${esc(c.description)}</small><span class="collection-count">${c.lessonIds.length} занятий</span></span></button>`).join("")}</div></section>`;
}
function decisionChecks(lesson) {
  return `${lesson.verify?.length ? `<details class="depth-details decision-checks"><summary>Что проверить в реальной ситуации</summary><dl>${lesson.verify.map(([question, why]) => `<dt>${esc(question)}</dt><dd>${esc(why)}</dd>`).join("")}</dl><p class="muted">Это ориентиры для проверки, не подтверждение безопасности конкретного случая.</p></details>` : ""}${lesson.variation ? `<details class="depth-details scenario-variation"><summary>А если ситуация изменится?</summary><h3>${esc(lesson.variation.question)}</h3><p>${esc(lesson.variation.note)}</p></details>` : ""}${lesson.selfCheck ? `<section class="practice-check"><h3>Проверить без экзамена</h3><p>${esc(lesson.selfCheck)}</p><p class="muted">Ответ не записывается. Можно повторить шаг или оставить настройку без изменений.</p></section>` : ""}${lesson.limit ? `<p class="content-limit">${esc(lesson.limit)}</p>` : ""}`;
}
function lessonExtras(lesson) {
  return `${lesson.steps?.length ? `<section class="practice-guide"><h3>Попробуйте по шагам</h3><ol>${lesson.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol><p class="muted">Можно только прочитать шаги. Действия на телефоне выполняет владелец по своему желанию; приложение ничего не делает за него.</p></section>` : ""}${lesson.extraQuestions?.length ? `<details class="lesson-extra"><summary>Ещё вопросы, если хочется</summary><ul>${lesson.extraQuestions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></details>` : ""}${lesson.ifAlreadyHappened ? `<details class="lesson-extra"><summary>Если это уже произошло</summary><p>${esc(lesson.ifAlreadyHappened)}</p><p class="muted">Можно попросить близкого побыть рядом. Эта памятка не гарантирует возврат денег и не заменяет обращение в официальный сервис.</p></details>` : ""}`;
}
function homePage() {
  const unfinished = state?.sessions.find((s) => !s.finished);
  return `${heading("Маленькие шаги. Большая близость.", me() ? `Хорошо, что вы рядом${me().name.length < 16 ? ", " + esc(me().name) : ""}` : "Хорошо, что вы рядом", "Немного времени вместе — и больше уверенности каждый день.", `<span class="date-label">${new Intl.DateTimeFormat("ru", { day: "numeric", month: "long", weekday: "long" }).format(new Date())}</span>`)}<section class="hero"><div class="hero-copy"><span class="pill">${icon("spark")}Вместе спокойнее</span><h2>Пять минут для вас.<br>И тех, кто вам дорог.</h2><p>Разбирайте жизненные истории, делитесь воспоминаниями и поддерживайте друг друга.</p><button class="btn primary" ${unfinished ? `data-resume="${unfinished.id}"` : 'data-lesson="new-number"'}>${unfinished ? "Продолжить занятие" : "Начать вместе"}${icon("arrow")}</button></div><div class="hero-art">${heroArt}</div></section>${collectionSection()}${reviewSection()}${savedSection()}${!state ? '<button class="link-btn" data-action="restore">Уже занимались? Войти по личному коду</button><button class="link-btn" data-action="connect-device">Есть вход на другом устройстве? Подключить это</button>' : ""}<div class="two-cols"><div class="invite-card"><div class="invite-icon">${icon("users")}</div><div><h3>${partner() ? "Ваша пара: " + esc(me().name) + " и " + esc(partner().name) : "Хорошее начинается с приглашения"}</h3><p>${partner() ? "Выберите историю и найдите немного времени друг для друга." : "Позовите близкого. Занимайтесь рядом или на расстоянии."}</p></div><button class="arrow-button" data-action="${partner() ? "pair" : "invite"}" aria-label="${partner() ? "Открыть нашу пару" : "Пригласить близкого"}">${icon("arrow")}</button></div><div class="rhythm-card">${icon("leaf")}<div><h3>Без спешки и оценок</h3><p>Ваш темп — самый правильный.</p></div></div></div><div class="section-head"><h2>Попробуйте вместе</h2><button class="link-btn" data-nav="lessons">Все занятия ${icon("arrow")}</button></div><div class="cards">${[
    "safety",
    "conversation",
    "practice",
  ]
    .map((kind) => lessons.find((l) => l.kind === kind))
    .map(card)
    .join("")}</div>`;
}
function lessonsPage() {
  const list = selectLessons(lessons, {
    query: catalogQuery,
    category: filter,
    view: catalogView,
    saved: state?.savedLessons || [],
    completed: [...completed()],
    collectionIds:
      catalogCollection === "all"
        ? null
        : collections.find((c) => c.id === catalogCollection)?.lessonIds || [],
    maxMinutes: catalogMinutes,
  });
  return `${heading("Разговоры, которые помогают", "Время побыть вместе", "Выберите то, что интересно вам обоим. Здесь нет экзаменов.")}<form id="catalog-search" class="catalog-search" role="search"><label for="catalog-query">Найти занятие</label><div class="catalog-search-row"><input id="catalog-query" name="query" type="search" maxlength="80" value="${esc(catalogQuery)}" placeholder="Например, звонок или воспоминания"><button class="btn primary" type="submit">Найти</button></div></form><div class="catalog-picks"><div><label for="catalog-collection">Подборка</label><select id="catalog-collection"><option value="all" ${catalogCollection === "all" ? "selected" : ""}>Все подборки</option>${collections.map((c) => `<option value="${c.id}" ${catalogCollection === c.id ? "selected" : ""}>${esc(c.title)} (${c.lessonIds.length})</option>`).join("")}</select></div><div><label for="catalog-minutes">Сколько есть времени?</label><select id="catalog-minutes">${[
    [0, "Без ограничения"],
    [5, "До 5 минут"],
    [6, "До 6 минут"],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${catalogMinutes === value ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></div></div><div class="filters" aria-label="Мой выбор">${[
    ["all", "Все занятия"],
    ["saved", "Избранное"],
    ["new", "Ещё не пробовали"],
  ]
    .map(
      ([value, label]) =>
        `<button class="filter ${catalogView === value ? "active" : ""}" data-action="catalog-view" data-catalog-view="${value}" aria-pressed="${catalogView === value}">${label}</button>`,
    )
    .join(
      "",
    )}</div><div class="filters" aria-label="Темы занятий">${["Все темы", "Безопасность", "Ближе друг к другу", "Осваиваем телефон"].map((f) => `<button class="filter ${filter === f ? "active" : ""}" data-filter="${f}" aria-pressed="${filter === f}">${f}</button>`).join("")}</div><p class="muted" role="status">Найдено занятий: ${list.length} из ${lessons.length}${catalogView === "saved" ? ". Избранное доступно только вам." : ""}</p>${list.length ? `<div class="cards">${list.map(card).join("")}</div>` : `<section class="empty"><h2>${catalogView === "saved" && !state ? "Ваш личный список занятий" : catalogView === "saved" && !catalogQuery && filter === "Все темы" && catalogCollection === "all" && !catalogMinutes ? "Здесь будут избранные истории" : "Подходящих занятий пока нет"}</h2><p>${catalogView === "saved" ? "Нажмите «На потом» под интересной историей. Список сохранится в вашем профиле и будет доступен на ваших устройствах." : "Попробуйте другое слово или выберите все темы. Можно вернуться и к знакомой истории."}</p>${!state && catalogView === "saved" ? '<button class="btn primary" data-action="register">Создать профиль</button>' : ""}<button class="btn outline" data-action="catalog-reset">Показать все занятия</button></section>`}`;
}
function agreementsPage() {
  return `${heading("Ваши маленькие опоры", "Наши договорённости", "То, о чём вы решили вместе. Можно перечитать в любой момент.", state?.agreements.length ? `<button class="btn outline" data-action="print">${icon("print")}Распечатать</button>` : "")}<p class="print-only">Рядом · Семейная памятка</p>${state?.agreements.length ? state.agreements.map((a) => `<article class="agreement">${icon("check")}<div><p>${esc(a.text)}</p><small>${esc(lessons.find((l) => l.id === state.sessions.find((s) => s.id === a.session)?.lesson)?.title || "Семейная договорённость")} · ${new Date(a.created).toLocaleDateString("ru")}</small></div></article>`).join("") : `<div class="empty">${icon("heart")}<h2>Здесь появятся ваши договорённости</h2><p>После обучающей истории можно сохранить полезную мысль. Это необязательно: семейные разговоры не требуют правил и обещаний.</p><button class="btn primary" data-nav="lessons">Выбрать историю ${icon("arrow")}</button></div>`}`;
}
function familyPage() {
  return `${heading("Забота — в обе стороны", "Наша пара", "Не учитель и ученик. Два близких человека, которые узнают новое вместе.")}<div class="settings-section"><h2>${state ? "Ваше общее пространство" : "Начните с знакомства"}</h2>${state ? `<div class="agreement"><span class="avatar">${esc(me().name[0])}</span><div><h3>${esc(me().name)}</h3><p class="muted">Это вы</p></div></div>${partner() ? `<div class="agreement"><span class="avatar">${esc(partner().name[0])}</span><div><h3>${esc(partner().name)}</h3><p class="muted">Ваш близкий</p></div></div>` : `<p>Второе место ждёт вашего близкого. Приглашение можно отправить в любом мессенджере.</p><button class="btn primary" data-action="invite">${icon("users")}Пригласить близкого</button>`}` : `<p>Укажите имя, чтобы сохранять занятия и пригласить близкого.</p><button class="btn primary" data-action="register">Создать пространство</button>`}</div><div class="settings-section"><h2>Рядом или на расстоянии</h2><p>Сидите вместе? Достаточно одного телефона. Находитесь далеко? Откройте ссылку каждый на своём устройстве и созвонитесь привычным способом.</p><p>Ваши ответы видны друг другу только после того, как ответили оба. Договорённости доступны вам двоим.</p><button class="btn secondary" data-nav="lessons">Выбрать занятие</button></div>`;
}
function serviceInfo() {
  const release = maxPlatform.release;
  if (!release)
    return '<p class="notice">Это тестовое окружение. Оператор и документы публичного сервиса ещё не настроены.</p>';
  return `<section class="service-info"><h3>Оператор и поддержка</h3><p>${esc(release.operatorName)}</p><p>Поддержка: <a href="mailto:${esc(release.supportEmail)}">${esc(release.supportEmail)}</a></p><div class="lesson-actions"><a href="${esc(release.privacyURL)}" data-action="legal-open" data-legal-url="${esc(release.privacyURL)}" class="link-btn">Политика обработки данных</a><a href="${esc(release.termsURL)}" data-action="legal-open" data-legal-url="${esc(release.termsURL)}" class="link-btn">Условия использования</a></div><p class="muted">Версия документов: ${esc(release.policyVersion)}. Для обращений об удалении и доступе к данным напишите в поддержку.</p></section>`;
}
function settingsPage() {
  return `${heading("Как вам удобно", "Настройки", "Размер текста, имя и ваши данные — под вашим контролем.")}<section class="settings-section"><h2>Комфортный размер текста</h2><p>Можно увеличить текст. Выбор сохранится на этом устройстве.</p><button class="btn secondary" data-action="font">${large ? "Вернуть обычный размер" : "Увеличить текст"}</button></section><section class="settings-section"><h2>Как к вам обращаться?</h2>${state ? `<form id="name-form"><label for="name">Ваше имя или псевдоним</label><input id="name" name="name" maxlength="40" required value="${esc(me().name)}"><div class="lesson-actions"><button class="btn primary">Сохранить имя</button></div></form>` : `<p>Создайте пространство, чтобы сохранять ваши занятия.</p><button class="btn primary" data-action="register">Начать</button>`}</section>${deviceSection()}<section class="settings-section"><h2>Доступ и резервная копия</h2>${state?.maxLinked ? '<p class="notice">Профиль связан с MAX. Повторный вход возможен через тот же аккаунт MAX. При потере телефона завершите его сеансы также в настройках самого мессенджера.</p>' : ""}${state ? `<p>${state.recoveryEnabled ? "Личный код восстановления создан. Он не отображается повторно." : "Для этого профиля ещё нет кода восстановления."} Если потеряли его, получите новый, пока есть доступ.</p><div class="lesson-actions"><button class="btn secondary" data-action="recovery-new">Получить новый код</button><button class="btn outline" data-action="export">Скачать мои данные</button></div>` : `<p>Уже занимались? Вернитесь в своё пространство по сохранённому личному коду.</p><button class="btn primary" data-action="restore">Войти по личному коду</button>`}</section>${state ? `<section class="settings-section"><h2>Повторять без спешки</h2><p>По вашему желанию будем показывать на главной предложения повторить истории по безопасности: через 3, затем 10 и 30 дней после очередного завершения. Это не push-уведомления; ничего не отправляем близкому.</p><button class="btn secondary" data-action="toggle-reviews" aria-pressed="${!!state.preferences?.reviews}">${state.preferences?.reviews ? "Выключить предложения повторить" : "Включить предложения повторить"}</button></section>` : ""}<section class="settings-section"><h2>Приватность</h2>${serviceInfo()}<p>Мы храним имя, ответы в занятиях и общие договорённости. Не запрашиваем телефон, адресную книгу, фото или записи голоса. Аналитики и рекламных трекеров нет.</p><button class="btn outline" data-action="privacy">О данных и ограничениях</button>${state ? `<p class="notice">${state.consent ? `Согласие ${esc(state.consent.version)} принято ${new Date(state.consent.acceptedAt).toLocaleDateString("ru")}.${maxPlatform.release ? "" : " Это техническая запись тестового окружения, а не подтверждение юридической готовности сервиса."}` : "Для старого профиля нет записи версии согласия. Ознакомьтесь с условиями тестового запуска и подтвердите согласие."}</p>${!state.consent || state.consent.version !== state.consentVersion ? '<button class="btn secondary" data-action="consent-renew">Прочитать и подтвердить актуальное согласие</button>' : ""}` : ""}${state ? `<div class="lesson-actions"><button class="btn outline" data-action="logout">Выйти на этом устройстве</button><button class="btn danger" data-action="delete">Удалить мой профиль</button></div>` : ""}</section>`;
}
function sessionPage() {
  const s = active();
  if (!s)
    return `<div class="empty"><h2>Занятие не найдено</h2><button class="btn primary" data-nav="lessons">К занятиям</button></div>`;
  const l = lessons.find((l) => l.id === s.lesson);
  if (s.finished) {
    stage = "done";
    clearDraft();
  } else if (s.revealed && ["answer", "waiting"].includes(stage))
    stage = "review";
  const index = ["story", "answer", "review", "agreement", "done"].indexOf(
    stage === "waiting" ? "answer" : stage,
  );
  let body = "";
  if (stage === "story")
    body = `<div class="eyebrow">История для разговора</div><h2>${l.title}</h2><p class="lesson-goal"><strong>Для чего эта история:</strong> ${esc(l.goal)}</p><p class="story">${l.story}</p><div class="lesson-actions"><button class="btn outline" data-action="speak">${icon("volume")}Послушать</button><button class="btn primary" data-action="to-answer">Подумать вместе ${icon("arrow")}</button></div>`;
  if (stage === "answer")
    body = `<div class="eyebrow">${s.mode === "together" ? (person === "first" ? "Первый участник" : "Теперь второй участник") : "Ваше мнение"}</div><h2>${l.question}</h2><p class="muted">${s.mode === "together" ? "Выберите свой ответ, затем передайте телефон близкому." : "Ответьте самостоятельно. Обсудить выбор можно будет после ответа близкого."}</p>${l.options.map((o, i) => `<button class="option ${choice === i ? "selected" : ""}" data-choice="${i}" aria-pressed="${choice === i}"><span class="option-number">${i + 1}</span>${o}</button>`).join("")}<div class="lesson-actions"><span class="muted">Без оценок и спешки</span><button class="btn primary" data-action="answer" ${choice === null ? "disabled" : ""}>${s.mode === "together" && person === "first" ? "Передать телефон" : "Сохранить ответ"}${icon("arrow")}</button></div>`;
  if (stage === "waiting")
    body = `<div class="modal-icon">${icon("users")}</div><h2>Ваш ответ сохранён</h2><p class="story">Теперь слово близкому. Когда он ответит, здесь появится продолжение.</p><div class="notice">${partner() ? `Попросите ${esc(partner().name)} открыть «Рядом» и нажать «Продолжить занятие».` : "Пригласите близкого, чтобы пройти эту историю на двух устройствах."}</div><button class="btn secondary" data-action="invite">${icon("copy")}Ссылка для близкого</button><div class="lesson-actions"><button class="back" data-action="refresh">Проверить ответ</button><button class="back" data-action="cancel-session">Отменить занятие</button></div>`;
  if (stage === "review")
    body = `<div class="eyebrow">Разбираемся, а не оцениваем</div><h2>У каждого — свой взгляд</h2>${Object.entries(
      s.answers,
    )
      .map(
        ([k, v], i) =>
          `<div class="answer-line"><small>${s.mode === "together" ? (k === "first" ? "Первый участник" : "Второй участник") : esc(state.members.find((m) => m.id === k)?.name || "Близкий")}</small><p class="answer-choice">${esc(l.options[v])}</p>${l.optionNotes?.[v] ? `<p class="answer-note">${esc(l.optionNotes[v])}</p>` : ""}</div>`,
      )
      .join(
        "",
      )}<div class="notice">${l.explanation}</div><div class="discussion"><h3>${icon("message")} Обсудите вместе</h3><p>${l.discussion}</p></div>${lessonExtras(l)}${decisionChecks(l)}<div class="lesson-actions"><button class="btn outline" data-action="speak">${icon("volume")}Послушать общий разбор</button>${l.kind === "conversation" ? '<button class="btn primary" data-action="complete-session">Спасибо за разговор</button>' : `<button class="btn primary" data-action="to-agreement">${l.kind === "practice" ? "Сохранить полезную мысль" : "Договориться"} ${icon("arrow")}</button>`}</div>${l.kind !== "conversation" ? '<button class="back" data-action="complete-session">Закончить без договорённости</button>' : ""}`;
  if (stage === "agreement") {
    const proposal = s.proposal;
    if (s.mode === "remote" && proposal && !editingProposal) {
      const agreed = proposal.approvals.includes(state.me);
      body = `<div class="eyebrow">Решаем вдвоём · версия ${proposal.revision}</div><h2>Подходит ли вам обоим?</h2><p class="muted">Договорённость сохранится только после отдельного подтверждения каждого. Изменение текста отменяет прежние подтверждения.</p><div class="discussion"><h3>Предложение</h3><p>${esc(proposal.text)}</p></div><div class="approval-list" aria-label="Подтверждения">${state.members.map((m) => `<p>${icon(proposal.approvals.includes(m.id) ? "check" : "clock")} ${esc(m.name)} — ${proposal.approvals.includes(m.id) ? "согласен с этой версией" : "ещё не подтвердил(а)"}</p>`).join("")}</div><div class="notice" role="status">${agreed ? "Ваше согласие сохранено. Ждём решения близкого." : "Прочитайте текст. Можно согласиться или предложить другую формулировку."}</div><div class="lesson-actions"><button class="btn outline" data-action="edit-proposal">Предложить другой текст</button>${!agreed ? `<button class="btn primary" data-action="approve-proposal" data-revision="${proposal.revision}">${icon("check")}Я согласен / согласна</button>` : '<button class="btn secondary" data-action="refresh-proposal">Проверить подтверждение</button>'}</div><button class="back" data-action="to-review">Вернуться к разбору</button>`;
    } else {
      const draft = getDraft(s, l);
      const conflict = draft.revision !== (proposal?.revision ?? 0);
      body = `<div class="eyebrow">Одна мысль с собой</div><h2>О чём мы договоримся?</h2><p class="muted">${s.mode === "remote" ? "Предложите формулировку близкому. Отправляя текст, вы подтверждаете своё согласие; близкий подтвердит его отдельно." : "Прочитайте предложение вслух. Можно изменить его так, чтобы оно подходило вам обоим. Сохраните, когда оба согласны."}</p>${proposal ? `<div class="notice">Сейчас предложено: ${esc(proposal.text)}</div>` : ""}${conflict ? '<div class="notice" role="alert">Близкий изменил предложение, пока вы редактировали. Ваш текст сохранён здесь как черновик. Перечитайте новую версию перед отправкой.</div><button class="btn outline" data-action="reload-proposal">Отбросить мой черновик и перечитать</button>' : ""}<form id="agreement-form" data-revision="${draft.revision}"><label for="agreement">Наша договорённость</label><textarea id="agreement" maxlength="500" minlength="3" required>${esc(draft.text)}</textarea><small class="muted">Черновик хранится в этой вкладке до её закрытия. Не вводите личные и банковские данные.</small><div class="lesson-actions"><button type="button" class="back" data-action="to-review">Вернуться к разбору</button><button class="btn primary" ${conflict ? "disabled" : ""}>${icon("check")}${s.mode === "remote" ? "Я согласен — предложить близкому" : "Оба согласны — сохранить"}</button></div></form>`;
    }
  }
  if (stage === "done") {
    const agreement = state.agreements.find((a) => a.session === s.id);
    body = `<div class="success-art"><img src="/art/growth.webp" width="180" height="120" alt="" decoding="async"></div><div class="eyebrow">Ещё немного ближе</div><h2>${l.kind === "conversation" ? "Спасибо, что рассказали" : "Хорошо провели время вместе"}</h2><p class="story">${l.kind === "conversation" ? "Для хорошего разговора не нужны оценки и обещания. Можно просто сохранить это время друг для друга." : "Вы нашли время услышать друг друга. Можно вернуться к этой истории в любой момент."}</p>${agreement ? `<div class="discussion"><h3>Ваша договорённость</h3><p>${esc(agreement.text)}</p></div>` : '<p class="notice">Занятие завершено без сохранения договорённости. Это нормально — решение остаётся за вами.</p>'}<div class="lesson-actions">${agreement ? '<button class="btn outline" data-nav="agreements">К договорённостям</button>' : '<button class="btn outline" data-nav="lessons">Выбрать другую историю</button>'}<button class="btn primary" data-nav="home">На главную ${icon("heart")}</button></div>`;
  }
  return `<div class="lesson-layout"><button class="back" data-nav="home">${icon("back")}На главную · прогресс сохранён</button><div class="steps" role="progressbar" aria-label="Ход занятия" aria-valuemin="1" aria-valuemax="5" aria-valuenow="${index + 1}" aria-valuetext="Шаг ${index + 1} из 5">${Array.from({ length: 5 }, (_, i) => `<span class="step ${i <= index ? "done" : ""}"></span>`).join("")}</div><div class="lesson-panel">${body}</div>${!s.finished && stage !== "waiting" ? '<button class="back" data-action="cancel-session">Отменить занятие и удалить ответы</button>' : ""}</div>`;
}
function openModal(type) {
  previousFocus = document.activeElement;
  modal = type;
  renderModal();
  maxPlatform.syncUI({
    back: true,
    unsaved: page === "session" && !active()?.finished,
    sensitive:
      ["recovery-save", "device-code", "invite"].includes(modal) ||
      page === "settings",
  });
  setTimeout(() => modalRoot.querySelector("input,button")?.focus(), 20);
}
function closeModal() {
  if (
    modal === "recovery-save" &&
    !recoveryAcknowledged &&
    !window.confirm(
      "Вы ещё не подтвердили сохранение кода. Закрыть? Этот код больше не будет показан.",
    )
  )
    return false;
  if (modal === "recovery-save") recoverySecret = null;
  if (modal === "device-code") devicePairingSecret = null;
  modal = null;
  modalRoot.innerHTML = "";
  maxPlatform.syncUI({
    back: page !== "home",
    unsaved: page === "session" && !active()?.finished,
    sensitive: page === "settings",
  });
  previousFocus?.isConnected && previousFocus.focus();
  return true;
}
function renderModal() {
  if (!modal) return;
  let body = "";
  if (modal === "register" || modal === "join") {
    const joining = modal === "join" || !!maxAuthPending?.joining;
    body = `<div class="modal-icon">${icon("users")}</div><h2>${maxPlatform.active ? "Вход через MAX" : joining ? "Вас пригласили побыть рядом" : "Давайте познакомимся"}</h2><p>${joining ? "Присоединитесь к близкому. Занятия и договорённости будут общими." : "Достаточно имени. Без номера телефона, паролей и лишних вопросов."}</p><form id="register-form"><label for="reg-name">Как к вам обращаться?</label><input id="reg-name" name="name" autocomplete="given-name" maxlength="40" placeholder="Ваше имя" value="${esc(maxAuthPending?.name || "")}" required><label class="checkbox"><input type="checkbox" name="consent" required><span>Согласен на хранение имени, ответов и данных подключённых устройств${maxPlatform.active ? ", а также идентификатора MAX для входа" : ""} для совместных занятий. <a href="#privacy" data-action="privacy">О данных и ограничениях</a></span></label>${maxPlatform.release ? serviceInfo() : ""}<div class="error" role="alert"></div><button class="btn primary">${joining ? "Присоединиться" : "Создать своё пространство"}${icon("arrow")}</button></form><p style="font-size:12px;margin-top:18px">После создания профиля вы получите личный код восстановления. Приглашение для близкого — другая ссылка.</p><button class="link-btn" data-action="restore">Уже занимались? Войти по личному коду</button><button class="link-btn" data-action="connect-device">Подключить моё другое устройство</button>`;
  }
  if (modal === "mode") {
    const l = lessons.find((l) => l.id === pendingLesson);
    body = `<div class="modal-icon">${icon(l.icon)}</div><h2>${l.title}</h2><p>${l.description} Примерно ${l.minutes} минут, но можно не торопиться.</p><p class="lesson-goal"><strong>Попробуем:</strong> ${esc(l.goal)}</p><h3 style="margin-top:24px">Как вы будете заниматься?</h3><button class="mode-btn" data-mode="together">${icon("users")}<span><strong>Рядом, на одном телефоне</strong><small>Читайте вместе и передавайте телефон друг другу.</small></span></button><button class="mode-btn" data-mode="remote">${icon("phone")}<span><strong>Каждый на своём устройстве</strong><small>Откройте приложение вдвоём и созвонитесь привычным способом.</small></span></button><p style="font-size:12px">Можно остановиться в любой момент. Прогресс сохранится.</p>`;
  }
  if (modal === "invite") {
    const url = inviteUrl();
    body = `<div class="modal-icon">${icon("heart")}</div><h2>Позовите близкого</h2><p>«Давай найдём пять минут друг для друга? Здесь есть истории, которые интересно обсудить вместе».</p><label for="invite-url">Личная ссылка-приглашение</label><input id="invite-url" class="invite-link" readonly value="${esc(url)}"><button class="btn primary" data-action="copy">${icon("copy")}Скопировать ссылку</button>${maxPlatform.active || navigator.share ? '<button class="btn outline" data-action="share">Отправить приглашение</button>' : ""}<p style="font-size:12px;margin-top:18px">По ссылке сможет присоединиться один человек. Не публикуйте её в открытых чатах.</p><button class="link-btn" data-action="rotate">Отозвать и создать новую ссылку</button>`;
  }
  if (modal === "privacy") {
    body = `<div class="modal-icon">${icon("shield")}</div><h2>Ваши данные и ваше решение</h2><div class="privacy-copy"><p>«Рядом» — образовательный сервис для совместных занятий. Не медицинская услуга и не средство гарантированной защиты от мошенничества.</p><h3>Что сохраняется</h3><p>Имя или псевдоним, личный список избранных занятий (виден только вам), связь с напарником, выбранные ответы, даты завершения занятий, предложения договорённостей и подтверждения согласия. Черновик до отправки хранится только в текущей вкладке до её закрытия. Также сохраняются версия и дата согласия и добровольная настройка повторений. Ответы видны напарнику после выбора обоих. Не записываем голос и не получаем доступ к контактам.</p><h3>Защита от перебора</h3><p>Для ограничения запросов до и после входа сохраняются временные счётчики попыток и псевдоним сетевого адреса, рассчитанный с серверным секретом. Исходный IP-адрес в этом хранилище не записывается; это псевдонимизация, не полная анонимность. Эти записи не привязаны к имени или ответам.</p><h3>Вход через MAX</h3><p>Для входа сервер проверяет подписанные данные запуска MAX и сохраняет только идентификатор аккаунта, связанный с вашим профилем. Полные данные запуска, фото и телефон не сохраняются. Идентификатор удаляется вместе с профилем. Вход доступен через тот же аккаунт MAX; существующий профиль связывается только с вашего подтверждения. При потере телефона завершите его сеансы в MAX: отключение устройства здесь не запрещает новый вход через сам мессенджер.</p><h3>Доступ</h3><p>Ключ доступа хранится в браузере, а в поддерживаемых клиентах MAX — в зашифрованном SecureStorage. Если SecureStorage недоступно, используется хранилище WebView. Для каждого подключённого браузера создаётся отдельный ключ; на сервере хранятся только хеши ключей и кодов. Также сохраняются заданные вами названия устройств и время их подключения и последнего обращения. Полные User-Agent и IP в списке устройств не сохраняются. Не используйте общий компьютер. Для восстановления используйте сохранённый личный код. Он одноразовый: после входа вы получите новый, а доступ на всех прежних устройствах будет отозван. Приглашение не восстанавливает существующий профиль.</p><h3>Удаление</h3><p>В настройках можно удалить профиль и его идентификаторы в ответах. Общие договорённости остаются у напарника; после удаления последнего участника удаляется всё пространство.</p>${serviceInfo()}<p>Не указывайте банковские данные, сведения о здоровье и другие чувствительные данные. Перед использованием ознакомьтесь с условиями и политикой обработки данных.</p><h3>Озвучка</h3><p>Кнопка «Послушать» использует голос браузера, если он доступен. Некоторые устройства могут обрабатывать текст через сервис своего производителя. Озвучиваются только готовые истории и разборы, не ваши ответы.</p></div><button class="btn primary" data-action="privacy-back">Понятно</button>`;
  }
  if (modal === "device-prepare")
    body = `<div class="modal-icon">${icon("shield")}</div><h2>Подключить ещё одно своё устройство</h2><p>Откройте «Рядом» на своём втором телефоне или компьютере и выберите «Подключить это». Новый код действует 10 минут и даёт доступ к вашему профилю. Не отправляйте его близкому: ему нужно приглашение в пару, а не вход вместо вас.</p><button class="btn primary" data-action="generate-device-code">Получить одноразовый код</button><button class="btn outline" data-action="close">Отмена</button>`;
  if (modal === "device-code") {
    const valid =
      devicePairingSecret &&
      state?.deviceCodeExpiresAt &&
      Date.now() < Date.parse(devicePairingSecret.expiresAt);
    body = `<div class="modal-icon">${icon("phone")}</div><h2>Код для вашего устройства</h2>${valid ? `<p>На другом своём устройстве откройте приложение и выберите «Подключить это». Введите код до ${new Date(devicePairingSecret.expiresAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}. Его можно использовать только один раз.</p><label for="device-code-secret">Код подключения</label><input id="device-code-secret" class="recovery-code" readonly spellcheck="false" value="${esc(devicePairingSecret.code)}"><button class="btn primary" data-action="copy-device-code">${icon("copy")}Скопировать код</button><p class="notice">Не передавайте код другим людям. Закрытие окна скрывает код, но не отменяет его до истечения срока.</p><button class="btn outline" data-action="cancel-device-code">Отозвать код и закрыть</button>` : '<p role="status">Код больше не действует: он использован, отозван или истёк. Проверьте список устройств в настройках.</p><button class="btn primary" data-action="generate-device-code">Получить новый код</button>'}`;
  }
  if (modal === "device-connect")
    body = `<div class="modal-icon">${icon("phone")}</div><h2>Подключить это устройство</h2><p>На уже подключённом вашем устройстве откройте «Настройки → Мои устройства» и получите код. Это не семейное приглашение и не личный код восстановления.</p><form id="device-connect-form"><label for="connect-code">Одноразовый код подключения</label><input id="connect-code" name="code" maxlength="60" autocomplete="off" spellcheck="false" required><label for="connect-label">Как назвать это устройство?</label><input id="connect-label" name="deviceLabel" maxlength="40" required value="${esc(defaultDeviceLabel())}"><div class="error" role="alert"></div><button class="btn primary">Подключить мой профиль</button></form><p style="margin-top:16px">Существующие устройства останутся подключёнными. Если старое устройство потеряно, используйте личный код восстановления.</p><button class="link-btn" data-action="restore">Аварийное восстановление</button>`;
  if (modal === "device-revoke") {
    const d = state?.devices?.find((d) => d.id === pendingDeviceId);
    body = `<div class="modal-icon">${icon("shield")}</div><h2>Отключить ${esc(d?.label || "устройство")}?</h2><p>Этот браузер больше не сможет читать или изменять ваш профиль. Данные и вход здесь сохранятся. Все выданные коды подключения также будут отменены. Это не удаляет уже скачанные файлы с отключённого устройства.</p><button class="btn danger" data-action="confirm-revoke-device">Отключить устройство</button><button class="btn outline" data-action="close">Отмена</button>`;
  }
  if (modal === "devices-revoke-others")
    body = `<div class="modal-icon">${icon("shield")}</div><h2>Отключить все остальные устройства?</h2><p>Вход сохранится только в текущем браузере. Коды подключения будут отменены. Пара, прогресс и памятка не изменятся. Выключить доступ к уже скачанным файлам невозможно.</p><button class="btn danger" data-action="confirm-revoke-others">Оставить только это устройство</button><button class="btn outline" data-action="close">Отмена</button>`;
  if (modal === "max-link")
    body = `<div class="modal-icon">${icon("shield")}</div><h2>Связать ваш профиль с MAX?</h2><p>Аккаунт MAX: ${esc(maxAuthPending?.name || "пользователь")}. В этом браузере открыт профиль «${esc(maxAuthPending?.profileName)}».</p><p>Связывайте их, только если оба принадлежат вам. Близкому нужно отдельное приглашение в пару.</p>${maxPlatform.release ? serviceInfo() : ""}<label class="checkbox"><input id="max-link-consent" type="checkbox"><span>Это мой профиль. Согласен сохранить идентификатор MAX для входа.</span></label><button class="btn primary" data-action="max-link-confirm" disabled>Связать мой профиль с MAX</button><button class="btn outline" data-action="max-clear-cached">Не связывать: выйти из этого профиля</button>`;
  if (modal === "restore")
    body = `<div class="modal-icon">${icon("shield")}</div><h2>Вернуться в своё пространство</h2><p>Введите личный код, который вы сохранили. Это не ссылка-приглашение. После восстановления доступ на всех прежних устройствах прекратится.</p><form id="restore-form"><label for="recovery-input">Ваш личный код</label><input id="recovery-input" name="code" autocomplete="off" spellcheck="false" maxlength="80" required placeholder="xxxx-xxxx-xxxx-xxxx-…"><div class="error" role="alert"></div><button class="btn primary">Восстановить доступ ${icon("arrow")}</button></form><p style="font-size:12px;margin-top:18px">Если личного кода нет, но вход сохранён на другом вашем устройстве, используйте подключение по одноразовому коду. Без кода и любого действующего входа восстановление невозможно.</p>`;
  if (modal === "recovery-new")
    body = `<div class="modal-icon">${icon("shield")}</div><h2>Получить новый личный код?</h2><p>Старый код перестанет работать сразу. Новый покажем только один раз. Сохраните его в надёжном месте; не отправляйте в общий чат.</p><button class="btn primary" data-action="generate-code">Получить новый код</button><button class="btn outline" data-action="close">Отмена</button>`;
  if (modal === "recovery-save")
    body = `<div class="modal-icon">${icon("shield")}</div><h2>Сохраните личный код</h2><p>Он вернёт доступ, если вы смените телефон или очистите браузер. Код показан только сейчас. Это ключ к вашему профилю — не передавайте его другим.</p><label for="recovery-secret">Личный код восстановления</label><input id="recovery-secret" class="recovery-code" readonly spellcheck="false" value="${esc(recoverySecret)}"><button class="btn outline" data-action="copy-code">${icon("copy")}Скопировать код</button>${maxPlatform.active ? '<p class="notice">В MAX сохраните код копированием в надёжное место. Повторный вход также доступен через ваш аккаунт MAX.</p>' : '<button class="btn outline" data-action="download-code">Скачать памятку с кодом</button>'}<label class="checkbox"><input type="checkbox" id="code-saved"><span>Я сохранил(а) код в надёжном месте.</span></label><button class="btn primary" data-action="code-done" disabled>Готово, продолжить ${icon("arrow")}</button><p style="font-size:12px;margin-top:18px">При использовании код меняется, а все прежние устройства теряют доступ. Код не отправляется близкому и не хранится в открытом виде на сервере.</p>`;
  if (modal === "logout")
    body = `<h2>Выйти на этом устройстве?</h2><p>${maxPlatform.active ? "Для возвращения закройте и снова откройте мини-приложение через тот же аккаунт MAX." : "Для возвращения понадобится ваш личный код восстановления. Убедитесь, что вы сохранили его."} Данные останутся в пространстве; выход не удаляет профиль.</p><button class="btn secondary" data-action="recovery-new">Сначала получить новый код</button><button class="btn danger" data-action="confirm-logout">${maxPlatform.active ? "Выйти" : "Код сохранён — выйти"}</button><button class="btn outline" data-action="close">Остаться</button>`;
  if (modal === "delete")
    body = `<div class="modal-icon">${icon("shield")}</div><h2>Удалить ваш профиль?</h2><p>Это нельзя отменить. Ваше имя и доступ будут удалены. Если в паре останется близкий, общие договорённости сохранятся у него. Если вы последний участник, все данные пространства удалятся.</p><button class="btn danger" data-action="confirm-delete">Да, удалить профиль</button><button class="btn outline" data-action="close">Не удалять</button>`;
  if (modal === "complete")
    body = `<div class="modal-icon">${icon("heart")}</div><h2>Закончить на сегодня?</h2><p>Занятие отметится завершённым${active()?.mode === "remote" ? " у обоих участников" : ""}. Ответы сохранятся, но новая договорённость не появится. Если есть неподтверждённое предложение, оно будет удалено. Убедитесь, что вы оба готовы закончить.</p><button class="btn primary" data-action="confirm-complete">Завершить без договорённости</button><button class="btn outline" data-action="close">Вернуться к разговору</button>`;
  if (modal === "consent")
    body = `<div class="modal-icon">${icon("shield")}</div><h2>${maxPlatform.release ? "Согласие на обработку данных" : "Согласие для тестового запуска"}</h2><p>Сохраняются имя или псевдоним, ответы, общие предложения и договорённости, названия подключённых устройств и время их обращений. При входе через MAX также сохраняется идентификатор аккаунта для повторного входа. Они используются для совместных занятий. Не вводите чувствительные данные. ${maxPlatform.release ? "Оператор и действующие документы указаны ниже." : "Юридические документы и оператор публичного сервиса ещё не определены."}</p>${serviceInfo()}<button class="btn outline" data-action="privacy">Прочитать о данных и ограничениях</button><button class="btn primary" data-action="confirm-consent">Согласен на хранение этих данных</button><p style="margin-top:16px">Для прекращения обработки можно удалить профиль в настройках. Общие договорённости остаются у напарника.</p>`;
  if (modal === "cancel")
    body = `<h2>Остановить эту историю?</h2><p>Ответы незавершённого занятия будут удалены у обоих участников. Позже можно начать заново.</p><button class="btn danger" data-action="confirm-cancel">Остановить занятие</button><button class="btn outline" data-action="close">Продолжить</button>`;
  if (modal === "invite-existing")
    body = `<h2>У вас уже есть пространство</h2><p>Для присоединения к другой паре сначала удалите текущий профиль в настройках. Выход не удаляет профиль и не освобождает место в паре.</p><button class="btn primary" data-action="existing-settings">Перейти в настройки</button><button class="btn outline" data-action="dismiss-invite">Остаться в своей паре</button>`;
  const art = ["register", "join", "invite"].includes(modal)
    ? '<div class="dialog-art"><img src="/art/invitation.webp" width="800" height="533" alt="" decoding="async"></div>'
    : "";
  body = body.replace("<h2>", '<h2 id="dialog-title">');
  modalRoot.innerHTML = `<div class="overlay"><section class="modal modal-${modal}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><button class="close" data-action="close" aria-label="Закрыть">${icon("close")}</button>${art}${body}</section></div>`;
  if (maxPlatform.active)
    modalRoot
      .querySelectorAll(
        '[data-action="restore"],[data-action="connect-device"]',
      )
      .forEach((el) => el.remove());
}
function inviteUrl() {
  return maxPlatform.inviteUrl(state.invite);
}
let stateRequest = 0;
async function sync() {
  const request = ++stateRequest,
    requestToken = token;
  try {
    if (!token || platformError || (maxPlatform.active && !maxIdentityChecked))
      return;
    const next = await api("/state");
    if (token !== requestToken || request !== stateRequest) return;
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    if (modal === "device-code" && !state.deviceCodeExpiresAt) {
      devicePairingSecret = null;
      renderModal();
    }
    if (offline) {
      offline = false;
      render();
    }
    if (changed) {
      let mustRender = false;
      if (page === "session") {
        const s = active();
        if (s?.revealed && stage === "waiting") stage = "review";
        if (s?.finished) mustRender = true;
        if (!s) {
          clearDraft();
          mustRender = true;
          page = "home";
          toast("Занятие остановлено. Можно начать заново.");
        }
      }
      if (mustRender || !document.querySelector("input:focus,textarea:focus"))
        render();
    }
  } catch (e) {
    if (request !== stateRequest || (token && token !== requestToken)) return;
    if (!token) {
      render();
      toast(
        maxPlatform.active
          ? "Доступ на этом устройстве завершён. Для входа закройте и снова откройте мини-приложение в MAX."
          : "Доступ на этом устройстве завершён. Для входа используйте актуальный личный код.",
      );
      return;
    }
    if (!offline) {
      offline = true;
      render();
    }
  }
}
function bindMaxBack() {
  maxPlatform.onBack(() => {
    if (modal) closeModal();
    else go("home");
  });
}
async function performMaxAuth(options = {}) {
  if (!maxPlatform.active)
    throw new Error(
      "Подписанные данные MAX отсутствуют. Откройте мини-приложение в MAX.",
    );
  const result = await api("/max/auth", {
    initData: maxPlatform.initData,
    ...options,
  });
  if (result.needsConsent || result.needsLinkConsent) {
    maxAuthPending = result;
    platformError = null;
    render();
    openModal(result.needsLinkConsent ? "max-link" : "register");
    return;
  }
  maxAuthPending = null;
  if (result.token) token = result.token;
  if (token) await maxPlatform.setToken(token);
  maxIdentityChecked = true;
  platformError = null;
  await sync();
  closeModal();
  render();
  if (result.recoveryCode) showRecovery(result.recoveryCode);
  if (result.inviteIgnored)
    toast(
      "У вас уже есть профиль. Приглашение не меняет вашу пару автоматически.",
    );
}
async function startLesson(lesson) {
  pendingLesson = lesson;
  if (!state) {
    if (maxPlatform.active) {
      try {
        await performMaxAuth();
      } catch (err) {
        platformError = err.message;
        render();
      }
      return;
    }
    if (maxPlatform.required || platformError) {
      toast(platformError || "Откройте приложение внутри MAX.");
      return;
    }
    openModal("register");
    return;
  }
  const s = state.sessions.find((s) => !s.finished);
  if (s) {
    resume(s.id);
    toast("Продолжим начатую историю. Чтобы выбрать другую, завершите эту.");
    return;
  }
  openModal("mode");
}
function resume(id) {
  pendingLesson = null;
  editingProposal = false;
  activeId = id;
  const s = active();
  if (!s) return;
  person =
    s.mode === "together"
      ? s.answered.includes("first")
        ? "second"
        : "first"
      : "first";
  stage = s.finished
    ? "done"
    : s.revealed
      ? s.proposal
        ? "agreement"
        : "review"
      : s.mode === "remote"
        ? s.answered.includes(state.me)
          ? "waiting"
          : "story"
        : s.answered.length
          ? "answer"
          : "story";
  choice = null;
  page = "session";
  closeModal();
  render();
  window.scrollTo(0, 0);
}
let privacyReturn = null;
document.addEventListener("click", async (e) => {
  const el = e.target.closest(
    "[data-nav],[data-action],[data-lesson],[data-filter],[data-mode],[data-choice],[data-resume],[data-revoke-device]",
  );
  if (!el) return;
  e.preventDefault();
  if (el.disabled) return;
  try {
    if (el.dataset.nav) {
      go(el.dataset.nav);
      return;
    }
    if (el.dataset.filter) {
      filter = el.dataset.filter;
      render();
      return;
    }
    if (el.dataset.lesson) {
      await startLesson(el.dataset.lesson);
      return;
    }
    if (el.dataset.resume) {
      resume(el.dataset.resume);
      return;
    }
    if (el.dataset.choice !== undefined) {
      choice = Number(el.dataset.choice);
      render();
      return;
    }
    if (el.dataset.revokeDevice) {
      pendingDeviceId = el.dataset.revokeDevice;
      openModal("device-revoke");
      return;
    }
    if (el.dataset.mode) {
      el.disabled = true;
      const result = await api("/start", {
        lesson: pendingLesson,
        mode: el.dataset.mode,
      });
      await sync();
      pendingLesson = null;
      resume(result.id);
      return;
    }
    switch (el.dataset.action) {
      case "open-collection":
        catalogCollection = el.dataset.collectionId;
        catalogMinutes = 0;
        catalogView = "all";
        catalogQuery = "";
        filter = "Все темы";
        go("lessons");
        break;
      case "legal-open":
        await maxPlatform.openExternal(el.dataset.legalUrl);
        break;
      case "save-lesson": {
        if (!state) {
          toast("Создайте профиль, чтобы сохранять личный список занятий.");
          return;
        }
        el.disabled = true;
        const profile = state.me;
        const saved = !state.savedLessons?.includes(el.dataset.saveLesson);
        const result = await api(
          "/lessons/" + el.dataset.saveLesson + "/saved",
          { saved },
        );
        if (state?.me !== profile) return;
        stateRequest++; // Discard any older poll started before this mutation.
        state.savedLessons = result.savedLessons;
        render();
        toast(
          saved
            ? "История сохранена в вашем избранном."
            : "История убрана из избранного.",
        );
        break;
      }
      case "catalog-view":
        catalogView = el.dataset.catalogView;
        render();
        break;
      case "catalog-reset":
        catalogCollection = "all";
        catalogMinutes = 0;
        catalogView = "all";
        catalogQuery = "";
        filter = "Все темы";
        render();
        break;
      case "open-saved":
        catalogCollection = "all";
        catalogMinutes = 0;
        catalogView = "saved";
        catalogQuery = "";
        filter = "Все темы";
        go("lessons");
        break;

      case "home":
        go("home");
        break;
      case "prepare-device":
        openModal("device-prepare");
        break;
      case "connect-device":
        if (state) {
          toast("Вы уже вошли. Для другого профиля сначала выйдите.");
          break;
        }
        pendingLesson = null;
        openModal("device-connect");
        break;
      case "generate-device-code": {
        el.disabled = true;
        devicePairingSecret = await api("/device-code", {});
        await sync();
        openModal("device-code");
        break;
      }
      case "copy-device-code":
        if (!devicePairingSecret || !state?.deviceCodeExpiresAt) {
          toast("Код больше не действует.");
          break;
        }
        try {
          await navigator.clipboard.writeText(devicePairingSecret.code);
          toast("Код скопирован. Используйте его только на своём устройстве.");
        } catch {
          $("#device-code-secret").select();
          toast("Скопируйте выделенный код вручную.");
        }
        break;
      case "cancel-device-code":
        await api("/device-code/cancel", {});
        devicePairingSecret = null;
        closeModal();
        await sync();
        render();
        toast("Код подключения отозван.");
        break;
      case "confirm-revoke-device":
        el.disabled = true;
        await api(`/devices/${pendingDeviceId}/revoke`, {});
        closeModal();
        await sync();
        render();
        toast("Устройство отключено.");
        break;
      case "revoke-others":
        openModal("devices-revoke-others");
        break;
      case "confirm-revoke-others":
        el.disabled = true;
        await api("/devices/revoke-others", {});
        closeModal();
        await sync();
        render();
        toast("Все остальные устройства отключены.");
        break;
      case "max-retry":
        try {
          el.disabled = true;
          await maxPlatform.init();
          bindMaxBack();
          if (!token) token = await maxPlatform.getToken();
          if (maxPlatform.active) await performMaxAuth();
          else {
            platformError = null;
            await sync();
            render();
            if (invite) openModal(token ? "invite-existing" : "join");
          }
        } catch (err) {
          platformError = err.message;
          render();
        }
        break;
      case "max-link-confirm":
        el.disabled = true;
        await performMaxAuth({ consent: true, linkExisting: true });
        break;
      case "max-clear-cached":
        if (token) {
          try {
            await api("/logout", {});
          } catch {}
        }
        token = null;
        state = null;
        await maxPlatform.setToken(null);
        clearLocalDrafts();
        closeModal();
        try {
          await performMaxAuth();
        } catch (err) {
          platformError = err.message;
          render();
        }
        break;
      case "restore":
        pendingLesson = null;
        openModal("restore");
        break;
      case "recovery-new":
        openModal("recovery-new");
        break;
      case "generate-code": {
        el.disabled = true;
        const r = await api("/recovery-code", {});
        await sync();
        showRecovery(r.recoveryCode);
        break;
      }
      case "copy-code":
        try {
          await navigator.clipboard.writeText(recoverySecret);
          toast("Код скопирован. Сохраните его в надёжном месте.");
        } catch {
          $("#recovery-secret").select();
          toast("Скопируйте выделенный код вручную.");
        }
        break;
      case "download-code":
        download(
          "ryadom-recovery.txt",
          `Рядом — личный код восстановления\n\nАдрес приложения: ${location.origin}\nКод: ${recoverySecret}\n\nХраните этот файл в надёжном месте. Код даёт доступ к вашему профилю. Не отправляйте его в чат.\nЧтобы вернуться: откройте приложение → «Войти по личному коду».\nПосле использования получите и сохраните новый код; все прежние устройства потеряют доступ.\n`,
        );
        toast("Памятка подготовлена для скачивания.");
        break;
      case "code-done":
        recoveryAcknowledged = true;
        closeModal();
        if (pendingLesson) openModal("mode");
        else render();
        break;
      case "export": {
        if (maxPlatform.active) {
          const ticket = await api("/max/export-ticket", {});
          await maxPlatform.download(ticket.url, ticket.fileName);
          toast("Файл передан на скачивание в MAX.");
          break;
        }
        const data = await api("/export");
        download(
          "ryadom-data.json",
          JSON.stringify(data, null, 2),
          "application/json",
        );
        toast("Ваши данные подготовлены для скачивания.");
        break;
      }
      case "font":
        large = !large;
        maxPlatform.writeSetting("ryadom-large", String(large));
        document.documentElement.classList.toggle("large", large);
        render();
        break;
      case "pair":
        go("family");
        break;
      case "register":
        pendingLesson = null;
        if (maxPlatform.active) {
          await performMaxAuth();
          break;
        }
        if (maxPlatform.required || platformError) {
          toast(platformError || "Откройте приложение в MAX.");
          break;
        }
        openModal("register");
        break;
      case "invite":
        if (!state) {
          pendingLesson = null;
          openModal("register");
        } else openModal("invite");
        break;
      case "close":
        closeModal();
        break;
      case "privacy":
        privacyReturn = modal;
        openModal("privacy");
        break;
      case "privacy-back":
        if (privacyReturn) {
          modal = privacyReturn;
          renderModal();
          privacyReturn = null;
        } else closeModal();
        break;
      case "copy": {
        try {
          await navigator.clipboard.writeText(inviteUrl());
          toast("Ссылка скопирована. Отправьте её близкому.");
        } catch {
          $("#invite-url").select();
          toast("Скопируйте выделенную ссылку вручную.");
        }
        break;
      }
      case "share":
        try {
          await maxPlatform.share(
            "Давай пройдём короткую историю вместе.",
            inviteUrl(),
          );
        } catch (err) {
          if (err?.name !== "AbortError")
            toast(
              err.message ||
                "Не удалось отправить приглашение. Скопируйте ссылку.",
            );
        }
        break;
      case "rotate":
        await api("/invite/rotate", {});
        await sync();
        renderModal();
        toast("Старая ссылка больше не действует.");
        break;
      case "to-answer": {
        const s = active();
        stage = s.revealed
          ? "review"
          : s.mode === "remote" && s.answered.includes(state.me)
            ? "waiting"
            : "answer";
        render();
        break;
      }
      case "answer": {
        el.disabled = true;
        const sid = activeId;
        await api(`/session/${sid}/answer`, { choice, person });
        await sync();
        const s = active();
        if (s.revealed) stage = "review";
        else if (s.mode === "together") {
          person = "second";
          choice = null;
          stage = "answer";
        } else stage = "waiting";
        render();
        break;
      }
      case "toggle-reviews":
        el.disabled = true;
        await api("/preferences", { reviews: !state.preferences?.reviews });
        await sync();
        render();
        toast(
          state.preferences?.reviews
            ? "Предложения повторить включены. Уведомлений не отправляем."
            : "Предложения повторить выключены.",
        );
        break;
      case "consent-renew":
        openModal("consent");
        break;
      case "confirm-consent":
        await api("/consent", { consent: true });
        await sync();
        closeModal();
        render();
        toast("Версия и дата согласия сохранены.");
        break;
      case "complete-session":
        openModal("complete");
        break;
      case "confirm-complete":
        el.disabled = true;
        await api(`/session/${activeId}/complete`, {});
        clearDraft();
        closeModal();
        await sync();
        stage = "done";
        render();
        window.scrollTo(0, 0);
        break;
      case "to-agreement":
        editingProposal = false;
        stage = "agreement";
        render();
        break;
      case "edit-proposal":
        editingProposal = true;
        render();
        break;
      case "reload-proposal":
        clearDraft();
        editingProposal = false;
        render();
        break;
      case "approve-proposal":
        el.disabled = true;
        await api(`/session/${activeId}/approve`, {
          revision: Number(el.dataset.revision),
        });
        await sync();
        render();
        break;
      case "refresh-proposal":
        await sync();
        render();
        if (!active()?.finished) toast("Пока ждём подтверждение близкого.");
        break;
      case "to-review":
        stage = "review";
        render();
        break;
      case "refresh":
        await sync();
        if (active()?.revealed) {
          stage = "review";
          render();
        } else toast("Пока ждём ответ близкого.");
        break;
      case "speak": {
        if (!("speechSynthesis" in window)) {
          toast(
            "В этом браузере озвучка недоступна. Можно прочитать историю на экране.",
          );
          break;
        }
        if (speechSynthesis.speaking) {
          speechSynthesis.cancel();
          toast("Озвучка остановлена");
          break;
        }
        const l = lessons.find((l) => l.id === active().lesson);
        const text =
          stage === "review"
            ? l.explanation + ". " + l.discussion
            : l.title + ". " + l.story;
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "ru-RU";
        u.rate = 0.85;
        u.onerror = () =>
          toast("Озвучка недоступна. Текст остаётся на экране.");
        speechSynthesis.speak(u);
        toast("Читаем вслух. Повторное нажатие остановит чтение.");
        break;
      }
      case "print":
        if (maxPlatform.active) {
          toast(
            "В MAX печать недоступна. Памятка остаётся здесь, данные можно скачать в настройках.",
          );
          break;
        }
        window.print();
        break;
      case "logout":
        openModal("logout");
        break;
      case "confirm-logout":
        el.disabled = true;
        await api("/logout", {});
        closeModal();
        await maxPlatform.setToken(null);
        clearLocalDrafts();
        token = null;
        state = null;
        go("home");
        toast(
          maxPlatform.active
            ? "Вы вышли. Для нового входа закройте и снова откройте мини-приложение в MAX."
            : "Вы вышли. Для возвращения используйте личный код.",
        );
        break;
      case "delete":
        openModal("delete");
        break;
      case "confirm-delete":
        await api("/account", null, "DELETE");
        await maxPlatform.setToken(null);
        clearLocalDrafts();
        token = null;
        state = null;
        closeModal();
        go("home");
        toast("Профиль удалён");
        if (invite) openModal("join");
        break;
      case "cancel-session":
        openModal("cancel");
        break;
      case "confirm-cancel":
        await api(`/session/${activeId}/cancel`, {});
        clearDraft();
        closeModal();
        await sync();
        go("home");
        break;
      case "existing-settings":
        closeModal();
        go("settings");
        break;
      case "dismiss-invite":
        invite = null;
        if (!maxPlatform.active) history.replaceState(null, "", "/");
        closeModal();
        break;
    }
  } catch (err) {
    if (el.dataset.action === "approve-proposal") await sync();
    toast(err.message);
    el.disabled = false;
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target,
    btn = form.querySelector("button[type=submit],button:not([type])");
  if (btn) btn.disabled = true;
  try {
    if (form.id === "restore-form") {
      const result = await api("/recover", {
        code: form.elements.code.value,
        deviceLabel: defaultDeviceLabel(),
      });
      token = result.token;
      await maxPlatform.setToken(token);
      invite = null;
      if (!maxPlatform.active) history.replaceState(null, "", "/");
      await sync();
      closeModal();
      go("home");
      showRecovery(result.recoveryCode);
    }
    if (form.id === "catalog-search") {
      catalogQuery = form.elements.query.value.trim().slice(0, 80);
      render();
      $("#catalog-query")?.focus();
      return;
    }
    if (form.id === "register-form") {
      if (maxPlatform.active) {
        await performMaxAuth({
          name: form.elements.name.value,
          consent: form.elements.consent.checked,
        });
        return;
      }
      if (maxPlatform.required || platformError)
        throw new Error("Регистрация доступна через запуск в MAX.");
      const name = form.elements.name.value.trim(),
        joining = modal === "join";
      const result = await api(joining ? "/join" : "/register", {
        name,
        consent: form.elements.consent.checked,
        deviceLabel: defaultDeviceLabel(),
        ...(joining ? { invite } : {}),
      });
      token = result.token;
      await maxPlatform.setToken(token);
      if (joining) {
        invite = null;
        if (!maxPlatform.active) history.replaceState(null, "", "/");
      }
      await sync();
      closeModal();
      render();
      showRecovery(result.recoveryCode);
    }
    if (form.id === "device-connect-form") {
      const result = await api("/connect-device", {
        code: form.elements.code.value,
        deviceLabel: form.elements.deviceLabel.value,
      });
      token = result.token;
      await maxPlatform.setToken(token);
      invite = null;
      if (!maxPlatform.active) history.replaceState(null, "", "/");
      await sync();
      closeModal();
      go("settings");
      toast("Ваш профиль подключён. Другие устройства остались в сети.");
    }
    if (form.id === "device-name-form") {
      await api("/device-name", { label: form.elements.label.value });
      await sync();
      render();
      toast("Название устройства сохранено.");
    }
    if (form.id === "name-form") {
      await api("/name", { name: form.elements.name.value });
      await sync();
      toast("Имя сохранено");
    }
    if (form.id === "agreement-form") {
      const remote = active().mode === "remote";
      await api(`/session/${activeId}/${remote ? "propose" : "finish"}`, {
        text: $("#agreement").value,
        revision: Number(form.dataset.revision),
      });
      clearDraft();
      editingProposal = false;
      await sync();
      stage = remote ? "agreement" : "done";
      render();
      window.scrollTo(0, 0);
    }
  } catch (err) {
    if (form.id === "agreement-form") {
      await sync();
      render();
    }
    const errEl = form.querySelector(".error");
    if (errEl) errEl.textContent = err.message;
    else toast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "agreement" && draftKey()) {
    sessionStorage.setItem(
      draftKey(),
      JSON.stringify({
        text: e.target.value,
        revision: Number(e.target.form.dataset.revision),
      }),
    );
  }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "catalog-collection") {
    catalogCollection = collections.some((c) => c.id === e.target.value)
      ? e.target.value
      : "all";
    render();
    $("#catalog-collection")?.focus();
    return;
  }
  if (e.target.id === "catalog-minutes") {
    catalogMinutes = [0, 5, 6].includes(Number(e.target.value))
      ? Number(e.target.value)
      : 0;
    render();
    $("#catalog-minutes")?.focus();
    return;
  }

  if (e.target.id === "max-link-consent") {
    const button = modalRoot.querySelector("[data-action=max-link-confirm]");
    if (button) button.disabled = !e.target.checked;
  }
  if (e.target.id === "code-saved") {
    const b = modalRoot.querySelector('[data-action="code-done"]');
    if (b) b.disabled = !e.target.checked;
  }
});
document.addEventListener("keydown", (e) => {
  if (!modal) return;
  if (e.key === "Escape") {
    closeModal();
    return;
  }
  if (e.key === "Tab") {
    const focusable = [
      ...modalRoot.querySelectorAll("button,a,input,textarea"),
    ].filter((e) => !e.disabled);
    const first = focusable[0],
      last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
root.innerHTML = '<div class="loading">Готовим ваше пространство…</div>';
if (!platformError) {
  if (maxPlatform.active) {
    try {
      await performMaxAuth();
    } catch (err) {
      platformError = err.message;
      render();
    }
  } else {
    await sync();
    render();
    if (invite) openModal(token ? "invite-existing" : "join");
  }
} else render();
bindMaxBack();
setInterval(() => {
  if (!document.hidden) sync();
}, 4000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) sync();
});
