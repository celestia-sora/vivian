import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedUser, isSameOriginMutation } from "../lib/auth/policy.ts";

const user = (email, extras = {}) => ({ email, email_confirmed_at: "2026-10-02T00:00:00Z", is_anonymous: false, ...extras });

test("any non-anonymous account with a confirmed email can access during the hackathon", () => {
  assert.equal(isAllowedUser(user("suphloeksangko@gmail.com")), true);
  assert.equal(isAllowedUser(user("duckchan690@gmail.com")), true);
  assert.equal(isAllowedUser(user(" SUPHLOEKSANGKO@GMAIL.COM ")), true);
  assert.equal(isAllowedUser(user("contestant@example.com")), true);
});

test("unconfirmed, anonymous, and missing-email identities cannot access", () => {
  for (const identity of [null, user(undefined), user("", { email_confirmed_at: "2026-10-02T00:00:00Z" }),
    user("suphloeksangko@gmail.com", { email_confirmed_at: null }),
    user("duckchan690@gmail.com", { is_anonymous: true }),
    user("attacker@example.com", { user_metadata: { email: "duckchan690@gmail.com", email_verified: true } }),
  ]) assert.equal(isAllowedUser(identity), false);
});

test("cookie-authenticated mutations reject cross-site origins", () => {
  const url = "https://vivian-chan.vercel.app/api/memory";
  assert.equal(isSameOriginMutation(new Request(url, { method: "POST", headers: { origin: "https://vivian-chan.vercel.app" } })), true);
  assert.equal(isSameOriginMutation(new Request(url, { method: "POST", headers: { origin: "https://evil.example" } })), false);
  assert.equal(isSameOriginMutation(new Request(url, { method: "POST", headers: { origin: "null" } })), false);
  assert.equal(isSameOriginMutation(new Request(url, { method: "POST", headers: { "sec-fetch-site": "cross-site" } })), false);
  assert.equal(isSameOriginMutation(new Request(url, { method: "GET" })), true);
  assert.equal(isSameOriginMutation(new Request("https://localhost/api/memory", { method: "POST", headers: { host: "vivian-chan.vercel.app", origin: "https://vivian-chan.vercel.app" } })), true);
});
