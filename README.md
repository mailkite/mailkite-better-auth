# @mailkite/better-auth

Send [Better Auth](https://better-auth.com)'s transactional email through [MailKite](https://mailkite.dev).

Better Auth ships no email transport — it generates a token and a URL, then calls a
callback you write. This package is that callback, for all five surfaces: magic links,
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
  emailVerification: { sendVerificationEmail: mk.sendVerificationEmail },
  emailAndPassword: { enabled: true, sendResetPassword: mk.sendResetPassword },
  plugins: [
    magicLink({ sendMagicLink: mk.sendMagicLink }),
    emailOTP({ sendVerificationOTP: mk.sendVerificationOTP }),
    organization({ sendInvitationEmail: mk.sendInvitationEmail }),
  ],
});
```

That's the whole integration. Verify a sending domain at
[mailkite.dev/docs/domains](https://mailkite.dev/docs/domains) and you're done.

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
They cover magic link, OTP (with per-context copy for `sign-in`, `email-verification`
and `forget-password`), verification, password reset, and invitations.

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

Auth email is one-way. If you want the app to **receive** mail too — replies, support,
an inbox per organization — that's [MailKite inbound](https://mailkite.dev/docs/receiving):
mail arrives at your webhook as clean JSON. No auth library offers this.

## Security notes

- Every interpolated value (app name, user name, organization, inviter) is HTML-escaped.
- CTA URLs that aren't `http(s)` render as `#`, so a poisoned callback URL can't become
  `javascript:`.
- Send failures never reject to the caller, and error copy never differs by whether the
  account exists.

## License

MIT
