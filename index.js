// @mailkite/better-auth — a Better Auth plugin that sends the framework's
// transactional email through MailKite.
//
//   import { betterAuth } from "better-auth";
//   import { magicLink, emailOTP, organization } from "better-auth/plugins";
//   import { mailkite } from "@mailkite/better-auth";
//
//   const mk = mailkite({ apiKey: process.env.MAILKITE_API_KEY, from: "auth@acme.com", appName: "Acme" });
//
// `apiKey` is required. There is deliberately no implicit env fallback — see mailkiteAdapter.
//
//   export const auth = betterAuth({
//     emailAndPassword: { enabled: true },
//     plugins: [
//       mk,                                              // verification + reset, wired automatically
//       magicLink({ sendMagicLink: mk.sendMagicLink }),
//       emailOTP({ sendVerificationOTP: mk.sendVerificationOTP }),
//       organization({ sendInvitationEmail: mk.sendInvitationEmail }),
//     ],
//   });
//
// WHY THIS IS A PLUGIN AND NOT JUST FIVE CALLBACKS
// Better Auth reads `emailVerification.sendVerificationEmail` and
// `emailAndPassword.sendResetPassword` off the resolved root options at call time, and
// `runPluginInit` merges anything a plugin's `init` returns into those options with
// `defu` — plugin values fill gaps, the app's own values always win. So `init` can wire
// both surfaces with no config, and an app that sets its own callback silently keeps it.
//
// The other three (`sendMagicLink`, `sendVerificationOTP`, `sendInvitationEmail`) are
// read from the *closure* of the `magicLink`/`emailOTP`/`organization` plugins, not from
// root options, so no plugin can inject them. They stay explicit — hence this object is
// both the plugin and the source of those callbacks.
//
// WHY SENDS ARE BACKGROUNDED BY DEFAULT
// Better Auth's docs warn: do not await the email send, or the response time leaks
// whether an account exists. So every callback here dispatches and returns immediately.
// Failures surface through `onError` (default: console.error) — never to the caller,
// because a thrown error is the same side channel wearing a different hat.
// On serverless, pass `waitUntil` so the runtime keeps the request alive for the send.
// Current Better Auth also wraps these calls in its own `runInBackgroundOrAwait`;
// returning immediately composes with that rather than fighting it.

import * as builtin from "./templates.js";

/**
 * @typedef {Object} MailKiteOptions
 * @property {string} [apiKey] MailKite API key. Required unless `getToken` is given.
 * @property {Function} [getToken] Return a fresh Bearer token per send.
 * @property {string} from Sender address on a verified domain.
 * @property {string} [appName] Product name shown in the emails.
 * @property {string} [appUrl] Base URL for the default invitation link.
 * @property {string} [logoUrl] Logo shown in the emails.
 * @property {string} [brandColor] CTA button colour.
 * @property {string} [replyTo] Reply-To applied to every message.
 * @property {Function} [invitationUrl] Build the invitation accept URL yourself.
 * @property {Record<string, string>} [templates] Per-type MailKite templateId overrides.
 * @property {Function} [waitUntil] Serverless keep-alive.
 * @property {Function} [onError] Called when a send fails.
 * @property {boolean} [awaitSend] Await instead of backgrounding.
 * @property {string} [baseUrl] Override the API base URL.
 * @property {Function} [fetch] Inject a fetch implementation.
 */

/**
 * @typedef {Object} MailKiteAdapter
 * @property {string} appName Resolved product name.
 * @property {Function} sendMagicLink Better Auth `magicLink({ sendMagicLink })`.
 * @property {Function} sendVerificationEmail `emailVerification.sendVerificationEmail`.
 * @property {Function} sendResetPassword `emailAndPassword.sendResetPassword`.
 * @property {Function} sendVerificationOTP `emailOTP({ sendVerificationOTP })`.
 * @property {Function} sendInvitationEmail `organization({ sendInvitationEmail })`.
 * @property {Function} send Escape hatch for an arbitrary message.
 */

