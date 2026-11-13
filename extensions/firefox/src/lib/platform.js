/** Browser engine detection. Firefox exposes proxy.onRequest; Chromium browsers use PAC scripts. */
const ext = globalThis.chrome;

export const IS_FIREFOX = Boolean(ext?.runtime?.getURL?.('')?.startsWith('moz-extension:'));

/** Firefox can log in to SOCKS5 proxies; Chromium cannot. */
export const CAPS = Object.freeze({ socksAuth: IS_FIREFOX });
