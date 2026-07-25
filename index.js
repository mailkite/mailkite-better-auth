// @mailkite/better-auth — send Better Auth's transactional email through MailKite.
//
//   import { betterAuth } from "better-auth";
//   import { magicLink, emailOTP, organization } from "better-auth/plugins";
//   import { mailkite } from "@mailkite/better-auth";
//
//   const mk = mailkite({ apiKey: process.env.MAILKITE_API_KEY, from: "auth@acme.com", appName: "Acme" });
//
//   export const auth = betterAuth({
//     emailVerification: { sendVerificationEmail: mk.sendVerificationEmail },
//     emailAndPassword:  { enabled: true, sendResetPassword: mk.sendResetPassword },
//     plugins: [
//       magicLink({ sendMagicLink: mk.sendMagicLink }),
//       emailOTP({ sendVerificationOTP: mk.sendVerificationOTP }),
//       organization({ sendInvitationEmail: mk.sendInvitationEmail }),
//     ],
//   });
//
// WHY SENDS ARE BACKGROUNDED BY DEFAULT
// Better Auth's docs warn: do not await the email send, or the response time leaks
// whether an account exists. So every callback here dispatches and returns immediately.
// Failures surface through `onError` (default: console.error) — never to the caller,
// because a thrown error is the same side channel wearing a different hat.
// On serverless, pass `waitUntil` so the runtime keeps the request alive for the send.

import * as builtin from "./templates.js";

const DEFAULT_BASE_URL = "https://api.mailkite.dev";
const BRAND_COLOR = "#2f6fe0";

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
 * - `apiKey` — MailKite API key (`mk_live_…`). Defaults to `MAILKITE_API_KEY`.
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
 * @param {{apiKey?: string, getToken?: Function, from: string, appName?: string, appUrl?: string, logoUrl?: string, brandColor?: string, replyTo?: string, invitationUrl?: Function, templates?: Record<string, string>, waitUntil?: Function, onError?: Function, awaitSend?: boolean, baseUrl?: string, fetch?: Function}} options
 * @returns {{sendMagicLink: Function, sendVerificationEmail: Function, sendResetPassword: Function, sendVerificationOTP: Function, sendInvitationEmail: Function, send: Function}}
 */
export function mailkiteAdapter(options) {
  options = options || {};
  const apiKey = options.apiKey ?? (typeof process !== "undefined" ? process.env?.MAILKITE_API_KEY : undefined);
  if (!apiKey && !options.getToken) {
    throw new Error("@mailkite/better-auth: pass `apiKey` (or set MAILKITE_API_KEY), or pass `getToken`.");
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
     * @param {{email: string, otp: string, type?: "sign-in" | "email-verification" | "forget-password"}} data
     */
    sendVerificationOTP: (data) =>
      dispatch("otp", data.email, builtin.otp({ ...brand, otp: data.otp, type: data.type }), {
        code: data.otp,
        app_name: brand.appName,
      }),

    /**
     * Better Auth `organization({ sendInvitationEmail })`.
     * @param {{id: string, email: string, inviter?: object, organization?: {name?: string}, role?: string}} data
     */
    sendInvitationEmail: (data) => {
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
      return dispatch(
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

export { builtin as templates };
// Public name. Declared as `mailkiteAdapter` so the symbol is unique across the
// monorepo (an Astro integration already exports a `mailkite` function).
export { mailkiteAdapter as mailkite };
export default mailkiteAdapter;
