// Built-in email templates for @mailkite/better-auth.
//
// These are deliberately NOT the MailKite `base_*` templates: those are branded for
// MailKite ("your MailKite account", our logo), which is wrong inside someone else's
// signup flow. These render under the caller's own app name and colours.
//
// Every template returns { subject, html, text }. To use your own instead, pass a
// MailKite `templateId` per email type — see `templates` in the adapter options.

/** Characters that must never reach raw HTML. */
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * Escape a value for interpolation into HTML.
 *
 * Every dynamic value below flows through here — app name, user name, organization
 * name, inviter — because all of them are attacker-influenceable in a signup flow.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value == null) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Escape a URL for an href. Blocks `javascript:` and other script-bearing schemes;
 * anything not http(s) is dropped to "#" rather than rendered.
 *
 * @param {unknown} url
 * @returns {string}
 */
export function safeUrl(url) {
  const raw = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return "#";
  return escapeHtml(raw);
}

/**
 * Render the shared email shell — a table-based layout that survives Outlook.
 *
 * `eyebrow` is the small uppercase kicker above the heading; `paragraphs` is body
 * copy that must already be escaped; `code` renders a large monospace block (OTP).
 *
 * @param {{appName: string, logoUrl?: string, brandColor: string, eyebrow: string, heading: string, paragraphs: string[], ctaLabel?: string, ctaUrl?: string, code?: string, footer?: string}} opts
 * @returns {string} HTML
 */
