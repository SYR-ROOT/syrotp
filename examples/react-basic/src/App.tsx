import { useState } from "react";
import { SyrotpVerification, type Verification } from "@syrotp/react";

const DEMO_VERIFICATION: Verification = {
  id: "vrf_demo000000000",
  status: "pending",
  send_to: "+963998887777",
  message: "VERIFY 123456",
  phone_masked: "+963 99* *** *567",
  expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  verified_at: null,
};

export default function App() {
  const [v] = useState(DEMO_VERIFICATION);

  return (
    <main
      style={{
        padding: 24,
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: 640,
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: 22 }}>SYROTP — React example</h1>
      <p style={{ color: "#4b5563", lineHeight: 1.5 }}>
        In production your backend calls{" "}
        <code>syrotpClient.startVerification(...)</code> via the secret SDK and
        forwards the full result to your frontend. This example uses a hardcoded{" "}
        <code>verification</code> so you can see the UI; status polling is a
        no-op against <code>http://localhost:3000</code> unless an SYROTP server
        is also running there.
      </p>
      <SyrotpVerification
        baseUrl="http://localhost:3000"
        verification={v}
        onVerified={(v) => console.log("verified", v)}
        onExpired={(v) => console.log("expired", v)}
        onCancelled={(v) => console.log("cancelled", v)}
        onError={(err) => console.error("syrotp error", err)}
      />
    </main>
  );
}
