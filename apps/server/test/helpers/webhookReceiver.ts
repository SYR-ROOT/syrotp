/**
 * Test helper: spins up a real `http.createServer` so the webhook
 * worker's outbound POST hits an actual socket. Captures every
 * request's headers + body so tests can verify the
 * `X-SYROTP-Webhook-*` contract and the HMAC signature without
 * mocking `fetch`.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ReceivedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type ReceiverHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

export interface TestReceiver {
  url: string;
  requests: ReceivedRequest[];
  /** Replace the response handler at runtime (e.g. flip from 200 to 500). */
  setHandler(fn: ReceiverHandler): void;
  close(): Promise<void>;
}

export async function startTestReceiver(): Promise<TestReceiver> {
  const requests: ReceivedRequest[] = [];
  let handler: ReceiverHandler = (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  };

  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers },
        body,
      });
      try {
        handler(req, res, body);
      } catch {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/syrotp-hook`;

  return {
    url,
    requests,
    setHandler(fn) {
      handler = fn;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * Re-implement the receiver-side signature check from scratch so the
 * test isn't validating against the same code that signed. Verifies
 * `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` with constant-time
 * comparison.
 */
export function verifySignature(
  secret: string,
  rawBody: string,
  timestamp: string,
  signatureHex: string,
): boolean {
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHex, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
