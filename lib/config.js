import { isAbsolute } from "node:path";
import { isIP } from "node:net";
export function readConfig(env = process.env) {
  const production = env.NODE_ENV === "production",
    errors = [];
  const text = (key) => String(env[key] || "").trim();
  const maxBotToken = text("MAX_BOT_TOKEN"),
    maxBotName = text("MAX_BOT_NAME"),
    maxOnly = env.MAX_ONLY === "true";
  const dataDir = text("DATA_DIR") || "./data";
  function publicURL(key, { origin = false } = {}) {
    const raw = text(key);
    let url;
    try {
      url = new URL(raw);
    } catch {
      errors.push(`${key}: нужен полный HTTPS-адрес`);
      return "";
    }
    const host = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      isIP(host) ||
      !host.includes(".") ||
      /(^|\.)(localhost|local|invalid|test|example)$/.test(host) ||
      /(^|\.)example\.(com|org|net)$/.test(host) ||
      (url.port && url.port !== "443") ||
      (origin && (url.pathname !== "/" || url.search))
    )
      errors.push(
        `${key}: нужен публичный HTTPS-${origin ? "origin без пути" : "адрес"} без тестовых доменов, пароля и фрагмента`,
      );
    return url.href;
  }
  if (maxOnly && !maxBotToken) errors.push("MAX_ONLY требует MAX_BOT_TOKEN");
  if (maxBotName && !/^[A-Za-z0-9_]{1,64}$/.test(maxBotName))
    errors.push("MAX_BOT_NAME: username без @, латиница/цифры/подчёркивание");
  let release = null,
    publicURLValue = text("PUBLIC_URL");
  if (production) {
    if (!maxOnly) errors.push("В production требуется MAX_ONLY=true");
    if (!maxBotToken) errors.push("MAX_BOT_TOKEN не задан");
    if (!maxBotName) errors.push("MAX_BOT_NAME не задан");
    if (!isAbsolute(dataDir))
      errors.push("DATA_DIR: нужен абсолютный путь постоянного хранилища");
    publicURLValue = publicURL("PUBLIC_URL", { origin: true });
    const operatorName = text("OPERATOR_NAME"),
      supportEmail = text("SUPPORT_EMAIL"),
      policyVersion = text("DATA_POLICY_VERSION");
    if (
      operatorName.length < 2 ||
      operatorName.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(operatorName)
    )
      errors.push("OPERATOR_NAME: задайте название оператора (2–200 символов)");
    if (
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(
        supportEmail,
      ) ||
      supportEmail.length > 254 ||
      /(?:@|\.)(?:invalid|test|example|localhost|local)$/i.test(supportEmail) ||
      /@(?:[^@]+\.)?example\.(?:com|org|net)$/i.test(supportEmail)
    )
      errors.push("SUPPORT_EMAIL: задайте корректную почту поддержки");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(policyVersion))
      errors.push("DATA_POLICY_VERSION: задайте версию политики/согласия");
    release = {
      operatorName,
      supportEmail,
      policyVersion,
      privacyURL: publicURL("PRIVACY_POLICY_URL"),
      termsURL: publicURL("TERMS_URL"),
    };
  }
  if (errors.length)
    throw new Error(
      "Настройки запуска не прошли проверку:\n" +
        errors.map((error) => "— " + error).join("\n"),
    );
  return {
    production,
    maxBotToken,
    maxBotName: /^[A-Za-z0-9_]{1,64}$/.test(maxBotName) ? maxBotName : "",
    maxOnly,
    dataDir,
    publicURL: publicURLValue,
    release,
  };
}
