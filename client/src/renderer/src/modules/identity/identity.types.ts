export type IdentityStatus = 'locked' | 'unlocked';

export interface IdentityState {
  status: IdentityStatus;
  error?: string;
}
