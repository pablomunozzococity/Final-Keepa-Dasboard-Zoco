const KEEPA_BASE = "https://api.keepa.com";

type KeepaCategoryObject = {
  catId: number;
  name: string;
  productCount?: number;
  highestRank?: number;
};

type KeepaCategoryResponse = {
  categories: Record<string, KeepaCategoryObject>;
};

export type CategoryInfo = {
  catId: number;
  domain: string;
  nombre: string;
  total: number;
};

export async function fetchCategoryInfo(
  catId: number,
  domain: number,
  domainCode: string,
  keepaKey: string
): Promise<CategoryInfo | null> {
  const url =
    `${KEEPA_BASE}/category` +
    `?key=${keepaKey}` +
    `&domain=${domain}` +
    `&category=${catId}` +
    `&parents=0`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  Category API error for catId ${catId}: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as KeepaCategoryResponse;
    const cat = data.categories?.[String(catId)];
    if (!cat) return null;

    return {
      catId,
      domain: domainCode,
      nombre: cat.name,
      total: cat.productCount ?? cat.highestRank ?? 0,
    };
  } catch (err) {
    console.warn(`  Category fetch failed for catId ${catId}:`, err);
    return null;
  }
}
