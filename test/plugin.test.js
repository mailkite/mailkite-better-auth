/**
 * Plugin-contract tests. These boot a real `betterAuth()` on the memory adapter rather
 * than asserting against a hand-rolled fake, because the claim under test is "Better
 * Auth accepts and drives this as a plugin" — only Better Auth can settle that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import { mailkite, mailkiteAdapter } from "../index.js";

/** Record every send the plugin attempts. */
function stubFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), message: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ id: "msg_1", status: "sent" }),
    };
  };
  impl.calls = calls;
  return impl;
}

/** A real auth instance with the plugin installed and sends captured. */
function harness(pluginOverrides = {}, authOverrides = {}) {
  const fetchImpl = stubFetch();
  const mk = mailkite({
    apiKey: "mk_live_test",
    from: "auth@acme.com",
    appName: "Acme",
    appUrl: "https://acme.com",
    awaitSend: true, // deterministic assertions; the default is backgrounded
    fetch: fetchImpl,
    ...pluginOverrides,
  });
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-value-at-least-32-chars-long",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    plugins: [mk],
    ...authOverrides,
  });
  return { auth, mk, fetchImpl };
}

// --- the plugin contract ----------------------------------------------------

test("exposes the required plugin fields", () => {
  const { mk } = harness();
  assert.equal(mk.id, "mailkite");
  assert.equal(typeof mk.version, "string");
  assert.equal(typeof mk.init, "function");
});

test("version tracks package.json", () => {
  const { mk } = harness();
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(mk.version, pkg.version);
});

test("init returns only an options patch, and no context patch", () => {
  const { mk } = harness();
  const result = mk.init();
  assert.deepEqual(Object.keys(result), ["options"]);
});

test("options carries no credential", () => {
  const { mk } = harness();
  const serialised = JSON.stringify(mk.options);
  assert.ok(!serialised.includes("mk_live_test"), "the API key must not be reachable via auth.options");
  assert.equal(mk.options.from, "auth@acme.com");
  assert.equal(mk.options.appName, "Acme");
});

// --- what init actually wires ----------------------------------------------

test("Better Auth resolves the plugin's callbacks into its own options", async () => {
  const { auth, mk } = harness();
  const ctx = await auth.$context;
  assert.equal(ctx.options.emailVerification.sendVerificationEmail, mk.sendVerificationEmail);
  assert.equal(ctx.options.emailAndPassword.sendResetPassword, mk.sendResetPassword);
});

test("an app's own callback wins over the plugin's", async () => {
  const mine = () => {};
  const { auth } = harness({}, { emailVerification: { sendVerificationEmail: mine } });
  const ctx = await auth.$context;
  assert.equal(ctx.options.emailVerification.sendVerificationEmail, mine);
});

test("the plugin still fills reset when the app only set verification", async () => {
  const { auth, mk } = harness({}, { emailVerification: { sendVerificationEmail: () => {} } });
  const ctx = await auth.$context;
  assert.equal(ctx.options.emailAndPassword.sendResetPassword, mk.sendResetPassword);
});

test("installing the plugin does not switch email/password on by itself", async () => {
  const { auth } = harness({}, { emailAndPassword: undefined });
  const ctx = await auth.$context;
  assert.ok(!ctx.options.emailAndPassword?.enabled, "enabling auth methods is the app's call, not ours");
});

// --- driven by Better Auth, not by us ---------------------------------------

test("a password-reset request sends through MailKite with zero manual wiring", async () => {
  const { auth, fetchImpl } = harness();
  await auth.api.signUpEmail({
    body: { email: "ada@acme.com", password: "password1234", name: "Ada" },
  });
  fetchImpl.calls.length = 0;

  await auth.api.requestPasswordReset({
    body: { email: "ada@acme.com", redirectTo: "https://acme.com/reset" },
  });

  assert.equal(fetchImpl.calls.length, 1, "Better Auth should have called the plugin's sendResetPassword");
  const { url, message } = fetchImpl.calls[0];
  assert.equal(url, "https://api.mailkite.dev/v1/send");
  assert.equal(message.to, "ada@acme.com");
  assert.equal(message.from, "auth@acme.com");
  assert.match(message.html, /reset/i);
});

test("sign-up sends verification when the app asks for it", async () => {
  const { auth, fetchImpl } = harness({}, { emailVerification: { sendOnSignUp: true } });
  await auth.api.signUpEmail({
    body: { email: "grace@acme.com", password: "password1234", name: "Grace" },
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].message.to, "grace@acme.com");
});

test("a send failure does not fail the auth request", async () => {
  const errors = [];
  const failing = async () => ({ ok: false, status: 500, statusText: "Server Error", text: async () => "{}" });
  const { auth } = harness({ fetch: failing, onError: (err, meta) => errors.push(meta.type) });
  await auth.api.signUpEmail({
    body: { email: "alan@acme.com", password: "password1234", name: "Alan" },
  });
  // The caller must not be able to tell a failed send from a successful one.
  await assert.doesNotReject(
    auth.api.requestPasswordReset({ body: { email: "alan@acme.com", redirectTo: "https://acme.com/reset" } })
  );
  assert.deepEqual(errors, ["reset"]);
});

// --- backwards compatibility with 0.1.x -------------------------------------

test("the 0.1.x usage still works — mailkite() result carries every callback", () => {
  const { mk } = harness();
  for (const fn of ["sendMagicLink", "sendVerificationEmail", "sendResetPassword", "sendVerificationOTP", "sendInvitationEmail", "send"]) {
    assert.equal(typeof mk[fn], "function", `${fn} must remain readable off mailkite()`);
  }
});

test("mailkiteAdapter still returns the plain callbacks, with no plugin fields", () => {
  const bare = mailkiteAdapter({ apiKey: "mk_live_test", from: "auth@acme.com" });
  assert.equal(typeof bare.sendMagicLink, "function");
  assert.equal(bare.id, undefined, "the bare adapter is not a plugin and must not claim to be");
});
