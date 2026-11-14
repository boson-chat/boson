import type { ChanServDialect } from '../chanserv.types';
import type { ChanServAdapter } from './adapter';
import { AnopeChanServ } from './anope';
import { AthemeChanServ } from './atheme';
import { ErgoChanServ } from './ergo';
import { GenericChanServ, QuakeNetQ, UndernetX } from './readonly';

export type { ChanServAdapter } from './adapter';
export { AnopeChanServ, AthemeChanServ, ErgoChanServ, GenericChanServ, QuakeNetQ, UndernetX };

export function getChanServAdapter(dialect: ChanServDialect): ChanServAdapter {
  switch (dialect) {
    case 'ergo': return new ErgoChanServ();
    case 'anope': return new AnopeChanServ();
    case 'atheme': return new AthemeChanServ();
    case 'x': return new UndernetX();
    case 'q': return new QuakeNetQ();
    case 'generic': return new GenericChanServ();
  }
}
