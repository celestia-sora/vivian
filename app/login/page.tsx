"use client";

import { useEffect, useState } from "react";
import { getAuthToken, setAuthToken } from "@/lib/auth/fetch";

const VIVIANAUTH_LOGIN_URL = "https://vivianauth.celestiasora.workers.dev/login";

// /login is now a hop shim. The real sign-in form lives on the Cloudflare
// Workers app (vivianAuth). This page:
// 1. consumes `#token=...` after a successful Cloudflare sign-in,
// 2. stores it for API calls (authFetch sends it as Bearer),
// 3. returns to the app — or forwards to the Cloudflare login when absent.
export default function LoginPage(): React.JSX.Element {
  const [phase, setPhase] = useState<"checking" | "forwarding">("checking");

  useEffect(() => {
    try {
      const hash = window.location.hash;
      const match = hash.match(/#token=([^&]+)/);
      if (match?.[1]) {
        setAuthToken(decodeURIComponent(match[1]));
        window.history.replaceState(null, "", window.location.pathname);
        window.location.replace("/");
        return;
      }
      if (getAuthToken()) {
        window.location.replace("/");
        return;
      }
    } catch {
      // storage unavailable — fall through to the Cloudflare login
    }
    setPhase("forwarding");
    window.location.replace(VIVIANAUTH_LOGIN_URL);
  }, []);

  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh", background: "#e0d6ff", color: "#241329" }}>
      <p role="status" style={{ fontSize: 16 }}>
        {phase === "forwarding" ? "กำลังพาไปหน้าล็อกอิน…" : "กำลังตรวจสอบการล็อกอิน…"}
      </p>
    </main>
  );
}
