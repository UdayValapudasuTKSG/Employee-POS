/**
 * Timing and attempt limits, kept in a side-effect-free module.
 *
 * These used to live in auth.ts, but that module validates SESSION_SECRET at
 * load time and throws without it — so importing a constant from there dragged
 * in a hard environment requirement. Anything that only needs a number should
 * import it from here instead.
 */

export const OTP_TTL_SECONDS = 5 * 60;
export const CARD_TTL_SECONDS = 15 * 60;
export const MAX_OTP_ATTEMPTS = 3;
export const ADMIN_JWT_TTL_SECONDS = 8 * 60 * 60;
