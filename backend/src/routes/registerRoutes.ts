import type { Express } from "express";
import { ingestRouter } from "./ingest";
import { historyRouter } from "./history";
import { alertsRouter } from "./alerts";
import { suppressionsRouter } from "./suppressions";
import { dashboardRouter } from "./dashboard";

export function registerRoutes(app: Express) {
  app.use("/ingest", ingestRouter);
  app.use("/sensors", historyRouter);
  app.use("/alerts", alertsRouter);
  app.use("/suppressions", suppressionsRouter);
  app.use("/dashboard", dashboardRouter);
}

