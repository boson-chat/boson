// Dedicated worker for Argon2id (see ./argon2.ts): keeps the ~0.7s, 64 MiB
// derivation off the renderer's main thread.
import { argon2idInline, type Argon2Request, type Argon2Response } from './argon2';

self.onmessage = async (ev: MessageEvent<Argon2Request>) => {
  const { id, password, salt, params } = ev.data;
  let res: Argon2Response;
  try {
    res = { id, key: await argon2idInline(password, salt, params) };
  } catch (err) {
    res = { id, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(res);
};
