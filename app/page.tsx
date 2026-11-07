import Companion from "./companion";

export const dynamic = "force-dynamic";

// Sign-in is delegated to the Cloudflare Workers app (vivianAuth): the
// Companion gates itself client-side (auth token in localStorage, see
// lib/auth/fetch) and bounces to /login → vivianAuth when absent.
export default function Home(): React.JSX.Element {
  return <Companion accountEmail="" accountId="web" />;
}
