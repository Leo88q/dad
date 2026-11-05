import { readConfig } from "../lib/config.js";
try {
  const config = readConfig({ ...process.env, NODE_ENV: "production" });
  console.log(
    JSON.stringify(
      {
        configurationValid: true,
        channel: "MAX",
        publicURL: config.publicURL,
        policyVersion: config.release.policyVersion,
        note: "Проверена только конфигурация. Доступность документов, TLS, бот, резервные копии и реальные клиенты проверяются отдельно.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
