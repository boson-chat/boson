import { ConfirmDialog } from '@boson/shared';
import { signOut } from '../modules/signout/sign-out';
import { openLoginOn } from '../screens/LoginScreen/LoginBloc';

// Leaving guest mode is a full sign-out: the guest's servers, channels and
// history on this device are erased (the account that signs in next starts
// clean). Asked first, with "Create account" as the way forward. Used by
// Settings → Account and the "Sign in to boson.chat" network prompt.
export function LeaveGuestConfirm({ open, onCancel, onLeave }: {
  open: boolean;
  onCancel: () => void;
  // Called as the sign-out starts (close whatever asked).
  onLeave?: () => void;
}) {
  const leave = (mode: 'login' | 'signup'): void => {
    onLeave?.();
    openLoginOn(mode);
    void signOut();
  };
  return (
    <ConfirmDialog
      open={open}
      title="Leave guest mode?"
      confirmLabel="Erase and sign in"
      onConfirm={() => leave('login')}
      onCancel={onCancel}
      alternative={{ label: 'Create account', onClick: () => leave('signup') }}
    >
      <p>Your servers, channels and messages on this device will be deleted. They don't move to an account.</p>
    </ConfirmDialog>
  );
}
