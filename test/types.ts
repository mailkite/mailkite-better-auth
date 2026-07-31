/**
 * Compile-time conformance check. Nothing here runs — `npm run typecheck` failing IS
 * the test. It exists because "does this actually satisfy the plugin type contract?"
 * is a question about types, and no runtime assertion can answer it.
 */
import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { emailOTP, magicLink, organization } from "better-auth/plugins";

import { mailkite, mailkiteAdapter } from "../index.js";
import type { MailKitePlugin } from "../index.js";

const mk: MailKitePlugin = mailkite({
	apiKey: "mk_live_test",
	from: "auth@acme.com",
	appName: "Acme",
	appUrl: "https://acme.com",
});

// 1. The plugin satisfies Better Auth's own type, structurally.
const asPlugin: BetterAuthPlugin = mk;
void asPlugin;

// 2. `id` is a literal, not `string` — Better Auth's `InferPluginIDs` depends on it.
const id: "mailkite" = mk.id;
void id;

// 3. It is accepted in `betterAuth({ plugins })` alongside the first-party plugins that
//    consume its callbacks — the arrangement the README documents.
export const auth = betterAuth({
	baseURL: "http://localhost:3000",
	secret: "test-secret-value-at-least-32-chars-long",
	emailAndPassword: { enabled: true },
	plugins: [
		mk,
		magicLink({ sendMagicLink: mk.sendMagicLink }),
		emailOTP({ sendVerificationOTP: mk.sendVerificationOTP }),
		organization({ sendInvitationEmail: mk.sendInvitationEmail }),
	],
});

// 4. `init` returns the shape `runPluginInit` merges — `{ options }`, nothing else.
const initResult: { options: Record<string, unknown> } = mk.init();
void initResult;

// 5. The callbacks match the signatures Better Auth calls them with.
mk.sendVerificationEmail({ user: { email: "a@b.com" }, url: "https://acme.com/v", token: "t" });
mk.sendResetPassword({ user: { email: "a@b.com" }, url: "https://acme.com/r", token: "t" });
mk.sendMagicLink({ email: "a@b.com", token: "t", url: "https://acme.com/m" });
mk.sendVerificationOTP({ email: "a@b.com", otp: "123456", type: "sign-in" });
mk.sendInvitationEmail({ id: "inv_1", email: "a@b.com" });

// 6. The adapter escape hatch still type-checks on its own, without the plugin wrapper.
const bare = mailkiteAdapter({ apiKey: "mk_live_test", from: "auth@acme.com" });
void bare.sendMagicLink;
