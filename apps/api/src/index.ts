import "./load-env";
import { app } from "./app";

// Preserve the entry-point export used by backend integration tests and consumers.
export { app };

app.listen(process.env.PORT || 3001);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
