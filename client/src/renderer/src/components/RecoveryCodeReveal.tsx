import { useState } from 'preact/hooks';
import { Button } from '@boson/shared';

// RecoveryCodeReveal shows a one-time recovery code with a copy button and a
// confirm-I-saved-it gate. Shared by signup (DirectoryScreen SetupPrompt) and
// the settings "enroll / regenerate" flow (UserSettings).
export function RecoveryCodeReveal({
  code,
  intro,
  onContinue,
  continueLabel = 'I’ve saved it — continue',
}: {
  code: string;
  intro: string;
  onContinue: () => void;
  continueLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [acked, setAcked] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the code is visible to copy by hand */
    }
  };
  return (
    <div class="directory-setup-prompt recovery-code-reveal">
      <div class="directory-setup-header">
        <div class="directory-prompt">$ boson account --recovery-code</div>
        <h2>Your recovery code</h2>
        <p>{intro}</p>
      </div>
      <pre class="recovery-code-value" aria-label="recovery code">{code}</pre>
      <div class="recovery-code-actions">
        <Button type="button" variant="secondary" onClick={() => { void copy(); }}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <label class="recovery-code-ack">
        <input type="checkbox" checked={acked} onInput={(e) => setAcked((e.target as HTMLInputElement).checked)} />
        I’ve saved my recovery code somewhere safe.
      </label>
      <Button type="button" variant="primary" disabled={!acked} onClick={onContinue}>
        {continueLabel}
      </Button>
    </div>
  );
}
