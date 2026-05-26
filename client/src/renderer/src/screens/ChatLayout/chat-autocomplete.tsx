import type { SlashCommandSpec } from '../../modules/chat';

// Autocomplete popup components for the chat input. Extracted from
// ChatArea.tsx to keep the view file focused on layout + hook plumbing.
// Each popup is pure presentation: it renders the matches array out of
// ChatInputState and forwards the click/hover intents back through the
// callbacks supplied by the parent (which wire them to ChatInputBloc).

interface SlashAutocompleteProps {
  matches: readonly SlashCommandSpec[];
  selected: number;
  onHover: (idx: number) => void;
  onPick: (idx: number) => void;
}

export function SlashAutocomplete({ matches, selected, onHover, onPick }: SlashAutocompleteProps) {
  return (
    <div class="slash-autocomplete" role="listbox" aria-label="Slash command autocomplete">
      {matches.map((c, idx) => (
        <button
          key={c.name}
          type="button"
          role="option"
          aria-selected={idx === selected}
          class={`slash-ac-item ${idx === selected ? 'slash-ac-item-selected' : ''}`}
          onMouseEnter={() => onHover(idx)}
          onMouseDown={(e) => {
            // mousedown (not click) so we beat the textarea blur.
            e.preventDefault();
            onPick(idx);
          }}
        >
          <span class="slash-ac-usage">{c.usage}</span>
          <span class="slash-ac-desc">{c.description}</span>
        </button>
      ))}
    </div>
  );
}

interface MentionAutocompleteProps {
  matches: readonly string[];
  selected: number;
  onHover: (idx: number) => void;
  onPick: (idx: number) => void;
}

export function MentionAutocomplete({ matches, selected, onHover, onPick }: MentionAutocompleteProps) {
  return (
    <div class="mention-autocomplete" role="listbox" aria-label="Mention autocomplete">
      {matches.map((nick, idx) => (
        <button
          key={nick}
          type="button"
          role="option"
          aria-selected={idx === selected}
          class={`mention-ac-item ${idx === selected ? 'mention-ac-item-selected' : ''}`}
          onMouseEnter={() => onHover(idx)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(idx);
          }}
        >
          <span class="mention-ac-at">@</span>
          <span class="mention-ac-nick">{nick}</span>
        </button>
      ))}
    </div>
  );
}

interface ChannelAutocompleteProps {
  matches: readonly string[];
  selected: number;
  onHover: (idx: number) => void;
  onPick: (idx: number) => void;
}

export function ChannelAutocomplete({ matches, selected, onHover, onPick }: ChannelAutocompleteProps) {
  return (
    <div class="mention-autocomplete" role="listbox" aria-label="Channel autocomplete">
      {matches.map((name, idx) => (
        <button
          key={name}
          type="button"
          role="option"
          aria-selected={idx === selected}
          class={`mention-ac-item ${idx === selected ? 'mention-ac-item-selected' : ''}`}
          onMouseEnter={() => onHover(idx)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(idx);
          }}
        >
          <span class="mention-ac-at">{name.charAt(0)}</span>
          <span class="mention-ac-nick">{name.slice(1)}</span>
        </button>
      ))}
    </div>
  );
}
