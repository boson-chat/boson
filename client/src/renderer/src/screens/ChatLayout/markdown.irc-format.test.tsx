import { describe, it, expect } from 'vitest';
import { stripIrcFormatting } from './markdown';
import { renderMessageBody } from './message-render';
import { render } from '@testing-library/preact';

describe('IRC formatting codes', () => {
  it('strips bold / color (with digits) / hex color / italic / underline / reverse / reset', () => {
    expect(stripIrcFormatting('irc \x02bold\x02 \x0304,01red\x03 \x0312blue\x03 \x04ff0000hex\x04 \x1Ditalic\x1D \x1Funder\x1F \x16rev\x16 \x11mono\x11 \x1Estrike\x1E \x0Freset'))
      .toBe('irc bold red blue hex italic under rev mono strike reset');
  });

  it('keeps digits that are text, not a color', () => {
    expect(stripIrcFormatting('\x03 10 apples')).toBe(' 10 apples');
    expect(stripIrcFormatting('score: 10,5')).toBe('score: 10,5');
  });

  it('message bodies render without the raw control codes', () => {
    const { container } = render(<div>{renderMessageBody('\x02hi\x02 \x0304there\x03', 'me', [])}</div>);
    expect(container.textContent).toBe('hi there');
  });
});
