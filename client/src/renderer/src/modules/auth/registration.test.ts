import { describe, expect, it } from 'vitest';
import { closedSignupLine, signupMode } from './registration';
import { allSignupErrors, serverFieldError, signupFieldError } from './signup-rules';
import { AuthError } from './auth.service';

describe('signupMode', () => {
  it('follows registration and accounts.signup', () => {
    expect(signupMode(null)).toBe('open');
    expect(signupMode({ registration: 'open' })).toBe('open');
    expect(signupMode({ registration: 'invite' })).toBe('invite');
    expect(signupMode({ registration: 'closed' })).toBe('closed');
    // An older auth service said signup: true while closed.
    expect(signupMode({ registration: 'closed', accounts: { signup: true } })).toBe('closed');
    // A backend that can't sign people up.
    expect(signupMode({ registration: 'open', accounts: { signup: false } })).toBe('closed');
    expect(signupMode({ registration: 'invite', accounts: { signup: true } })).toBe('invite');
  });
});

describe('closedSignupLine', () => {
  it('says what is left', () => {
    expect(closedSignupLine({ name: 'IRCForever', federated: 'your boson.chat account', guests: true }))
      .toBe("IRCForever isn't taking new accounts. Use your boson.chat account, or continue as a guest.");
    expect(closedSignupLine({ name: 'IRCForever', federated: 'your boson.chat account', guests: false }))
      .toBe("IRCForever isn't taking new accounts. Use your boson.chat account, or sign in if you have an account here.");
    expect(closedSignupLine({ name: 'IRCForever', federated: null, guests: true }))
      .toBe("IRCForever isn't taking new accounts. Sign in if you have an account, or continue as a guest.");
    expect(closedSignupLine({ name: 'IRCForever', federated: null, guests: false }))
      .toBe("IRCForever isn't taking new accounts. Sign in if you have an account.");
  });
});

describe('invite code rule', () => {
  const base = { username: 'carol', email: 'carol@example.com', password: 'correct horse battery', confirmPassword: 'correct horse battery' };
  it('is required only for invite-only sign-up', () => {
    expect(signupFieldError('inviteCode', base)).toBeNull();
    expect(signupFieldError('inviteCode', { ...base, inviteRequired: true, inviteCode: '  ' })).toBe('Enter the invite code you were given.');
    expect(signupFieldError('inviteCode', { ...base, inviteRequired: true, inviteCode: 'inv' })).toBeNull();
    expect(allSignupErrors({ ...base, inviteRequired: true })).toEqual({ inviteCode: 'Enter the invite code you were given.' });
  });

  it("puts the auth service's invite_required on the field", () => {
    expect(serverFieldError(new AuthError('invite_required', 'a valid invite code is required', 403))?.field).toBe('inviteCode');
  });
});
