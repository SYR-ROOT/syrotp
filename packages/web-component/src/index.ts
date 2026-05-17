import { SyrotpVerificationElement } from "./element.js";

export { SyrotpVerificationElement } from "./element.js";
export { VerificationController } from "./controller.js";
export type {
  VerificationControllerOptions,
} from "./controller.js";
export type {
  SyrotpVerificationCallbacks,
  Verification,
  VerificationStatus,
} from "./types.js";

/**
 * Register the custom element under a tag name. Calling this more
 * than once with the same name is a no-op (the underlying
 * `customElements.define()` would throw on a duplicate).
 *
 * Defaults to `syrotp-verification`. Pass a different name to scope
 * the element to a custom prefix; pass `null` / undefined to use
 * the default.
 */
export function defineSyrotpVerification(
  tagName: string = SyrotpVerificationElement.tagName,
): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(tagName)) return;
  customElements.define(tagName, SyrotpVerificationElement);
}

// Auto-register on import. The package's `sideEffects` field is set
// to allow this — bundlers will keep the registration call when the
// module is imported even if no symbols from it are referenced.
defineSyrotpVerification();
