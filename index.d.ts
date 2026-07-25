// Type definitions for @mailkite/better-auth.

export declare class MailKiteSendError extends Error {
  name: "MailKiteSendError";
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown);
}

/** Which auth email failed — the key used for `templates` overrides and `onError` reporting. */
export type MailKiteEmailType = "magicLink" | "verify" | "reset" | "otp" | "invitation";

/** Better Auth's three OTP contexts. */
export type OtpType = "sign-in" | "email-verification" | "forget-password";

export interface MailKiteAdapterOptions {
  /** MailKite API key (`mk_live_…`). Defaults to `process.env.MAILKITE_API_KEY`. */
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

export interface SendInvitationEmailData {
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
  /** Drop into `magicLink({ sendMagicLink })`. */
  sendMagicLink: (data: SendMagicLinkData) => void | Promise<void>;
  /** Drop into `emailVerification.sendVerificationEmail`. */
  sendVerificationEmail: (data: SendVerificationEmailData) => void | Promise<void>;
  /** Drop into `emailAndPassword.sendResetPassword`. */
  sendResetPassword: (data: SendResetPasswordData) => void | Promise<void>;
  /** Drop into `emailOTP({ sendVerificationOTP })`. */
  sendVerificationOTP: (data: SendVerificationOTPData) => void | Promise<void>;
  /** Drop into `organization({ sendInvitationEmail })`. */
  sendInvitationEmail: (data: SendInvitationEmailData) => void | Promise<void>;
  /** Escape hatch — send any MailKite payload with the same credentials. Always awaited. */
  send: (message: Record<string, unknown>) => Promise<SendResult>;
}

/** Create a MailKite email adapter for Better Auth. */
export declare function mailkite(options: MailKiteAdapterOptions): MailKiteAdapter;

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
