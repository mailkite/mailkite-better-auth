# @mailkite/better-auth

A [Better Auth](https://better-auth.com) plugin that sends the framework's transactional
email through [MailKite](https://mailkite.dev).

Better Auth ships no email transport — it generates a token and a URL, then calls a
callback you write. This plugin is that callback, for all five surfaces: magic links,
email OTP, verification, password reset, and organization invitations.

```bash
npm install @mailkite/better-auth
```

## Setup

```ts
import { betterAuth } from "better-auth";
import { magicLink, emailOTP, organization } from "better-auth/plugins";
import { mailkite } from "@mailkite/better-auth";

const mk = mailkite({
  apiKey: process.env.MAILKITE_API_KEY,   // or omit — read from MAILKITE_API_KEY
  from: "auth@acme.com",                   // must be on a domain verified for sending
  appName: "Acme",
  appUrl: "https://acme.com",              // used to build the invitation link
});

export const auth = betterAuth({
  emailAndPassword: { enabled: true },
  plugins: [
    mk,                                                    // verification + reset, wired for you
    magicLink({ sendMagicLink: mk.sendMagicLink }),
    emailOTP({ sendVerificationOTP: mk.sendVerificationOTP }),
    organization({ sendInvitationEmail: mk.sendInvitationEmail }),
  ],
});
```

That's the whole integration. Verify a sending domain at
[mailkite.dev/docs/domains](https://mailkite.dev/docs/domains) and you're done.

No migration to run: this plugin declares no `schema` and no `endpoints`. It is a
transport, and sending a password-reset email shouldn't cost you a database table.

## What the plugin wires, and what stays explicit

`init()` returns an options patch that Better Auth merges with `defu`, which fills gaps
without overwriting. So installing the plugin supplies:

| Surface | How |
|---|---|
| `emailVerification.sendVerificationEmail` | Automatic, via `init()`. Your own value wins if you set one. |
| `emailAndPassword.sendResetPassword` | Automatic, via `init()`. Your own value wins if you set one. |

The other three are read from the *closure* of the `magicLink`, `emailOTP` and
`organization` plugins rather than from root options, so no plugin can inject them. Pass
them by hand off the same object — `mk.sendMagicLink`, `mk.sendVerificationOTP`,
`mk.sendInvitationEmail`.

Installing the plugin never turns an auth method on. `emailAndPassword: { enabled: true }`
stays your call.

### Just the callbacks

If you'd rather wire every surface yourself, `mailkiteAdapter()` returns the five
callbacks with no plugin wrapper:

```ts
import { mailkiteAdapter } from "@mailkite/better-auth";

const mk = mailkiteAdapter({ from: "auth@acme.com" });
export const auth = betterAuth({
  emailVerification: { sendVerificationEmail: mk.sendVerificationEmail },
  emailAndPassword: { enabled: true, sendResetPassword: mk.sendResetPassword },
});
```

## Why sends are backgrounded

Better Auth's docs warn against awaiting the send: if the response is slower when the
account exists, the timing itself tells an attacker who has an account.

So every callback here **dispatches and returns immediately**. Failures go to `onError`
(default: `console.error`) and never to the caller — a thrown error is the same side
channel wearing a different hat.

**On serverless, pass `waitUntil`** or the runtime may kill the request before the send
completes:

```ts
// Cloudflare Workers / Next.js on the edge
const mk = mailkite({ from: "auth@acme.com", waitUntil: (p) => ctx.waitUntil(p) });
```

If you would rather await (and accept the timing channel), set `awaitSend: true`.

## Options

| Option | Type | Notes |
|---|---|---|
| `from` | `string` | **Required.** Address on a domain verified for sending (SPF + DKIM). |
| `apiKey` | `string` | Defaults to `process.env.MAILKITE_API_KEY`. |
| `getToken` | `() => string \| Promise<string>` | Use instead of `apiKey` for short-lived OAuth access tokens. |
| `appName` | `string` | Shown in the emails. Defaults to the `from` domain. |
| `appUrl` | `string` | Builds the default invite link, `{appUrl}/accept-invitation/{id}`. |
| `logoUrl` | `string` | Logo in the emails. Falls back to the app name as text. |
| `brandColor` | `string` | CTA button colour. Default `#2f6fe0`. |
| `replyTo` | `string` | Applied to every message. |
| `invitationUrl` | `(id, data) => string` | Build the invite URL yourself. Beats `appUrl`. |
| `templates` | `Record<type, templateId>` | Send from your own MailKite templates instead of the built-ins. |
| `waitUntil` | `(p) => void` | Serverless keep-alive. |
| `onError` | `(err, { type, to }) => void` | Send failures land here. Default logs. |
| `awaitSend` | `boolean` | Await instead of backgrounding. Off by default. |

## Templates

The built-in emails render under **your** app name and colours — no MailKite branding.
They cover magic link, OTP (with per-context copy for all four of Better Auth's types:
`sign-in`, `email-verification`, `forget-password` and `change-email`), verification,
password reset, and invitations.

To use your own, create a template in MailKite and map it per type:

```ts
mailkite({
  from: "auth@acme.com",
  templates: {
    magicLink: "tpl_abc123",
    otp: "tpl_def456",
    // verify, reset, invitation — unmapped types keep the built-ins
  },
});
```

Merge tags passed to your template:

| Type | Tags |
|---|---|
| `magicLink` | `login_url`, `app_name` |
| `verify` | `verify_url`, `name`, `app_name` |
| `reset` | `reset_url`, `name`, `app_name` |
| `otp` | `code`, `app_name` |
| `invitation` | `invite_url`, `team`, `inviter`, `app_name` |

## Escape hatch

Same credentials, arbitrary message — for the welcome email Better Auth doesn't send:

```ts
await mk.send({ to: user.email, subject: "Welcome", text: "Glad you're here." });
```

## Receiving email

Auth email is one-way. If you want the app to **receive** mail too — replies, support, an
inbox per user or per organization — install
[`@mailkite/better-auth-inbox`](https://www.npmjs.com/package/@mailkite/better-auth-inbox)
alongside this. That one *does* add a schema and endpoints, because receiving needs both.

## Security notes

- Every interpolated value (app name, user name, organization, inviter) is HTML-escaped.
- CTA URLs that aren't `http(s)` render as `#`, so a poisoned callback URL can't become
  `javascript:`.
- Send failures never reject to the caller, and error copy never differs by whether the
  account exists.
- The plugin's public `options` (reachable via `auth.options.plugins`) carry the resolved
  `from`, `appName` and `appUrl` — never the API key.

## Compatibility

Requires `better-auth >= 1.0.0` as a peer dependency; CI tests against 1.6.x.

`npm test` boots a real `betterAuth()` on the memory adapter and drives the plugin through
actual sign-up and password-reset requests. `npm run typecheck` compiles the plugin against
Better Auth's own `BetterAuthPlugin` type and against the option types of `magicLink`,
`emailOTP` and `organization`, so a signature drift upstream fails the build.

### Upgrading from 0.1.x

Nothing breaks. `mailkite()` now returns a plugin object that still carries all five
callbacks, so existing config keeps working unchanged. To adopt the plugin form, move
`mk` into `plugins: []` and drop the two root callbacks it now supplies.

Two fixes worth knowing about: OTP emails for Better Auth's `change-email` type used to
fall through to sign-in copy, and `sendVerificationOTP` / `sendInvitationEmail` now return
`Promise<void>` to match the option types those plugins declare.

## License

MIT
