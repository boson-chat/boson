# Supabase email templates

Drop-in HTML for the Supabase auth-email screens. Open the [Supabase dashboard → Authentication → Email Templates](https://supabase.com/dashboard/project/_/auth/templates), paste each file's contents into the matching panel, set the **Subject** line from the table below, and save.

| File | Supabase template | Subject |
|------|-------------------|---------|
| `confirm-signup.html` | Confirm signup | `Confirm your Boson account` |
| `magic-link.html` | Magic Link | `Your Boson sign-in link` |
| `password-recovery.html` | Reset Password | `Reset your Boson password` |
| `email-change.html` | Change Email Address | `Confirm your new email for Boson` |
| `invite.html` | Invite User | `You're invited to Boson` |

All five templates are self-contained HTML — every style is inlined, no external assets, no remote fonts. They're tested visually in Gmail, Apple Mail, and Outlook (web + macOS).

## Variables in use

Supabase resolves these at send time:

- `{{ .ConfirmationURL }}` — the deep link the user clicks. Already includes the token + redirect.
- `{{ .Token }}` — the OTP code (six digits or longer). We only surface it where the magic-link form needs a paste-in option.
- `{{ .Email }}` — recipient's current email. Used for "we're sending this to `<email>`" context.
- `{{ .NewEmail }}` — used in `email-change.html`.
- `{{ .SiteURL }}` — the canonical app URL, configured in `Authentication → URL Configuration`.

If any of these is referenced in the template but not configured in the project, Supabase renders an empty string — the page still works, but the context line will be blank. Worth double-checking the URL Configuration after pasting these in.

## Reply-To

We set `support@boson.chat` as the implied reply-to in every template footer. The Supabase dashboard's separate **Reply-to email** field should match — set it under `Authentication → Email → SMTP Settings` if you're on custom SMTP, otherwise it defaults to the From address.

## Visual style

Dark theme (`#070709` background, `#D97706` orange accent, JetBrains Mono / system-monospace stack), centred 560px column, single primary CTA button per template. The brand wordmark uses `● BOSON` so we don't depend on remote SVG/PNG logos that most clients block by default.

Dark mode handling: every cell carries an explicit `bgcolor` attribute. Gmail's auto-invert generally leaves these alone; Outlook's web dark mode respects the explicit colors. If a client inverts anyway, the orange accent is still legible against the resulting background — that was the colour test we ran the templates against.
