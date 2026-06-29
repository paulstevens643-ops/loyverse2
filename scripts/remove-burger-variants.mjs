import fs from "node:fs/promises";

const token = process.env.LOYVERSE_TOKEN;
if (!token) {
  throw new Error("Missing LOYVERSE_TOKEN secret.");
}

const apiBase = "https://api.loyverse.com/v1.0";
const mappingPath = new URL("../data/white_swan_loyverse_mapping.json", import.meta.url);
const mapping = JSON.parse(await fs.readFile(mappingPath, "utf8"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

const summary = {
  burgersChecked: [],
  variantsDeleted: [],
  itemsStandardized: [],
  warnings: [],
};

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`Loyverse ${response.status} ${path}: ${text}`);
  }
  await sleep(120);
  return body;
}

async function listAll(resource, key) {
  const out = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: "250" });
    if (cursor) query.set("cursor", cursor);
    const page = await request(`/${resource}?${query}`);
    out.push(...(page[key] || []));
    cursor = page.cursor || null;
  } while (cursor);
  return out;
}

function variantLabel(variant) {
  return [variant.option1_value, variant.option2_value, variant.option3_value].filter(Boolean).join(" / ") || "Standard";
}

function hasVariantOptions(variant) {
  return Boolean(variant.option1_value || variant.option2_value || variant.option3_value);
}

function isDoubleVariant(variant) {
  return /\bdouble\b/i.test(variantLabel(variant));
}

function isSingleOrStandardVariant(variant) {
  return /\b(single|standard)\b/i.test(variantLabel(variant)) || !hasVariantOptions(variant);
}

function chooseVariantToKeep(variants) {
  return (
    variants.find((variant) => isSingleOrStandardVariant(variant)) ||
    variants.find((variant) => !isDoubleVariant(variant)) ||
    variants[0]
  );
}

function storesPayload(variant) {
  return (variant.stores || []).map((store) => ({
    store_id: store.store_id,
    pricing_type: store.pricing_type || variant.default_pricing_type || "FIXED",
    price: store.price ?? variant.default_price ?? null,
    available_for_sale: store.available_for_sale ?? true,
    optimal_stock: store.optimal_stock ?? null,
    low_stock: store.low_stock ?? null,
  }));
}

function standardVariantPayload(variant) {
  const payload = {
    variant_id: variant.variant_id,
    item_id: variant.item_id,
    sku: variant.sku,
    cost: variant.cost ?? 0,
    default_pricing_type: variant.default_pricing_type || "FIXED",
    default_price: variant.default_price ?? null,
    stores: storesPayload(variant),
  };

  if (variant.reference_variant_id) payload.reference_variant_id = variant.reference_variant_id;
  if (variant.barcode) payload.barcode = variant.barcode;
  if (variant.purchase_cost != null) payload.purchase_cost = variant.purchase_cost;
  return payload;
}

function itemPayloadWithoutVariantOptions(item, variant) {
  const payload = {
    id: item.id,
    item_name: item.item_name,
    category_id: item.category_id ?? null,
    track_stock: item.track_stock ?? false,
    sold_by_weight: item.sold_by_weight ?? false,
    is_composite: item.is_composite ?? false,
    use_production: item.use_production ?? false,
    components: item.components || [],
    tax_ids: item.tax_ids || [],
    modifiers_ids: item.modifiers_ids || item.modifier_ids || [],
    form: item.form || "SQUARE",
    color: item.color || "GREEN",
    variants: [standardVariantPayload(variant)],
  };

  if (item.description) payload.description = item.description;
  if (item.reference_id) payload.reference_id = item.reference_id;
  if (item.primary_supplier_id) payload.primary_supplier_id = item.primary_supplier_id;
  return payload;
}

const categories = await listAll("categories", "categories");
const gourmetCategory = categories.find((category) => norm(category.name) === "gourmet burgers");
const burgerNames = new Set(
  mapping.items
    .filter((item) => norm(item.category) === "gourmet burgers")
    .map((item) => norm(item.name)),
);

const items = await listAll("items", "items");
const burgers = items.filter(
  (item) => item.category_id === gourmetCategory?.id || burgerNames.has(norm(item.item_name)),
);

for (const item of burgers) {
  const variants = item.variants || [];
  summary.burgersChecked.push({
    item: item.item_name,
    before: variants.map((variant) => ({
      variant_id: variant.variant_id,
      label: variantLabel(variant),
      available: variant.stores?.[0]?.available_for_sale,
    })),
  });

  if (!variants.length) {
    summary.warnings.push(`${item.item_name}: skipped because it has no variants`);
    continue;
  }

  const keep = chooseVariantToKeep(variants);
  const deleteTargets = variants.filter((variant) => variant.variant_id !== keep.variant_id);
  for (const variant of deleteTargets) {
    await request(`/variants/${variant.variant_id}`, { method: "DELETE" });
    summary.variantsDeleted.push({
      item: item.item_name,
      variant_id: variant.variant_id,
      label: variantLabel(variant),
    });
  }

  const fresh = await request(`/items/${item.id}`);
  const remaining = fresh.variants || [];
  const remainingVariant = remaining.find((variant) => variant.variant_id === keep.variant_id) || remaining[0];
  if (!remainingVariant) {
    summary.warnings.push(`${item.item_name}: no remaining variant after cleanup`);
    continue;
  }

  const hasItemOptions = Boolean(fresh.option1_name || fresh.option2_name || fresh.option3_name);
  if (hasItemOptions || hasVariantOptions(remainingVariant) || remaining.length > 1) {
    try {
      const saved = await request("/items", {
        method: "POST",
        body: JSON.stringify(itemPayloadWithoutVariantOptions(fresh, remainingVariant)),
      });
      summary.itemsStandardized.push({
        item: saved.item_name,
        kept_variant_id: saved.variants?.[0]?.variant_id || remainingVariant.variant_id,
        kept_sku: saved.variants?.[0]?.sku || remainingVariant.sku,
      });
    } catch (error) {
      summary.warnings.push(`${item.item_name}: deleted extra variants, but could not clear the remaining variant label: ${error.message}`);
    }
  }
}

const finalItems = await listAll("items", "items");
const finalBurgers = finalItems
  .filter((item) => item.category_id === gourmetCategory?.id || burgerNames.has(norm(item.item_name)))
  .map((item) => ({
    item: item.item_name,
    option1_name: item.option1_name || null,
    option2_name: item.option2_name || null,
    option3_name: item.option3_name || null,
    variants: (item.variants || []).map((variant) => ({
      variant_id: variant.variant_id,
      sku: variant.sku,
      label: variantLabel(variant),
      price: variant.default_price,
      available: variant.stores?.[0]?.available_for_sale,
    })),
  }));

await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile("artifacts/burger-variant-cleanup-summary.json", JSON.stringify(summary, null, 2));
await fs.writeFile("artifacts/burger-variant-cleanup-verify.json", JSON.stringify({ burgers: finalBurgers }, null, 2));

console.log(JSON.stringify(summary, null, 2));
