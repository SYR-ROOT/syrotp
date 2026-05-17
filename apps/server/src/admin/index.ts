/**
 * Public entry to the admin module. The CLI imports from
 * `@syrotp/server/admin` (declared in apps/server/package.json's exports
 * map). This sub-export deliberately does NOT pull in Fastify or any
 * route plugins — it's only DB + crypto + phone validation.
 */
export { bootstrapApp, type BootstrapAppOptions, type BootstrapAppResult } from "./bootstrap.js";
export {
  AdminError,
  addReceiver,
  disableReceiver,
  enableReceiver,
  listReceivers,
  type AddReceiverOptions,
  type AddReceiverResult,
  type DisableReceiverResult,
  type EnableReceiverResult,
  type ListReceiversOptions,
  type ReceiverRecord,
} from "./receivers.js";
export { closeDb } from "../db/index.js";

// Note: testReceiver is NOT re-exported here — it lives at
// `@syrotp/server/admin/probe` precisely so importing it does not load
// the DB/Redis-coupled receivers.ts module.
