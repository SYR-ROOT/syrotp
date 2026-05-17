import type { FastifyError, FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { ApiError } from "../lib/errors.js";

// Wrapped with `fp` so setErrorHandler / setNotFoundHandler apply at the
// root scope, catching errors raised in sibling route plugins.
export const errorHandlerPlugin = fp(async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const requestId = req.id;

    if (err instanceof ApiError) {
      // Rate limit hint header.
      if (err.statusCode === 429 && err.details?.retry_after) {
        reply.header("Retry-After", String(err.details.retry_after));
      }
      return reply.code(err.statusCode).send(err.toJSON(requestId));
    }

    // Fastify validation errors.
    if (err.validation) {
      req.log.info({ err, requestId }, "validation error");
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: err.message,
          request_id: requestId,
          details: err.validation,
        },
      });
    }

    // Errors with a 4xx FastifyError statusCode are caller-shaped:
    // missing or bad credentials from @fastify/basic-auth, malformed
    // bodies from @fastify/sensible, etc. Honor their status code so
    // the dashboard's basic-auth flow surfaces 401 instead of 500.
    // Any preset response headers (e.g. WWW-Authenticate) flow through
    // because we don't reset the reply.
    const status = typeof err.statusCode === "number" ? err.statusCode : 0;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        error: {
          code: err.code ?? `http_${status}`,
          message: err.message || "request failed",
          request_id: requestId,
        },
      });
    }

    // Anything else: log full server-side, return generic to client.
    // This prevents leaking stack traces or internal paths.
    req.log.error({ err, requestId }, "unhandled error");
    return reply.code(500).send({
      error: {
        code: "internal_error",
        message: "internal error",
        request_id: requestId,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    return reply.code(404).send({
      error: { code: "not_found", message: "route not found", request_id: req.id },
    });
  });
}, { name: "syrotp-error-handler" });
