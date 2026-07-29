import { test } from "node:test";
import assert from "node:assert/strict";

import { mailkite, MailKiteSendError, templates } from "../index.js";

/** Collect every send the adapter attempts, and control the response. */
function stubFetch({ ok = true, status = 200, body = { id: "msg_1", status: "sent" } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, message: JSON.parse(init.body) });
    return {
      ok,
      status,
      statusText: ok ? "OK" : "Bad Request",
      text: async () => JSON.stringify(body),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** An adapter wired to a stub, with sends awaited so assertions are deterministic. */
function adapter(overrides = {}, fetchOpts) {
  const fetchImpl = stubFetch(fetchOpts);
  const mk = mailkite({
    apiKey: "mk_live_test",
    from: "auth@acme.com",
    appName: "Acme",
    appUrl: "https://acme.com",
    awaitSend: true,
    fetch: fetchImpl,
    ...overrides,
  });
  return { mk, fetchImpl };
}

// --- config -----------------------------------------------------------------

test("throws without a credential", () => {
  assert.throws(() => mailkite({ from: "a@b.com", apiKey: undefined, fetch: stubFetch() }), /apiKey/);
});

test("throws without a from address", () => {
  assert.throws(() => mailkite({ apiKey: "mk_live_x" }), /`from` is required/);
});

test("accepts getToken instead of apiKey", async () => {
  const fetchImpl = stubFetch();
  const mk = mailkite({
    getToken: async () => "oauth_token_abc",
    from: "auth@acme.com",
    awaitSend: true,
    fetch: fetchImpl,
  });
  await mk.sendMagicLink({ email: "u@x.com", token: "t", url: "https://acme.com/m?t=1" });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer oauth_token_abc");
});

test("appName falls back to the from domain", async () => {
  const { mk, fetchImpl } = adapter({ appName: undefined });
  await mk.sendMagicLink({ email: "u@x.com", token: "t", url: "https://acme.com/m" });
  assert.match(fetchImpl.calls[0].message.subject, /acme\.com/);
});

// --- each callback ----------------------------------------------------------

test("sendMagicLink posts to /v1/send with the link in both bodies", async () => {
  const { mk, fetchImpl } = adapter();
  await mk.sendMagicLink({ email: "u@x.com", token: "t", url: "https://acme.com/magic?token=abc" });

  const { url, message } = fetchImpl.calls[0];
  assert.equal(url, "https://api.mailkite.dev/v1/send");
  assert.equal(message.from, "auth@acme.com");
  assert.equal(message.to, "u@x.com");
  assert.equal(message.subject, "Sign in to Acme");
  assert.match(message.html, /https:\/\/acme\.com\/magic\?token=abc/);
  assert.match(message.text, /https:\/\/acme\.com\/magic\?token=abc/);
});

test("sendVerificationEmail reads the nested user object", async () => {
  const { mk, fetchImpl } = adapter();
  await mk.sendVerificationEmail({ user: { email: "u@x.com", name: "Ada" }, url: "https://acme.com/v", token: "t" });

  const { message } = fetchImpl.calls[0];
  assert.equal(message.to, "u@x.com");
  assert.match(message.html, /Hi Ada/);
  assert.equal(message.subject, "Verify your email for Acme");
});

test("sendResetPassword works without a name", async () => {
  const { mk, fetchImpl } = adapter();
  await mk.sendResetPassword({ user: { email: "u@x.com" }, url: "https://acme.com/r", token: "t" });

  const { message } = fetchImpl.calls[0];
  assert.equal(message.subject, "Reset your Acme password");
  assert.match(message.html, /We got a request/);
  assert.doesNotMatch(message.html, /Hi ,/);
});

test("sendVerificationOTP renders the code and varies copy by type", async () => {
  for (const [type, expected] of [
    ["sign-in", "Your Acme sign-in code"],
    ["email-verification", "Verify your email for Acme"],
    ["forget-password", "Reset your Acme password"],
    ["change-email", "Confirm your new email for Acme"],
  ]) {
    const { mk, fetchImpl } = adapter();
    await mk.sendVerificationOTP({ email: "u@x.com", otp: "123456", type });
    assert.equal(fetchImpl.calls[0].message.subject, expected);
    assert.match(fetchImpl.calls[0].message.html, /123456/);
    assert.match(fetchImpl.calls[0].message.text, /123456/);
  }
});

test("change-email OTP does not reuse the signup verification wording", async () => {
  // Confirming a new address is not verifying a signup. Sending "verify your email" to
  // an address the user just typed reads as a phish; Better Auth added this fourth type
  // after 0.1.0 shipped, and it silently fell through to sign-in copy.
  const { mk, fetchImpl } = adapter();
  await mk.sendVerificationOTP({ email: "new@x.com", otp: "123456", type: "change-email" });
  const { subject, html } = fetchImpl.calls[0].message;
  assert.match(subject, /Confirm your new email/);
  assert.doesNotMatch(html, /Verify your email/i);
  assert.doesNotMatch(html, /Sign in/i);
});

test("the two callbacks Better Auth types as Promise<void> return promises even when backgrounded", async () => {
  // emailOTP and organization require Promise<void>; the others accept void. If upstream
  // tightens the rest, `npm run typecheck` fails before this does — both are deliberate.
  const { mk } = adapter({ awaitSend: false });
  const otp = mk.sendVerificationOTP({ email: "u@x.com", otp: "123456", type: "sign-in" });
  const invite = mk.sendInvitationEmail({ id: "inv_1", email: "u@x.com" });
  assert.ok(otp instanceof Promise);
  assert.ok(invite instanceof Promise);
  await Promise.all([otp, invite]);
});

test("sendVerificationOTP falls back to sign-in copy for an unknown type", async () => {
  const { mk, fetchImpl } = adapter();
  await mk.sendVerificationOTP({ email: "u@x.com", otp: "999000", type: "something-new" });
  assert.equal(fetchImpl.calls[0].message.subject, "Your Acme sign-in code");
});

test("sendInvitationEmail builds the accept URL from appUrl", async () => {
  const { mk, fetchImpl } = adapter();
  await mk.sendInvitationEmail({
    id: "inv_123",
    email: "new@x.com",
    organization: { name: "Widgets Ltd" },
    inviter: { user: { name: "Ada" } },
    role: "admin",
  });

  const { message } = fetchImpl.calls[0];
  assert.match(message.html, /https:\/\/acme\.com\/accept-invitation\/inv_123/);
  assert.match(message.html, /Widgets Ltd/);
  assert.match(message.html, /Ada invited you/);
  assert.match(message.html, /as admin/);
});

test("invitationUrl overrides the default path", async () => {
  const { mk, fetchImpl } = adapter({
    invitationUrl: (id) => `https://acme.com/join#${id}`,
  });
  await mk.sendInvitationEmail({ id: "inv_9", email: "n@x.com" });
  assert.match(fetchImpl.calls[0].message.html, /https:\/\/acme\.com\/join#inv_9/);
});

test("invitation without appUrl or invitationUrl reports a config error and sends nothing", async () => {
  const errors = [];
  const { mk, fetchImpl } = adapter({ appUrl: undefined, onError: (e, m) => errors.push([e, m]) });
  await mk.sendInvitationEmail({ id: "inv_1", email: "n@x.com" });

  assert.equal(fetchImpl.calls.length, 0);
  assert.match(errors[0][0].message, /appUrl.*invitationUrl/);
  assert.equal(errors[0][1].type, "invitation");
});

// --- security properties ----------------------------------------------------

test("a failed send never rejects to the caller", async () => {
  const errors = [];
  const { mk } = adapter({ onError: (e, m) => errors.push([e, m]) }, { ok: false, status: 422, body: { error: "domain not verified" } });

  // Must resolve, not reject — a thrown error is an account-existence oracle.
  await mk.sendMagicLink({ email: "u@x.com", token: "t", url: "https://acme.com/m" });

  assert.equal(errors.length, 1);
  assert.ok(errors[0][0] instanceof MailKiteSendError);
  assert.equal(errors[0][0].status, 422);
  assert.equal(errors[0][0].message, "domain not verified");
  assert.equal(errors[0][1].type, "magicLink");
});

test("backgrounded sends return undefined, not a promise", () => {
  const fetchImpl = stubFetch();
  const mk = mailkite({ apiKey: "k", from: "a@acme.com", fetch: fetchImpl });
  const returned = mk.sendMagicLink({ email: "u@x.com", token: "t", url: "https://acme.com/m" });
  assert.equal(returned, undefined);
});

test("waitUntil receives the in-flight send", async () => {
  const kept = [];
  const fetchImpl = stubFetch();
  const mk = mailkite({
    apiKey: "k",
    from: "a@acme.com",
    fetch: fetchImpl,
    waitUntil: (p) => kept.push(p),
  });
  mk.sendMagicLink({ email: "u@x.com", token: "t", url: "https://acme.com/m" });

  assert.equal(kept.length, 1);
  await kept[0];
  assert.equal(fetchImpl.calls.length, 1);
});

test("HTML is escaped in every interpolated field", async () => {
  const { mk, fetchImpl } = adapter();
  await mk.sendVerificationEmail({
    user: { email: "u@x.com", name: '<script>alert("xss")</script>' },
    url: "https://acme.com/v",
    token: "t",
  });

  const { html } = fetchImpl.calls[0].message;
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("organization name and inviter are escaped", async () => {
  const { mk, fetchImpl } = adapter();
  await mk.sendInvitationEmail({
    id: "inv_1",
    email: "n@x.com",
    organization: { name: "<img src=x onerror=1>" },
    inviter: { user: { name: "</td><script>" } },
  });

  const { html } = fetchImpl.calls[0].message;
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
});

test("non-http(s) CTA URLs are neutralised", () => {
  const rendered = templates.magicLink({
    appName: "Acme",
    brandColor: "#000",
    url: 'javascript:alert(1)',
  });
  assert.doesNotMatch(rendered.html, /javascript:/i);
  assert.match(rendered.html, /href="#"/);
});

// --- template overrides -----------------------------------------------------

test("a templateId override sends templateId + templateData instead of html", async () => {
  const { mk, fetchImpl } = adapter({ templates: { magicLink: "tpl_custom" } });
  await mk.sendMagicLink({ email: "u@x.com", token: "t", url: "https://acme.com/m?t=1" });

  const { message } = fetchImpl.calls[0];
  assert.equal(message.templateId, "tpl_custom");
  assert.equal(message.templateData.login_url, "https://acme.com/m?t=1");
  assert.equal(message.templateData.app_name, "Acme");
  assert.equal(message.html, undefined);
  assert.equal(message.subject, undefined);
});

test("overrides are per-type — untouched types still use built-ins", async () => {
  const { mk, fetchImpl } = adapter({ templates: { magicLink: "tpl_custom" } });
  await mk.sendResetPassword({ user: { email: "u@x.com" }, url: "https://acme.com/r", token: "t" });

  const { message } = fetchImpl.calls[0];
  assert.equal(message.templateId, undefined);
  assert.ok(message.html.length > 0);
});

// --- misc -------------------------------------------------------------------

test("replyTo is applied when configured", async () => {
  const { mk, fetchImpl } = adapter({ replyTo: "support@acme.com" });
  await mk.sendMagicLink({ email: "u@x.com", token: "t", url: "https://acme.com/m" });
  assert.equal(fetchImpl.calls[0].message.replyTo, "support@acme.com");
});

test("send() escape hatch resolves with the API result and defaults from", async () => {
  const { mk, fetchImpl } = adapter();
  const result = await mk.send({ to: "u@x.com", subject: "Hi", text: "there" });

  assert.deepEqual(result, { id: "msg_1", status: "sent" });
  assert.equal(fetchImpl.calls[0].message.from, "auth@acme.com");
});

test("baseUrl override is honoured and trailing slashes trimmed", async () => {
  const { mk, fetchImpl } = adapter({ baseUrl: "https://api.staging.mailkite.dev/" });
  await mk.sendMagicLink({ email: "u@x.com", token: "t", url: "https://acme.com/m" });
  assert.equal(fetchImpl.calls[0].url, "https://api.staging.mailkite.dev/v1/send");
});
