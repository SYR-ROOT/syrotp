# `@syrotp/react` — basic example

Minimal Vite + React app demonstrating `<SyrotpVerification />`.

```bash
pnpm --filter @syrotp/example-react-basic dev
```

Then open the URL Vite prints (default `http://localhost:5173`).

The app uses a hardcoded `verification` object so you can see the
pending UI without running the SYROTP server. Status polling will
fail silently against `http://localhost:3000` unless you also have
the server running there — that's expected for a UI-only demo.

In a real app, your backend calls `startVerification()` (with the
secret SDK) and forwards the full result to your frontend, which
then renders `<SyrotpVerification verification={...} />`.
