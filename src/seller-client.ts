const KEEPA_BASE = "https://api.keepa.com";

export type SellerInfo = {
  sellerId: string;
  nombre: string;
};

export async function fetchSellerNames(
  sellerIds: string[],
  domain: number,
  keepaKey: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (sellerIds.length === 0) return result;

  // Keepa allows up to 100 sellers per request
  const BATCH_SIZE = 100;
  for (let i = 0; i < sellerIds.length; i += BATCH_SIZE) {
    const batch = sellerIds.slice(i, i + BATCH_SIZE);
    const url =
      `${KEEPA_BASE}/seller` +
      `?key=${keepaKey}` +
      `&domain=${domain}` +
      `&seller=${batch.join(",")}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  Seller API error: ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        sellers: Record<string, { sellerName?: string }>;
      };
      for (const id of batch) {
        const name = data.sellers?.[id]?.sellerName;
        if (name) result.set(id, name);
      }
    } catch (err) {
      console.warn(`  Seller fetch failed:`, err);
    }
  }

  return result;
}
