import { HttpError } from '../../shared/http/http.client';
import { sentence } from '../auth/wording';

// The backend's refusals of a handle (POST / PATCH /me), in the form's words:
// shared by sign-up's handle step and Settings → Identity.
//   409                                   → taken
//   400 {"error": why, "code": "invalid_handle"} → the backend's reason
//      ("handle can't contain spaces" → "Handle can't contain spaces.")
//   400 from an older backend (no code)   → its message, which was only ever
//      the 3-character minimum
export function describeHandleError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 409) return 'That handle is taken — pick another.';
    if (err.status === 400) {
      const code = err.body && typeof err.body === 'object' ? (err.body as { code?: unknown }).code : undefined;
      if (code === 'invalid_handle' && err.message.trim()) return sentence(err.message);
      return /3 characters/.test(err.message) || !err.message.trim() ? 'Handle must be at least 3 characters.' : sentence(err.message);
    }
  }
  return err instanceof Error && err.message.trim() ? sentence(err.message) : 'Setup failed. Try again.';
}
