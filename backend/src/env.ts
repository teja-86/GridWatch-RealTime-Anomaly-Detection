import dotenv from "dotenv";

dotenv.config();

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  seedOnStartup: (process.env.SEED_ON_STARTUP ?? "false").toLowerCase() === "true",
  logLevel: process.env.LOG_LEVEL ?? "info",

  // For local manual testing only. If empty, default actor will be supervisor after DB seed.
  defaultActorId: process.env.DEFAULT_ACTOR_ID ?? "",
};

