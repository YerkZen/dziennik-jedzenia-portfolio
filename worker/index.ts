import { registerStatisticsRoutes } from "./api/statistics";
import { apiHttpPolicy } from "./http-policy";
import { limitSessionAttempts } from "./rate-limit";
import { requireDomainOwner } from "./auth/owner";
import { Hono } from "hono";
import { registerSessionRoutes } from "./auth/session";
import { registerDayReadRoutes } from "./api/day-read";
import { registerLabelReadingRoutes } from "./api/label-reading";
import { registerProductRoutes } from "./api/products";
import { registerGoalWriteRoutes } from "./api/goals";
import { registerMealRoutes } from "./api/meals";
import { registerTemplateRoutes } from "./api/templates";
import { apiError, apiTransport } from "./transport";
import type { WorkerEnv } from "./types";
// Routes are registered here by implementation tasks. A registration callback
// also lets transport boundary tests attach a dependency spy without shipping a
// test endpoint in the Worker.
export type WorkerApp = Hono<WorkerEnv>;
export type RegisterWorkerRoutes = (app: WorkerApp) => void;

export function createApp(registerRoutes?: RegisterWorkerRoutes): WorkerApp {
  const app: WorkerApp = new Hono();
  app.use("*", apiHttpPolicy);
  app.use("/api", apiTransport);
  app.use("/api/*", apiTransport);
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.use("/api/v1/*", limitSessionAttempts);
  app.use("/api/v1/*", requireDomainOwner);
  registerSessionRoutes(app);
  registerDayReadRoutes(app);
  registerLabelReadingRoutes(app);
  registerProductRoutes(app);
  registerTemplateRoutes(app);
  registerMealRoutes(app);
  registerGoalWriteRoutes(app);
  registerStatisticsRoutes(app);
  registerRoutes?.(app);
  app.notFound((c) =>
    c.req.path === "/api" || c.req.path.startsWith("/api/")
      ? apiError(c, 404, "NOT_FOUND", "Nie znaleziono zasobu.")
      : c.text("Not Found", 404),
  );
  app.onError((error, c) => {
    void error;
    return c.req.path === "/api" || c.req.path.startsWith("/api/")
      ? apiError(c, 500, "INTERNAL_ERROR", "Wewnętrzny błąd serwera.")
      : c.text("Internal Server Error", 500);
  });
  return app;
}

const app = createApp();
export default app;
