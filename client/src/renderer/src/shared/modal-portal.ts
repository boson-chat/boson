import { createPortal } from 'preact/compat';
import { setModalPortal } from '@boson/shared';

// Every design-system Modal renders at the end of <body>, like BottomSheet,
// so the phone layout's transformed layers can't stack it under the title
// bar (the shared package can't portal on its own: no preact/compat there).
setModalPortal(createPortal);
