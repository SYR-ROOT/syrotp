import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

// One pooled client for the whole process. Drizzle is a thin wrapper.
//
// max=30: each verification flow does ~4 DB round-trips (auth lookup,
// pending-count, pick-receiver, insert). Under 50+ concurrent workers a
// pool of 10 queues queries head-of-line and blows p95 latency. 30 is
// a comfortable headroom for the v0.1.1 baseline workload (50 workers /
// scenario-a, 100 workers / scenario-b).
const client = postgres(config.DATABASE_URL, {
  max: 30,
  idle_timeout: 30,
  connect_timeout: 10,
  // postgres-js parameterizes everything; no string interpolation = no SQLi.
});

export const db = drizzle(client, { schema, logger: false });
export type DB = typeof db;
export { schema };

export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
