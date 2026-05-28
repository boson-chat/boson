import { useEffect, useRef, useState } from 'preact/hooks';
import './Tabs.css';

interface TabItem {
  id: string;
  label: string;
}

interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
}

interface IndicatorRect {
  left: number;
  width: number;
}

// Sliding indicator: a single absolutely-positioned bar whose `left` +
// `width` are driven by the active tab's bounding box. Replaces the
// previous per-tab `::after` accent — that snapped between tabs on
// click, this glides via CSS transition. Measurement uses
// getBoundingClientRect against the tablist itself so the math is
// independent of scroll / parent offsets.
export function Tabs({ tabs, active, onChange }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<IndicatorRect | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const btn = tabRefs.current.get(active);
    if (!list || !btn) {
      setIndicator(null);
      return;
    }
    const listBox = list.getBoundingClientRect();
    const btnBox = btn.getBoundingClientRect();
    setIndicator({ left: btnBox.left - listBox.left, width: btnBox.width });
  }, [active, tabs]);

  return (
    <div class="bds-tabs" role="tablist" ref={listRef}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          class={`bds-tab ${t.id === active ? 'bds-tab-active' : ''}`}
          ref={(el) => {
            if (el) tabRefs.current.set(t.id, el);
            else tabRefs.current.delete(t.id);
          }}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
      {indicator && (
        <span
          class="bds-tab-indicator"
          aria-hidden="true"
          style={`left: ${indicator.left}px; width: ${indicator.width}px;`}
        />
      )}
    </div>
  );
}
