import { ulid } from "ulid";

// Prefixed ULIDs are sortable, opaque, and visually distinguishable.
export const newId = (prefix: string): string => `${prefix}_${ulid()}`;

export const VERIFICATION_PREFIX = "vrf";
export const RECEIVER_PREFIX = "rcv";
export const API_KEY_PREFIX = "key";
export const APP_PREFIX = "app";
export const INBOUND_PREFIX = "in";
export const WEBHOOK_ENDPOINT_PREFIX = "whk";
export const WEBHOOK_EVENT_PREFIX = "evt";
export const WEBHOOK_DELIVERY_PREFIX = "wd";
export const WEBAUTHN_CREDENTIAL_PREFIX = "wac";
export const WEBAUTHN_CHALLENGE_PREFIX = "wch";
export const PHONE_BINDING_PREFIX = "pbn";
