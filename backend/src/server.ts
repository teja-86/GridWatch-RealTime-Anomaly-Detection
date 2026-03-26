import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import { Server as SocketIOServer } from "socket.io";
import { env } from "./env";
import { attachRealtime } from "./realtime";
import { startWorkers } from "./workers/startWorkers";
import { registerRoutes } from "./routes/registerRoutes";

async function main() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  registerRoutes(app);

  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: true,
    },
  });
  attachRealtime(io);

  try {
    startWorkers(io);
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error("Worker start failure", e);
    process.exit(1);
  }

  server.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`GridWatch backend listening on :${env.port}`);
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error", e);
  process.exit(1);
});

