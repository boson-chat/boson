// Sign-up field rules, checked as the user leaves each field so problems
// show next to it before anything is sent. The auth service has the final
// say; serverFieldError() maps its answers onto the same fields, in the same
// voice.
import { AuthError } from './auth.service';
import { validateUsername } from './username';
import { friendlyPasswordError, sentence } from './wording';

// The auth service's password.MinLength / MaxLength.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export type SignupField = 'inviteCode' | 'username' | 'email' | 'password' | 'confirmPassword';
export type SignupFieldErrors = Partial<Record<SignupField, string>>;

export interface SignupValues {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  // Invite-only registration: the code the network's admins handed out.
  inviteCode?: string;
  inviteRequired?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// null when the field is fine.
export function signupFieldError(field: SignupField, v: SignupValues): string | null {
  switch (field) {
    case 'inviteCode':
      return v.inviteRequired && !v.inviteCode?.trim() ? 'Enter the invite code you were given.' : null;
    case 'username':
      return validateUsername(v.username.trim());
    case 'email': {
      const e = v.email.trim();
      if (!e) return 'Enter your email address.';
      return EMAIL_RE.test(e) ? null : 'Enter an email address like name@example.com.';
    }
    case 'password': {
      const p = v.password;
      if (p.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
      if (p.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
      const lower = p.toLowerCase();
      const name = v.username.trim().toLowerCase();
      const email = v.email.trim().toLowerCase();
      if ((name && lower === name) || (email && lower === email)) return "Pick a password that isn't your username or email.";
      return null;
    }
    case 'confirmPassword':
      if (!v.confirmPassword) return 'Type the password again.';
      return v.confirmPassword === v.password ? null : "Passwords don't match.";
  }
}

export function allSignupErrors(v: SignupValues): SignupFieldErrors {
  const out: SignupFieldErrors = {};
  for (const f of ['inviteCode', 'username', 'email', 'password', 'confirmPassword'] as const) {
    const e = signupFieldError(f, v);
    if (e) out[f] = e;
  }
  return out;
}

// A sign-up refusal that belongs to one field, or null (shown above the
// buttons instead).
export function serverFieldError(err: unknown): { field: SignupField; message: string } | null {
  if (!(err instanceof AuthError)) return null;
  switch (err.code) {
    case 'username_taken': return { field: 'username', message: 'That username is taken. Try another.' };
    case 'invalid_username': return { field: 'username', message: sentence(err.message) };
    case 'email_taken': return { field: 'email', message: 'There is already an account with this email. Sign in instead, or reset your password.' };
    case 'invalid_email': return { field: 'email', message: 'Enter an email address like name@example.com.' };
    case 'weak_password': return { field: 'password', message: friendlyPasswordError(err.message) };
    // A missing, used-up, expired or unknown code (the auth service doesn't
    // say which).
    case 'invite_required': return { field: 'inviteCode', message: "That invite code didn't work. Check it, or ask for a new one." };
  }
  return null;
}
