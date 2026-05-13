export type Marketplace = "ES" | "FR" | "IT" | "DE";

export const EDIFIER_ES_ASINS = new Set<string>([
  "B07MC6D6NZ",
  "B0G25Y7M6C",
  "B0CN995CBL",
  "B077Y6PHKQ",
  "B07XZMNNWD",
  "B07XZK1GK6",
  "B0FYHFZF65",
  "B07W92YBCQ",
]);

// Brand names in lowercase — matched with marcaLower.includes(brand)
export const ES_ONLY_BRANDS = new Set<string>(["fiio", "eversolo"]);
export const ALL_EU_BRANDS  = new Set<string>(["vulkkano", "hiby"]);

/**
 * Returns true if this product is subject to our exclusive-brand rule
 * and constitutes a violation when hay_buybox=true AND tenemos=false.
 */
export function isExclusiveBrand(
  asin: string,
  marca: string,
  pais: Marketplace
): boolean {
  const m = marca.toLowerCase();

  for (const b of ALL_EU_BRANDS)  if (m.includes(b)) return true;

  if (pais === "ES") {
    for (const b of ES_ONLY_BRANDS) if (m.includes(b)) return true;
    if (EDIFIER_ES_ASINS.has(asin)) return true;
  }

  return false;
}
