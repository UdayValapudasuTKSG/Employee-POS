/**
 * Who issued the card, as configuration rather than as source code.
 *
 * The insurer's trading name, street address, telephone number, the officer who
 * signs the card and the notices printed on it were all string literals spread
 * across three files — the card screen, the PDF renderer and the card route.
 * Deploying this portal for a second insurer meant editing and rebuilding the
 * application, and a wrong value could only be fixed by a release.
 *
 * They are environment variables now, read once per request from `process.env`
 * so a restart is enough to correct one. Nothing here has a built-in default
 * naming any organisation: an unset value renders as absent rather than as some
 * other insurer's details. `artifacts/api-server/.env.example` carries the full set.
 *
 * `planTitle` and `backNotice` are the exceptions that do have defaults —
 * generic wording that names nobody, so a deployment that has not thought about
 * them still produces a sensible card.
 */

export interface IssuerDetails {
  /**
   * Trading name for the card header. Null falls back to the insurer name on
   * the member's own policy row, which every card already carries.
   */
  name: string | null;
  address: string | null;
  phone: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  /** The red title on the card face. */
  planTitle: string;
  /** The "property of" line on the reverse. Composed when not set explicitly. */
  propertyNotice: string | null;
  /** The conditions-of-use paragraph carried with the card. */
  backNotice: string;
}

const DEFAULT_PLAN_TITLE = "MEDICAL INSURANCE PLAN";

/**
 * Names no organisation, so it is safe as a built-in. Anything naming the
 * insurer belongs in ISSUER_* instead.
 */
const DEFAULT_BACK_NOTICE =
  "This card is for identification only and does not guarantee eligibility. " +
  "Present this card together with valid photo identification at the point of service. " +
  "Report lost or stolen cards to your HR department immediately.";

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/**
 * Builds the "property of" line from the name and address when the deployment
 * has not written one itself, so the common case needs two variables rather
 * than three and the address cannot disagree with itself.
 */
function composePropertyNotice(name: string | null, address: string | null): string | null {
  const explicit = env("CARD_PROPERTY_NOTICE");
  if (explicit) return explicit;
  if (!name) return null;
  // "Insurance Co. Ltd." already ends in a stop; appending another gives
  // "Ltd..". Trim one before the sentence break, but keep the name intact
  // where it is followed by a comma.
  const sentence = name.replace(/\.\s*$/, "");
  const where = address ? `${name}, ${address}` : name;
  return `This card is the property of ${sentence}. If found please return to ${where}.`;
}

export function issuerDetails(): IssuerDetails {
  const name = env("ISSUER_NAME");
  const address = env("ISSUER_ADDRESS");
  return {
    name,
    address,
    phone: env("ISSUER_PHONE"),
    signatoryName: env("ISSUER_SIGNATORY_NAME"),
    signatoryTitle: env("ISSUER_SIGNATORY_TITLE"),
    planTitle: env("ISSUER_PLAN_TITLE") ?? DEFAULT_PLAN_TITLE,
    propertyNotice: composePropertyNotice(name, address),
    backNotice: env("CARD_BACK_NOTICE") ?? DEFAULT_BACK_NOTICE,
  };
}
