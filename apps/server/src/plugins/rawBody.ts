import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

/**
 * Capture the raw request body as a Buffer at request.rawBody. Required for
 * HMAC verification: we must hash the *exact* bytes the client signed, not
 * a re-serialized JSON which may differ in spacing/key order.
 *
 * We attach this for application/json POSTs only; everything else flows
 * through Fastify's default parser unchanged.
 *
 * Wrapped with `fp` so the parser is registered at the root scope and
 * applies to every route plugin's POST handlers.
 */
declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export const rawBodyPlugin = fp(async function rawBodyPlugin(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      // body is Buffer when parseAs is "buffer".
      const buf = body as Buffer;
      req.rawBody = buf;
      if (buf.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        done(null, parsed);
      } catch (err) {
        // Use standard "FST_ERR_CTP_INVALID_JSON" semantics: 400.
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e, undefined);
      }
    },
  );
}, { name: "syrotp-raw-body" });
