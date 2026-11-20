import type { ComponentChildren } from 'preact';
import { ArrowLeft } from 'lucide-preact';
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
      <header class="phone-page-head">
        <button type="button" class="phone-page-back" onClick={onBack} aria-label={backLabel}>
          <ArrowLeft size={22} aria-hidden="true" />
        </button>
        <span class="phone-page-titles">
          <h1 class="phone-page-title">{title}</h1>
          {sub && <span class="phone-page-sub">{sub}</span>}
        </span>
      </header>
      <div class="phone-page-body">{children}</div>
    </section>
  );
}
