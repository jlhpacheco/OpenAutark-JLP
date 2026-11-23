// A linked PC on an older version answers a mesh method this version added with 'not_found' ("Unknown peer method …",
// rpc-peer.ts) – a refusal that never turns into an answer by asking again while that link lasts (the PC's next version
// comes with a new link-up). A sync that learns this stops sending that PC that method until the next link-up, instead of
// retrying on its own rhythm and logging the same failure each time.
// Owns: telling that answer from any other failure. Never: sends, remembers or logs anything.

import { WorkforceError } from '../../../shared/errors.ts';

/** Whether `error` is a linked PC's answer that its version has no such mesh method (also: not open to this kind of link). */
export function noMethod(error: unknown): boolean {
  return error instanceof WorkforceError && error.code === 'not_found' && /^Unknown peer method /.test(error.message);
}
