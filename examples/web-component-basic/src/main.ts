import "@syrotp/web-component";
import type { Verification } from "@syrotp/web-component";

const DEMO_VERIFICATION: Verification = {
  id: "vrf_demo000000000",
  status: "pending",
  send_to: "+963998887777",
  message: "VERIFY 123456",
  phone_masked: "+963 99* *** *567",
  expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  verified_at: null,
};

const el = document.getElementById("demo") as
  | (HTMLElement & { verification: Verification })
  | null;
if (!el) throw new Error("missing #demo");

el.verification = DEMO_VERIFICATION;
el.addEventListener("syrotp-verified", (e) =>
  console.log("verified", (e as CustomEvent<Verification>).detail),
);
el.addEventListener("syrotp-expired", (e) =>
  console.log("expired", (e as CustomEvent<Verification>).detail),
);
el.addEventListener("syrotp-cancelled", (e) =>
  console.log("cancelled", (e as CustomEvent<Verification>).detail),
);
el.addEventListener("syrotp-error", (e) =>
  console.error("syrotp error", (e as CustomEvent<Error>).detail),
);
