import { describe, it, expect } from 'vitest';
import { HttpError } from '../../shared/http/http.client';
import { describeHandleError } from './handle-error';

describe('describeHandleError', () => {
  it("shows the backend's reason for invalid_handle as a sentence", () => {
    const err = new HttpError(400, "handle can't contain spaces", { error: "handle can't contain spaces", code: 'invalid_handle' });
    expect(describeHandleError(err)).toBe("Handle can't contain spaces.");
    const start = new HttpError(400, 'handle must start with a letter or one of []\\`_^{|}', { code: 'invalid_handle' });
    expect(describeHandleError(start)).toBe('Handle must start with a letter or one of []\\`_^{|}.');
  });
  it('keeps the minimum-length wording, with or without the code', () => {
    const body = { error: 'handle must be at least 3 characters', code: 'invalid_handle' };
    expect(describeHandleError(new HttpError(400, body.error, body))).toBe('Handle must be at least 3 characters.');
    expect(describeHandleError(new HttpError(400, 'handle must be at least 3 characters', { error: 'handle must be at least 3 characters' })))
      .toBe('Handle must be at least 3 characters.');
    expect(describeHandleError(new HttpError(400, '', null))).toBe('Handle must be at least 3 characters.');
  });
  it('409 is taken; anything else is its message, or a generic retry', () => {
    expect(describeHandleError(new HttpError(409, 'handle taken'))).toBe('That handle is taken — pick another.');
    expect(describeHandleError(new Error('network down'))).toBe('Network down.');
    expect(describeHandleError('?')).toBe('Setup failed. Try again.');
  });
});