const DEFAULT_BASE_URL = "https://api.mailkite.dev";
const BRAND_COLOR = "#2f6fe0";
// Reported as the plugin's `version`. Kept in step with package.json by `npm test`.
const VERSION = "0.3.0";

/** Thrown when the MailKite API rejects a send. Reaches `onError`, never the auth caller. */
export class MailKiteSendError extends Error {
  /**
   * @param {number} status HTTP status from the API.
   * @param {string} message
   * @param {unknown} body Parsed error body, when there was one.
   */
  constructor(status, message, body) {
    super(message);
    this.name = "MailKiteSendError";
    this.status = status;
    this.body = body;
  }
}

/**
 * POST one message to MailKite's send endpoint.
 *
 * @param {{baseUrl: string, token: () => Promise<string>, fetchImpl: typeof fetch}} ctx
 * @param {Record<string, unknown>} message
 * @returns {Promise<{id: string, status: string}>}
 */
async function postSend(ctx, message) {
  const res = await ctx.fetchImpl(`${ctx.baseUrl}/v1/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await ctx.token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new MailKiteSendError(res.status, (data && data.error) || res.statusText || `HTTP ${res.status}`, data);
  }
  return data;
}

/**
 * Build the invitation accept URL from Better Auth's invitation id.
 *
 * Better Auth hands the callback an invitation `id` and expects the app to own the
 * accept route, so we need either an explicit builder or an `appUrl` to hang the
 * default path off.
 *
 * @param {{invitationUrl?: (id: string, data: object) => string, appUrl?: string}} opts
 * @param {string} id
 * @param {object} data Full callback payload, for custom builders.
 * @returns {string}
 */
function inviteUrl(opts, id, data) {
  if (typeof opts.invitationUrl === "function") return opts.invitationUrl(id, data);
  if (opts.appUrl) return `${String(opts.appUrl).replace(/\/+$/, "")}/accept-invitation/${id}`;
  throw new Error(
    "@mailkite/better-auth: organization invitations need either `appUrl` or `invitationUrl` in the adapter options."
  );
}

/**
 * Create a MailKite email adapter for Better Auth.
 *
 * Returns one callback per Better Auth email surface. Each matches Better Auth's
 * expected signature exactly, so they can be dropped straight into the config.
 *
 * Options:
 * - `apiKey` — **required** MailKite API key (`mk_live_…`). No environment fallback.
 * - `getToken` — return a fresh Bearer token per send; use instead of `apiKey` for OAuth.
 * - `from` — **required**, on a domain verified for sending.
 * - `appName` — product name in the emails. Defaults to the `from` domain.
 * - `appUrl` — base URL for the default invitation link.
 * - `logoUrl` / `brandColor` — branding. Colour defaults to `#2f6fe0`.
 * - `replyTo` — applied to every message.
 * - `invitationUrl` — build the invitation accept URL yourself; beats `appUrl`.
 * - `templates` — per-type MailKite `templateId` overrides (magicLink, verify, reset, otp, invitation).
 * - `waitUntil` — serverless keep-alive, e.g. Cloudflare's `ctx.waitUntil`.
 * - `onError` — called when a send fails. Default logs.
 * - `awaitSend` — await instead of backgrounding; reintroduces the timing side channel.
 * - `baseUrl` / `fetch` — overrides for staging and tests.
 *
 * @param {MailKiteOptions} options Adapter configuration.
 * @returns {MailKiteAdapter} One callback per Better Auth email surface.
 */
export function mailkiteAdapter(options) {
  options = options || {};
  // No implicit process.env.MAILKITE_API_KEY fallback. It read as convenience and
  // behaved as a trap: the plugin appeared configured, then sent nothing on any
  // runtime without `process.env` populated — Workers, Deno, edge — and because
  // sends are backgrounded and failures route to `onError`, the app looked fine
  // while every auth email silently vanished. Pass the key.
  const apiKey = options.apiKey;
  if (!apiKey && !options.getToken) {
    throw new Error(
      "@mailkite/better-auth: `apiKey` is required — pass it explicitly (e.g. `apiKey: process.env.MAILKITE_API_KEY`), or pass `getToken` for short-lived tokens."
    );
  }
  if (!options.from) {
    throw new Error("@mailkite/better-auth: `from` is required and must be on a domain verified for sending.");
  }

  const ctx = {
    baseUrl: String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    token: async () => (options.getToken ? await options.getToken() : apiKey),
    fetchImpl: options.fetch || globalThis.fetch,
  };

  const brand = {
    appName: options.appName || options.from.split("@")[1] || "your app",
    logoUrl: options.logoUrl,
    brandColor: options.brandColor || BRAND_COLOR,
  };

  const templateIds = options.templates || {};
  const onError =
    options.onError ||
    ((err, meta) => {
      // Deliberately not rethrown: a thrown send error is an account-existence oracle.
      console.error(`[@mailkite/better-auth] ${meta.type} send failed:`, err);
    });

  /**
   * Dispatch one message. Backgrounded unless `awaitSend` is set.
   *
   * @param {string} type Which auth email this is — used only for error reporting.
   * @param {string | string[]} to
   * @param {{subject: string, html: string, text: string}} rendered
   * @param {Record<string, unknown>} [templateData] Merge data, when a templateId override is in play.
   * @returns {Promise<void> | void}
   */
  function dispatch(type, to, rendered, templateData) {
    const templateId = templateIds[type];
    const message = {
      from: options.from,
      to,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(templateId
        ? { templateId, templateData: templateData || {} }
        : { subject: rendered.subject, html: rendered.html, text: rendered.text }),
    };

    const promise = postSend(ctx, message).catch((err) => onError(err, { type, to: String(to) }));

    if (options.awaitSend) return promise;
    if (options.waitUntil) options.waitUntil(promise);
    // else: intentionally floating — .catch() above means it can never reject unhandled.
  }

  return {
    /** Resolved product name — read by `mailkite()` for its `options` surface. */
    appName: brand.appName,

    /**
     * Better Auth `magicLink({ sendMagicLink })`.
     * @param {{email: string, token: string, url: string}} data
     */
    sendMagicLink: (data) =>
      dispatch("magicLink", data.email, builtin.magicLink({ ...brand, url: data.url }), {
        login_url: data.url,
        app_name: brand.appName,
      }),

    /**
     * Better Auth `emailVerification.sendVerificationEmail`.
     * @param {{user: {email: string, name?: string}, url: string, token: string}} data
     */
    sendVerificationEmail: (data) =>
      dispatch(
        "verify",
        data.user.email,
        builtin.verifyEmail({ ...brand, url: data.url, name: data.user.name }),
        { verify_url: data.url, name: data.user.name || "", app_name: brand.appName }
      ),

    /**
     * Better Auth `emailAndPassword.sendResetPassword`.
     * @param {{user: {email: string, name?: string}, url: string, token: string}} data
     */
    sendResetPassword: (data) =>
      dispatch(
        "reset",
        data.user.email,
        builtin.resetPassword({ ...brand, url: data.url, name: data.user.name }),
        { reset_url: data.url, name: data.user.name || "", app_name: brand.appName }
      ),

    /**
     * Better Auth `emailOTP({ sendVerificationOTP })`.
     *
     * `async` for the same reason as `sendInvitationEmail`: the `emailOTP` plugin's
     * option type requires `Promise<void>`. Resolves on dispatch, not delivery.
     *
     * @param {{email: string, otp: string, type?: "sign-in" | "email-verification" | "forget-password" | "change-email"}} data
     * @returns {Promise<void>}
     */
    sendVerificationOTP: async (data) => {
      await dispatch("otp", data.email, builtin.otp({ ...brand, otp: data.otp, type: data.type }), {
        code: data.otp,
        app_name: brand.appName,
      });
    },

    /**
     * Better Auth `organization({ sendInvitationEmail })`.
     *
     * `async` because the organization plugin's type demands `Promise<void>`, unlike the
     * other four which accept `void`. It still resolves immediately when backgrounded —
     * awaiting this awaits the dispatch, not the delivery.
     *
     * @param {{id: string, email: string, inviter?: object, organization?: {name?: string}, role?: string | string[]}} data
     * @returns {Promise<void>}
     */
    sendInvitationEmail: async (data) => {
      let url;
      try {
        url = inviteUrl(options, data.id, data);
      } catch (err) {
        // Config error, not a send failure — surface it rather than swallowing it.
        onError(err, { type: "invitation", to: data.email });
        return;
      }
      const organizationName = data.organization?.name;
      const inviterName = data.inviter?.user?.name || data.inviter?.name;
      await dispatch(
        "invitation",
        data.email,
        builtin.invitation({ ...brand, url, organizationName, inviterName, role: data.role }),
        {
          invite_url: url,
          team: organizationName || brand.appName,
          inviter: inviterName || "",
          app_name: brand.appName,
        }
      );
    },

    /**
     * Escape hatch — send an arbitrary message through the same client and credentials.
     * Always awaited; this is not on an auth path, so there is no timing channel to protect.
     *
     * @param {Record<string, unknown>} message A MailKite send payload.
     * @returns {Promise<{id: string, status: string}>}
     */
    send: (message) => postSend(ctx, { from: options.from, ...message }),
  };
}

/**
 * The MailKite plugin for Better Auth.
 *
 * Satisfies `BetterAuthPlugin`: an `id`, and an `init` that supplies the two email
 * callbacks Better Auth resolves from root options. The returned object also carries
 * the three callbacks that can only be passed by hand, so one call to `mailkite()`
 * covers every email surface the framework has.
 *
 * It deliberately declares no `schema` and no `endpoints`. This is a transport: it
 * owns no tables, adds no routes, and should not make an app run a migration to send
 * a password-reset email. (For receiving mail — which does need both — see
 * `@mailkite/better-auth-inbox`.)
 *
 * @param {{apiKey?: string, getToken?: Function, from: string, appName?: string, appUrl?: string, logoUrl?: string, brandColor?: string, replyTo?: string, invitationUrl?: Function, templates?: Record<string, string>, waitUntil?: Function, onError?: Function, awaitSend?: boolean, baseUrl?: string, fetch?: Function}} options Same shape as `mailkiteAdapter` (MailKiteOptions in index.d.ts).
 * @returns {{id: string, init: Function}} A Better Auth plugin (MailKitePlugin in index.d.ts).
 */
export function mailkite(options) {
  const adapter = mailkiteAdapter(options);

  return {
    ...adapter,

    id: "mailkite",
    version: VERSION,

    /**
     * Fill in the email callbacks Better Auth reads from root options.
     *
     * `runPluginInit` merges this with `defu(userOptions, pluginOptions)`, so an app
     * that already defined `sendVerificationEmail` or `sendResetPassword` keeps its
     * own — this only fills the gaps. Injecting `sendResetPassword` when
     * `emailAndPassword.enabled` is false is inert: every route that would call it is
     * gated on `enabled` first.
     *
     * @returns {{options: Record<string, unknown>}}
     */
    init: () => ({
      options: {
        emailVerification: { sendVerificationEmail: adapter.sendVerificationEmail },
        emailAndPassword: { sendResetPassword: adapter.sendResetPassword },
      },
    }),

    // Resolved, non-secret configuration. Never the API key — this object is reachable
    // from `auth.options.plugins`, which app code and other plugins can read.
    options: {
      from: options.from,
      appName: adapter.appName,
      appUrl: options.appUrl,
      awaitSend: Boolean(options.awaitSend),
      templateOverrides: Object.keys(options.templates || {}),
    },
  };
}

export { builtin as templates };
export default mailkite;
