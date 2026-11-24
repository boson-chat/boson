import { useState } from 'preact/hooks';
import { Button } from '@boson/shared';

// RecoveryCodeReveal shows a one-time recovery code with Copy and Download
// buttons and one "I've saved it" confirmation. Shared by signup
// (DirectoryScreen SetupPrompt) and the settings "enroll / regenerate" flow
// (UserSettings).
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
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the code is visible to copy by hand */
    }
  };
  // The groups wrap only between groups (never mid-group); each dash stays
  // with the group before it, so a copy by hand reads the same.
  const groups = code.split('-');
  return (
    <div class="directory-setup-prompt recovery-code-reveal">
      <div class="directory-setup-header">
        <h2>Your recovery code</h2>
        <p>{intro}</p>
      </div>
      <pre class="recovery-code-value" aria-label="recovery code">{groups.map((g, i) => (
        <span key={i} class="recovery-code-group">{g}{i < groups.length - 1 ? '-' : ''}</span>
      ))}</pre>
      <div class="recovery-code-actions">
        <Button type="button" variant="secondary" onClick={() => { void copy(); }}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => downloadRecoveryCode(code)}>
          Download .txt
        </Button>
      </div>
      <Button type="button" variant="primary" onClick={onContinue}>
        {continueLabel}
      </Button>
    </div>
  );
}

// Saves the code as a small text file (the browser's download).
export function downloadRecoveryCode(code: string): void {
  const text = [
    'Boson recovery code',
    '',
    code,
    '',
    'Keep this somewhere safe. If you reset your Boson password, you need this',
    'code once to unlock your synced passwords again. Boson cannot recover it for you.',
    '',
  ].join('\n');
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'boson-recovery-code.txt';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* no downloads here — Copy still works */
  }
}
