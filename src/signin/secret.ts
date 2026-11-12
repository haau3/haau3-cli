// The two secrets of signing in, held as the API key is (src/key.ts): the access token a session
// sends, and the device code that only the command line and the sign-in service know while a person
// approves. Each prints as hidden however it is printed; only reveal() returns the value, for the
// request that sends it, the store that keeps it, and the check that an answer does not repeat it.
import { inspect } from "node:util";

abstract class Hidden {
  readonly #value: string;
  readonly #shown: string;

  constructor(value: string, shown: string) {
    this.#value = value;
    this.#shown = shown;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return this.#shown;
  }

  toJSON(): string {
    return this.#shown;
  }

  [Symbol.toPrimitive](): string {
    return this.#shown;
  }

  [inspect.custom](): string {
    return this.#shown;
  }
}

/** The session's access token. Sent only as a Bearer token to the platform and to revocation. */
export class AccessToken extends Hidden {
  constructor(value: string) {
    super(value, "[haau3 token hidden]");
  }
}

/** The device code (RFC 8628, section 3.2): the secret half of a sign-in waiting for approval. */
export class DeviceCode extends Hidden {
  constructor(value: string) {
    super(value, "[haau3 device code hidden]");
  }
}
