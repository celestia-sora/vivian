"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SESSION_COOKIE_MAX_AGE_SECONDS } from "@/lib/auth/cookie-config";
import { useCallback, useState } from "react";
import type { AuthConfiguration } from "@/lib/auth/config";

interface LoginCardProps {
  configuration: AuthConfiguration | null;
  error?: string;
}

const errors: Record<string, string> = {
  access_denied: "บัญชีนี้ยังไม่ได้รับเชิญค่ะ ลองเลือกบัญชี Google ที่ได้รับสิทธิ์อีกครั้งนะคะ",
  oauth_failed: "ยังเข้าสู่ระบบไม่สำเร็จ ลองเชื่อมต่อกับ Google อีกครั้งนะคะ",
  auth_unavailable: "ตอนนี้ยังเชื่อมต่อระบบล็อกอินไม่ได้ค่ะ กรุณาลองใหม่อีกสักครู่",
  session_expired: "ถึงเวลาเชื่อมต่อกันอีกครั้งค่ะ เข้าสู่ระบบเพื่อกลับไปคุยกับ Vivian ได้เลย",
};

function GoogleMark(): React.JSX.Element {
  return <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.22c1.88-1.73 2.99-4.28 2.99-7.36Z"/>
    <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.41l-3.22-2.51c-.9.6-2.05.97-3.39.97-2.61 0-4.83-1.76-5.62-4.12H3.06v2.59A10 10 0 0 0 12 22Z"/>
    <path fill="#FBBC05" d="M6.38 13.93A6 6 0 0 1 6.06 12c0-.67.12-1.32.32-1.93V7.48H3.06A10 10 0 0 0 2 12c0 1.61.39 3.14 1.06 4.52l3.32-2.59Z"/>
    <path fill="#EA4335" d="M12 5.95c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.63 9.63 0 0 0 12 2a10 10 0 0 0-8.94 5.48l3.32 2.59C7.17 7.71 9.39 5.95 12 5.95Z"/>
  </svg>;
}

export default function LoginCard({ configuration, error }: LoginCardProps): React.JSX.Element {
  const [connecting, setConnecting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const message = loginError ?? (error ? errors[error] : undefined);
  const signIn = useCallback(async (): Promise<void> => {
    if (!configuration || connecting) return;
    setConnecting(true);
    setLoginError(null);
    try {
      const supabase = createBrowserClient(configuration.url, configuration.publishableKey, {
        cookieOptions: {
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
          sameSite: "lax",
          secure: window.location.protocol === "https:",
          path: "/",
        },
      });
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: new URL("/auth/callback", window.location.origin).toString(),
          queryParams: { prompt: "select_account" },
        },
      });
      if (oauthError) throw oauthError;
    } catch {
      setLoginError(errors.oauth_failed);
      setConnecting(false);
    }
  }, [configuration, connecting]);

  return <main className="login-shell" lang="th">
    <div className="login-aurora" aria-hidden="true" />
    <header className="login-brand"><span className="brand-mark" aria-hidden="true"/>Vivian<span className="login-brand-note">a little closer to you</span></header>
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-constellation" aria-hidden="true">
        <span className="login-orbit login-orbit-outer"/><span className="login-orbit login-orbit-inner"/>
        <span className="login-star login-star-one">✦</span><span className="login-star login-star-two">✧</span><span className="login-star login-star-three">✦</span>
        <div className="login-moon"><svg viewBox="0 0 64 64" fill="none"><path d="M46 47a24 24 0 0 1-26-36 24 24 0 1 0 26 36Z" fill="url(#moon-glow)"/><defs><linearGradient id="moon-glow" x1="12" y1="12" x2="48" y2="54" gradientUnits="userSpaceOnUse"><stop stopColor="#fff3dc"/><stop offset="1" stopColor="#d2b2f6"/></linearGradient></defs></svg></div>
      </div>
      <p className="login-eyebrow">YOUR OWN LITTLE UNIVERSE</p>
      <h1 id="login-title">กลับมาแล้ว <span>ฉันจำได้</span></h1>
      <p className="login-description">พื้นที่ของคุณกับ Vivian<br/>วันนี้มีอะไรจะเล่าก็พูดมาตรง ๆ</p>
      <button className="google-login-button" type="button" onClick={signIn} disabled={!configuration || connecting} aria-busy={connecting}>
        {connecting ? <span className="login-spinner" aria-hidden="true"/> : <GoogleMark/>}
        <span>{connecting ? "กำลังพาคุณไปหา Google…" : "เข้าสู่ระบบด้วย Google"}</span>
        {!connecting && <svg className="login-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      </button>
      <div className="login-feedback" aria-live="polite" aria-atomic="true">
        {!configuration ? <p>กำลังเตรียมประตูสู่ Vivian ค่ะ<br/>เจ้าของพื้นที่จะเปิดให้เข้ามาได้เร็ว ๆ นี้</p> : message ? <p role="alert">{message}</p> : null}
      </div>
      <div className="login-private-note"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg><span>พื้นที่ส่วนตัว · เฉพาะบัญชีที่ได้รับเชิญ</span></div>
    </section>
    <footer className="login-footer"><span>made for moments that matter</span><span>Vivian Personal Project <span aria-hidden="true">✦</span></span></footer>
  </main>;
}
