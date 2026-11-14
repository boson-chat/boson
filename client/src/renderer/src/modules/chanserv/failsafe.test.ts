// Replies we don't understand must never turn into a state: translated
// services, odd forks, interleaved chatter. Each case here would be easy to
// "half-match" with looser patterns.
import { describe, it, expect } from 'vitest';
import { getChanServAdapter } from './adapters';
import type { ChanServDialect } from './chanserv.types';
import { drive } from './drive.testutil';

const info = (d: ChanServDialect, lines: string[]) => drive(getChanServAdapter(d).info('#dev'), [lines]).result;

describe('unknown and localised replies fail safe', () => {
  it('Anope in German (anope.de_DE.po) reads as unreadable, not "not registered"', () => {
    expect(info('anope', ['Information für den Raum \x02#dev\x02:', '  Gründer: ada', ' Registriert: 14. Nov 2026'])).toMatchObject({ kind: 'error', code: 'unreadable' });
    expect(info('anope', ['Der Raum \x02#dev\x02 ist nicht registriert.'])).toMatchObject({ kind: 'error', code: 'unreadable' });
  });

  it('Atheme in German (po/de.po) reads as unreadable', () => {
    expect(info('atheme', ['Informationen für \x02#dev\x02:', 'Gründer    : ada', '\x02*** Ende der Info ***\x02'])).toMatchObject({ kind: 'error', code: 'unreadable' });
  });

  it('a mistranslated success line is not taken as "no such account"', () => {
    // anope.de_DE.po really translates "Nick %s isn't registered." as
    // "…wurde erfolgreich registriert." ("registered successfully").
    const r = drive(getChanServAdapter('anope').setAccess!('#dev', 'ghost', 'op'), [['Der Nickname \x02ghost\x02 wurde erfolgreich registriert.']]).result;
    expect(r).toMatchObject({ kind: 'error', code: 'unreadable' });
  });

  it('an Anope INFO header with keys we do not know is unreadable', () => {
    expect(info('anope', ['Information for channel \x02#dev\x02:', '  Propriétaire: ada'])).toMatchObject({ kind: 'error', code: 'unreadable' });
  });

  it('chatter before the answer is skipped, not misread', () => {
    // An entry message from another channel arrives first.
    const r = info('ergo', ['[#lobby] Welcome! Read the rules.', 'Channel #dev is registered', 'Founder: ada', 'Registered at: Sat, 14 Nov 2026 10:00:00 UTC']);
    expect(r).toMatchObject({ kind: 'info', info: { registered: true, founder: 'ada' } });
  });

  it('only unrelated lines → unreadable, for every dialect that asks', () => {
    for (const d of ['ergo', 'anope', 'atheme', 'x', 'generic'] as const) {
      expect(info(d, ['Services are restarting, please wait.'])).toMatchObject({ kind: 'error', code: 'unreadable' });
    }
  });

  it('actions never report success on an unrecognised reply', () => {
    const a = getChanServAdapter('ergo');
    expect(drive(a.register!('#dev'), [['Kanal #dev erfolgreich registriert']]).result).toMatchObject({ kind: 'error', code: 'unreadable' });
    const b = getChanServAdapter('atheme');
    expect(drive(b.unregister!('#dev'), [['Bitte bestätigen: /msg ChanServ DROP #dev abc']]).result).toMatchObject({ kind: 'error', code: 'unreadable' });
  });

  it('a replay prompt is only followed when it names the expected command', () => {
    // Ergo's transfer prompt must carry TRANSFER; a HELP pointer is not a prompt.
    const r = drive(getChanServAdapter('ergo').transfer!('#dev', 'nova', 'ada'), [['For more details, try /CS HELP TRANSFER']]);
    expect(r.sent).toEqual(['TRANSFER #dev nova']);
    expect(r.result).toMatchObject({ kind: 'error', code: 'unreadable' });
  });
});
