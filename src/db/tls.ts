export function validateDatabaseCaCertificate(
  value: string,
  name = "DATABASE_CA_CERT"
): string {
  const certificate = value.trim();
  const match = /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----$/.exec(certificate);
  const payload = match?.[1]?.replace(/\s/g, "") ?? "";
  if (payload.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new Error(`${name} must contain a PEM certificate`);
  }
  return certificate;
}
