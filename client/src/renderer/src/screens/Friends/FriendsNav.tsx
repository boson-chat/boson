import type { ComponentChildren } from 'preact';
import { ArrowLeft } from 'lucide-preact';
import { PageHeader } from '@boson/shared';
import './FriendsNav.css';

interface PageProps {
  title: string;
  sub?: string;
  onBack: () => void;
  // What the back arrow goes back to (its label).
  backLabel?: string;
  children: ComponentChildren;
}

// Phones: a page that fills the screen under the top bar (Friends, Calls,
// Notifications), with a back arrow to the list it came from.
export function PhonePage({ title, sub, onBack, backLabel = 'Back', children }: PageProps) {
  return (
    <section class="phone-page" aria-label={title}>
      <PageHeader layout="phone" title={title} sub={sub} onBack={onBack} backLabel={backLabel} backIcon={<ArrowLeft />} />
      <div class="phone-page-body">{children}</div>
    </section>
  );
}
