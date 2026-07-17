import { loadConfig } from "./config.js";
import { createHttpApp } from "./http/app.js";

const config = loadConfig(process.env);
const app = createHttpApp({
  config,
  mcpHandler: (_request, response) => {
    response.sendStatus(501);
  }
});
const server = app.listen(config.port);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        process.exitCode = 1;
      }
    });
  });
}