export function shell({ appName, logoUrl, brandColor, eyebrow, heading, paragraphs, ctaLabel, ctaUrl, code, footer }) {
  const brand = logoUrl
    ? `<img src="${safeUrl(logoUrl)}" width="140" alt="${escapeHtml(appName)}" style="display:block;border:0;height:auto;width:140px" />`
    : `<p style="margin:0;font-size:18px;font-weight:700;color:#16181d">${escapeHtml(appName)}</p>`;

  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3c4150">${p}</p>`)
    .join("\n                ");

  const codeBlock = code
    ? `<p style="margin:0 0 18px;padding:14px 18px;background:#f4f7fc;border:1px solid #e2e9f5;border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:26px;font-weight:700;letter-spacing:.22em;text-align:center;color:#16181d">${escapeHtml(code)}</p>`
    : "";

  const cta =
    ctaLabel && ctaUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 8px"><tr>
              <td align="center" style="border-radius:10px;background:${escapeHtml(brandColor)}">
                <a href="${safeUrl(ctaUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(ctaLabel)}</a>
              </td>
            </tr></table>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${escapeHtml(appName)}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef2f8">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f8">
      <tr>
        <td align="center" style="padding:32px 16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #dde5f0;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
            <tr>
              <td style="padding:28px 32px 8px">${brand}</td>
            </tr>
            <tr>
              <td style="padding:12px 32px 8px">
                <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${escapeHtml(brandColor)}">${escapeHtml(eyebrow)}</p>
                <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;font-weight:700;color:#16181d">${escapeHtml(heading)}</h1>
                ${body}
                ${codeBlock}
                ${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid #eef3fb">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280">${footer || `Sent by ${escapeHtml(appName)}.`}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Join plain-text lines, collapsing the blank-line noise. */
const txt = (...lines) => lines.filter((l) => l !== null && l !== undefined).join("\n");

/**
 * Magic link / passwordless sign-in.
 *
 * @param {{appName: string, url: string, logoUrl?: string, brandColor: string}} o
 * @returns {{subject: string, html: string, text: string}}
 */
export function magicLink(o) {
  const heading = "Your sign-in link is ready";
  return {
    subject: `Sign in to ${o.appName}`,
    html: shell({
      ...o,
      eyebrow: "Sign in",
      heading,
      paragraphs: [
        `Tap the button below to sign in to ${escapeHtml(o.appName)} — no password needed.`,
        "This link works once. If you didn't try to sign in, you can ignore this email.",
      ],
      ctaLabel: `Sign in to ${o.appName}`,
      ctaUrl: o.url,
    }),
    text: txt(
      heading,
      "",
      `Tap the link below to sign in to ${o.appName} — no password needed.`,
      "",
      o.url,
      "",
      "This link works once. If you didn't try to sign in, you can ignore this email."
    ),
  };
}

/**
 * Email-address verification (link, optionally with a code).
 *
 * @param {{appName: string, url: string, name?: string, code?: string, logoUrl?: string, brandColor: string}} o
 * @returns {{subject: string, html: string, text: string}}
 */
export function verifyEmail(o) {
  const heading = "Confirm your email address";
  const greeting = o.name ? `Hi ${escapeHtml(o.name)}, please` : "Please";
  return {
    subject: `Verify your email for ${o.appName}`,
    html: shell({
      ...o,
      eyebrow: "Verify your email",
      heading,
      paragraphs: [
        `${greeting} confirm this address to finish setting up your ${escapeHtml(o.appName)} account.`,
        o.code ? "Or use this code:" : null,
      ].filter(Boolean),
      code: o.code,
      ctaLabel: "Verify email",
      ctaUrl: o.url,
    }),
    text: txt(
      heading,
      "",
      `${o.name ? `Hi ${o.name}, please` : "Please"} confirm this address to finish setting up your ${o.appName} account.`,
      "",
      o.url,
      o.code ? `\nOr use this code: ${o.code}` : null
    ),
  };
}

/**
 * Password reset.
 *
 * @param {{appName: string, url: string, name?: string, logoUrl?: string, brandColor: string}} o
 * @returns {{subject: string, html: string, text: string}}
 */
export function resetPassword(o) {
  const heading = "Reset your password";
  return {
    subject: `Reset your ${o.appName} password`,
    html: shell({
      ...o,
      eyebrow: "Password reset",
      heading,
      paragraphs: [
        `${o.name ? `Hi ${escapeHtml(o.name)}, we` : "We"} got a request to reset the password on your ${escapeHtml(o.appName)} account.`,
        "If that wasn't you, ignore this email — your password won't change until you set a new one.",
      ],
      ctaLabel: "Choose a new password",
      ctaUrl: o.url,
    }),
    text: txt(
      heading,
      "",
      `${o.name ? `Hi ${o.name}, we` : "We"} got a request to reset the password on your ${o.appName} account.`,
      "",
      o.url,
      "",
      "If that wasn't you, ignore this email — your password won't change until you set a new one."
    ),
  };
}

/** Human-readable copy per OTP `type`, keyed by Better Auth's four values. */
const OTP_COPY = {
  "sign-in": { eyebrow: "Sign in", heading: "Your sign-in code", subject: (a) => `Your ${a} sign-in code` },
  "email-verification": {
    eyebrow: "Verify your email",
    heading: "Your verification code",
    subject: (a) => `Verify your email for ${a}`,
  },
  "forget-password": {
    eyebrow: "Password reset",
    heading: "Your password reset code",
    subject: (a) => `Reset your ${a} password`,
  },
  // Sent to the *new* address when a user changes their email. Confirming an address
  // is not verifying a signup, and saying "verify your email" here reads as a phish
  // to someone who just typed the address in.
  "change-email": {
    eyebrow: "Confirm your new email",
    heading: "Your email change code",
    subject: (a) => `Confirm your new email for ${a}`,
  },
};

/**
 * One-time passcode. `type` is Better Auth's:
 * sign-in | email-verification | forget-password | change-email.
 *
 * @param {{appName: string, otp: string, type?: string, logoUrl?: string, brandColor: string}} o
 * @returns {{subject: string, html: string, text: string}}
 */
export function otp(o) {
  const copy = OTP_COPY[o.type] || OTP_COPY["sign-in"];
  return {
    subject: copy.subject(o.appName),
    html: shell({
      ...o,
      eyebrow: copy.eyebrow,
      heading: copy.heading,
      paragraphs: ["Enter this code to continue. It expires shortly and can only be used once."],
      code: o.otp,
      footer: `If you didn't request this, you can ignore this email. Sent by ${escapeHtml(o.appName)}.`,
    }),
    text: txt(
      copy.heading,
      "",
      `Enter this code to continue: ${o.otp}`,
      "",
      "It expires shortly and can only be used once. If you didn't request this, ignore this email."
    ),
  };
}

/**
 * Organization / team invitation.
 *
 * @param {{appName: string, url: string, organizationName?: string, inviterName?: string, role?: string, logoUrl?: string, brandColor: string}} o
 * @returns {{subject: string, html: string, text: string}}
 */
export function invitation(o) {
  const org = o.organizationName || o.appName;
  const heading = `You've been invited to ${org}`;
  const who = o.inviterName ? `${escapeHtml(o.inviterName)} invited you` : "You've been invited";
  const asRole = o.role ? ` as ${escapeHtml(String(o.role))}` : "";
  return {
    subject: `You've been invited to ${org} on ${o.appName}`,
    html: shell({
      ...o,
      eyebrow: "Invitation",
      heading,
      paragraphs: [
        `${who} to join <strong>${escapeHtml(org)}</strong>${asRole} on ${escapeHtml(o.appName)}.`,
        "Accept the invitation to get access.",
      ],
      ctaLabel: "Accept invitation",
      ctaUrl: o.url,
    }),
    text: txt(
      heading,
      "",
      `${o.inviterName ? `${o.inviterName} invited you` : "You've been invited"} to join ${org}${o.role ? ` as ${o.role}` : ""} on ${o.appName}.`,
      "",
      o.url
    ),
  };
}
