// Type definitions for @mailkite/better-auth.

import type { BetterAuthPlugin } from "better-auth";

export declare class MailKiteSendError extends Error {
  name: "MailKiteSendError";
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown);
}

/** Which auth email failed — the key used for `templates` overrides and `onError` reporting. */
export type MailKiteEmailType = "magicLink" | "verify" | "reset" | "otp" | "invitation";

/** Better Auth's four OTP contexts. */
export type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

export interface MailKiteAdapterOptions {
  /**
   * MailKite API key (`mk_live_…`). **Required** unless you pass `getToken`.
   *
   * There is deliberately no `process.env.MAILKITE_API_KEY` fallback: it read as
   * convenience and behaved as a trap on runtimes without a populated `process.env`.
   */
  apiKey?: string;
  /** Return a fresh Bearer token per send. Use instead of `apiKey` for OAuth access tokens. */
  getToken?: () => string | Promise<string>;
  /** Sender address on a domain verified for sending (SPF + DKIM). Required. */
  from: string;
  /** Product name shown in the emails. Defaults to the `from` domain. */
  appName?: string;
  /** Base URL, used to build the default invitation link (`{appUrl}/accept-invitation/{id}`). */
  appUrl?: string;
  /** Logo shown in the emails. Falls back to the app name as text. */
  logoUrl?: string;
  /** CTA button colour. Default `#2f6fe0`. */
  brandColor?: string;
  /** Reply-To applied to every message. */
  replyTo?: string;
  /** Build the invitation accept URL yourself. Takes precedence over `appUrl`. */
  invitationUrl?: (id: string, data: SendInvitationEmailData) => string;
  /** Per-type MailKite `templateId` overrides. When set, that type sends from the template instead of the built-in HTML. */
  templates?: Partial<Record<MailKiteEmailType, string>>;
  /** Serverless keep-alive, e.g. Cloudflare's `ctx.waitUntil`, so a backgrounded send survives the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Called when a send fails. Default logs to console. Errors never reach the auth caller. */
  onError?: (err: unknown, meta: { type: MailKiteEmailType; to: string }) => void;
  /**
   * Await sends instead of backgrounding them.
   * Off by default: awaiting reintroduces the timing side channel that leaks whether an account exists.
   */
  awaitSend?: boolean;
  /** Override the API base URL. */
  baseUrl?: string;
  /** Inject a fetch implementation (tests). */
  fetch?: typeof fetch;
}

export interface SendMagicLinkData {
  email: string;
  token: string;
  url: string;
  metadata?: Record<string, unknown>;
}

export interface SendVerificationEmailData {
  user: { email: string; name?: string };
  url: string;
  token: string;
}

export interface SendResetPasswordData {
  user: { email: string; name?: string };
  url: string;
  token: string;
}

export interface SendVerificationOTPData {
  email: string;
  otp: string;
  type?: OtpType;
}

/**
 * Widened to be a supertype of what the `organization` plugin passes, so this stays
 * assignable as that plugin's option across minor versions. It hands over an
 * `Organization`, an `Invitation` and a `Member & { user: User }`; only the fields the
 * templates read are modelled here.
 */
export interface SendInvitationEmailData {
  /** The invitation id — what the accept URL is built from. */
  id: string;
  email: string;
  inviter?: { user?: { name?: string; email?: string }; name?: string };
  organization?: { name?: string; id?: string };
  role?: string | string[];
}

export interface SendResult {
  id: string;
  status: string;
}

export interface MailKiteAdapter {
  /** Resolved product name shown in the emails. */
  appName: string;
  /** Drop into `magicLink({ sendMagicLink })`. */
  sendMagicLink: (data: SendMagicLinkData) => void | Promise<void>;
  /** Drop into `emailVerification.sendVerificationEmail`. Wired automatically by the plugin. */
  sendVerificationEmail: (data: SendVerificationEmailData) => void | Promise<void>;
  /** Drop into `emailAndPassword.sendResetPassword`. Wired automatically by the plugin. */
  sendResetPassword: (data: SendResetPasswordData) => void | Promise<void>;
  /**
   * Drop into `emailOTP({ sendVerificationOTP })`. Returns `Promise<void>` because that
   * plugin's option type requires it — the promise settles on dispatch, not delivery.
   */
  sendVerificationOTP: (data: SendVerificationOTPData) => Promise<void>;
  /**
   * Drop into `organization({ sendInvitationEmail })`. Returns `Promise<void>` because
   * that plugin's option type requires it — the promise settles on dispatch, not delivery.
   */
  sendInvitationEmail: (data: SendInvitationEmailData) => Promise<void>;
  /** Escape hatch — send any MailKite payload with the same credentials. Always awaited. */
  send: (message: Record<string, unknown>) => Promise<SendResult>;
}

/**
 * The MailKite plugin. A `BetterAuthPlugin` that also carries the three callbacks
 * Better Auth only accepts by hand, so `plugins: [mk]` and
 * `magicLink({ sendMagicLink: mk.sendMagicLink })` come from the same object.
 */
export interface MailKitePlugin extends BetterAuthPlugin, MailKiteAdapter {
  id: "mailkite";
  version: string;
  /** Supplies `emailVerification.sendVerificationEmail` and `emailAndPassword.sendResetPassword`. */
  init: () => { options: Record<string, unknown> };
  /** Resolved, non-secret configuration. Never contains the API key. */
  options: {
    from: string;
    appName: string;
    appUrl?: string;
    awaitSend: boolean;
    templateOverrides: string[];
  };
}

/** Options accepted by both `mailkite()` and `mailkiteAdapter()`. */
export type MailKiteOptions = MailKiteAdapterOptions;

/**
 * Create the MailKite plugin. Pass the result to `betterAuth({ plugins: [...] })`;
 * read `.sendMagicLink` / `.sendVerificationOTP` / `.sendInvitationEmail` off it for the
 * `magicLink`, `emailOTP` and `organization` plugins.
 */
export declare function mailkite(options: MailKiteOptions): MailKitePlugin;

/**
 * The callbacks alone, with no plugin wrapper — for apps that would rather wire every
 * surface by hand. `mailkite()` is built on this.
 */
export declare function mailkiteAdapter(options: MailKiteOptions): MailKiteAdapter;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export declare const templates: {
  escapeHtml(value: unknown): string;
  safeUrl(url: unknown): string;
  magicLink(o: { appName: string; url: string; logoUrl?: string; brandColor: string }): RenderedEmail;
  verifyEmail(o: { appName: string; url: string; name?: string; code?: string; logoUrl?: string; brandColor: string }): RenderedEmail;
  resetPassword(o: { appName: string; url: string; name?: string; logoUrl?: string; brandColor: string }): RenderedEmail;
  otp(o: { appName: string; otp: string; type?: OtpType; logoUrl?: string; brandColor: string }): RenderedEmail;
  invitation(o: {
    appName: string;
    url: string;
    organizationName?: string;
    inviterName?: string;
    role?: string | string[];
    logoUrl?: string;
    brandColor: string;
  }): RenderedEmail;
};

export default mailkite;
