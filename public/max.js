// MAX Bridge integration. No initDataUnsafe values are used for authentication.
export const maxPlatform = (() => {
  let bridge = null,
    config = { maxEnabled: false, maxBotName: "", maxOnly: false },
    backHandler = null;
  let closing = null,
    protectedScreen = null;
  const memory = new Map();
  // A missing/old Bridge must not leave the entire interface waiting forever.
  const bounded = (action, ms = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("MAX не ответил вовремя.")),
        ms,
      );
      Promise.resolve()
        .then(action)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  const read = (key) => {
    if (memory.has(key)) return memory.get(key);
    try {
      return localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  };
  const write = (key, value) => {
    memory.set(key, value);
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  };
  async function init() {
    try {
      const r = await bounded(() => fetch("/api/runtime-config"), 8000);
      if (!r.ok) throw new Error();
      config = await bounded(() => r.json(), 8000);
    } catch {
      throw new Error(
        "Не удалось загрузить настройки приложения. Обновите страницу.",
      );
    }
    if (!window.WebApp && config.maxEnabled) {
      await new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "https://st.max.ru/js/max-web-app.js";
        script.async = true;
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve();
          }
        };
        const timer = setTimeout(finish, 6000);
        script.onload = finish;
        script.onerror = finish;
        document.head.append(script);
      });
    }
    bridge =
      window.WebApp &&
      typeof window.WebApp.initData === "string" &&
      window.WebApp.initData
        ? window.WebApp
        : null;
    if (config.maxOnly && !bridge)
      throw new Error(
        "Откройте это мини-приложение через бота в MAX. Подписанные данные запуска не получены.",
      );
    if (bridge) {
      document.documentElement.classList.add("in-max");
      try {
        const size = await bounded(() => bridge.getViewportSize?.(), 1000);
        const height = Number.parseFloat(size?.height);
        if (Number.isFinite(height) && height >= 100)
          document.documentElement.style.setProperty(
            "--max-viewport-height",
            height + "px",
          );
      } catch {}
    }
    return config;
  }
  async function getToken() {
    if (bridge && bridge.platform !== "web" && bridge.SecureStorage?.getItem) {
      try {
        const token = await bounded(() =>
          bridge.SecureStorage.getItem("ryadom-token"),
        );
        if (token) return token;
      } catch {}
    }
    return read("ryadom-token");
  }
  async function setToken(token) {
    // In native MAX prefer encrypted storage; local fallback is needed for web/unsupported clients.
    if (bridge && bridge.platform !== "web" && bridge.SecureStorage) {
      try {
        if (token) {
          await bounded(() =>
            bridge.SecureStorage.setItem("ryadom-token", token),
          );
          write("ryadom-token", null);
          return;
        }
        await bounded(() => bridge.SecureStorage.removeItem("ryadom-token"));
      } catch {}
    }
    write("ryadom-token", token);
  }
  function inviteUrl(invite) {
    if (config.maxBotName)
      return `https://max.ru/${config.maxBotName}?startapp=invite_${invite}`;
    if (bridge)
      throw new Error(
        "На сервере не задан MAX_BOT_NAME. Приглашение в MAX пока недоступно.",
      );
    return `${location.origin}/?invite=${invite}`;
  }
  async function share(text, link) {
    if (bridge) {
      if (!bridge.shareMaxContent)
        throw new Error(
          "Клиент MAX не поддерживает отправку приглашения. Скопируйте ссылку.",
        );
      try {
        await bridge.shareMaxContent({ text, link });
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        throw new Error(
          "MAX не смог отправить приглашение. Скопируйте ссылку и отправьте близкому.",
        );
      }
      return;
    }
    if (navigator.share)
      await navigator.share({ title: "Побудем рядом?", text, url: link });
    else throw new Error("Скопируйте ссылку и отправьте её близкому.");
  }
  function onBack(callback) {
    if (!bridge?.BackButton) return;
    if (backHandler) bridge.BackButton.offClick?.(backHandler);
    backHandler = callback;
    bridge.BackButton.onClick(callback);
  }
  function syncUI({ back, unsaved, sensitive }) {
    if (!bridge) return;
    try {
      if (back) bridge.BackButton?.show();
      else bridge.BackButton?.hide();
    } catch {}
    if (closing !== unsaved) {
      closing = unsaved;
      try {
        if (unsaved) bridge.enableClosingConfirmation?.();
        else bridge.disableClosingConfirmation?.();
      } catch {}
    }
    if (protectedScreen !== sensitive) {
      protectedScreen = sensitive;
      try {
        const result = sensitive
          ? bridge.ScreenCapture?.disableScreenCapture?.()
          : bridge.ScreenCapture?.enableScreenCapture?.();
        Promise.resolve(result).catch(() => {});
      } catch {}
    }
  }
  async function download(url, name) {
    let address;
    try {
      address = new URL(url);
    } catch {
      throw new Error("Неверный адрес скачивания.");
    }
    if (address.protocol !== "https:" || address.username || address.password)
      throw new Error("Для скачивания нужен безопасный HTTPS-адрес.");
    if (bridge?.platform === "web") {
      if (!bridge.openLink)
        throw new Error(
          "Откройте мини-приложение в мобильном MAX для скачивания.",
        );
      try {
        await bridge.openLink(address.href);
        return;
      } catch {
        throw new Error("Не удалось открыть файл. Попробуйте ещё раз.");
      }
    }
    if (!bridge?.downloadFile)
      throw new Error("Этот клиент MAX не поддерживает скачивание файла.");
    try {
      await bridge.downloadFile(address.href, name);
    } catch {
      throw new Error("MAX не смог скачать файл. Попробуйте ещё раз.");
    }
  }
  return {
    init,
    getToken,
    setToken,
    readSetting: read,
    writeSetting: write,
    inviteUrl,
    share,
    onBack,
    syncUI,
    download,
    async openExternal(url) {
      const address = new URL(url);
      if (address.protocol !== "https:" || address.username || address.password)
        throw new Error("Небезопасная ссылка.");
      if (bridge) {
        if (!bridge.openLink)
          throw new Error("Этот клиент MAX не поддерживает открытие ссылки.");
        await bridge.openLink(address.href);
      } else window.open(address.href, "_blank", "noopener,noreferrer");
    },
    get release() {
      return config.release || null;
    },
    get active() {
      return !!bridge;
    },
    get required() {
      return config.maxOnly;
    },
    get configured() {
      return config.maxEnabled;
    },
    get botName() {
      return config.maxBotName;
    },
    get initData() {
      return bridge?.initData || "";
    },
    get platform() {
      return bridge?.platform || "browser";
    },
  };
})();
