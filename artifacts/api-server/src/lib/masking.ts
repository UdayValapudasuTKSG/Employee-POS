export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "•••";
  const maskedLocal = local[0] + "•".repeat(Math.max(local.length - 1, 2));
  const dot = domain.lastIndexOf(".");
  const domName = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  const maskedDomain = domName[0] + "•".repeat(Math.max(domName.length - 1, 2));
  return `${maskedLocal}@${maskedDomain}${tld}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const last = digits.slice(-2);
  return `•••-••${last}`;
}

export function maskIdentifier(identifier: string): string {
  return identifier.includes("@") ? maskEmail(identifier) : maskPhone(identifier);
}

/**
 * Non-identifying disambiguation label, e.g. "J•••• D••••, born 19••-04".
 * DateOfBirth is optional in the BHI model; without one the label says so.
 */
export function disambiguationLabel(
  firstName: string,
  lastName: string,
  dateOfBirth: string | null,
): string {
  const f = (firstName[0] ?? "•") + "•".repeat(Math.max(firstName.length - 1, 3));
  const l = (lastName[0] ?? "•") + "•".repeat(Math.max(lastName.length - 1, 3));
  if (!dateOfBirth) return `${f} ${l}, date of birth not on file`;
  const [year = "", month = ""] = dateOfBirth.split("-");
  return `${f} ${l}, born ${year.slice(0, 2)}••-${month}`;
}
