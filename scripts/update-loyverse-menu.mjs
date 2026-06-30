import fs from "node:fs/promises";

const token = process.env.LOYVERSE_TOKEN;
if (!token) {
  throw new Error("Missing LOYVERSE_TOKEN secret.");
}

const apiBase = "https://api.loyverse.com/v1.0";
const mappingPath = new URL("../data/white_swan_loyverse_mapping.json", import.meta.url);
const mapping = JSON.parse(await fs.readFile(mappingPath, "utf8"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const shortHash = (value) => {
  let hash = 0;
  for (const char of String(value)) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
};
const makeReferenceId = (row) => {
  const base = `ws-${slug(row.category)}-${slug(row.name)}`;
  const suffix = shortHash(`${row.category}|${row.name}`);
  return `${base.slice(0, 49 - suffix.length)}-${suffix}`.slice(0, 50);
};

const summary = {
  categories: { created: [], updated: [], unchanged: [] },
  modifiers: { created: [], updated: [], unchanged: [] },
  items: { created: [], updated: [], unchanged: [] },
  assignments: [],
  doubleVariantsDisabled: [],
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

function findByName(list, field, name) {
  return list.find((item) => norm(item[field]) === norm(name));
}

function isDoubleVariant(variant) {
  const values = [variant.option1_value, variant.option2_value, variant.option3_value].filter(Boolean).join(" ");
  return /\bdouble\b/i.test(values);
}

function isSingleOrStandardVariant(variant) {
  const values = [variant.option1_value, variant.option2_value, variant.option3_value].filter(Boolean).join(" ");
  return !values || /\b(single|standard)\b/i.test(values);
}

function storesPayload(variant, changes = {}) {
  return (variant.stores || []).map((store) => ({
    store_id: store.store_id,
    pricing_type: changes.price == null ? store.pricing_type || "FIXED" : "FIXED",
    price: changes.price ?? store.price ?? variant.default_price ?? null,
    available_for_sale: changes.availableForSale ?? store.available_for_sale ?? true,
    optimal_stock: store.optimal_stock ?? null,
    low_stock: store.low_stock ?? null,
  }));
}

function existingVariantPayload(variant, changes = {}) {
  const payload = {
    variant_id: variant.variant_id,
    item_id: variant.item_id,
    sku: variant.sku,
    cost: changes.cost ?? variant.cost ?? 0,
    default_pricing_type: changes.price == null ? variant.default_pricing_type || "FIXED" : "FIXED",
    default_price: changes.price ?? variant.default_price ?? null,
    stores: storesPayload(variant, changes),
  };

  if (variant.reference_variant_id) payload.reference_variant_id = variant.reference_variant_id;
  if (variant.option1_value) payload.option1_value = variant.option1_value;
  if (variant.option2_value) payload.option2_value = variant.option2_value;
  if (variant.option3_value) payload.option3_value = variant.option3_value;
  if (variant.barcode) payload.barcode = variant.barcode;
  if (variant.purchase_cost != null) payload.purchase_cost = variant.purchase_cost;
  return payload;
}

function newVariantPayload(row) {
  return {
    sku: `WS-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 10000)}`,
    cost: row.cost ?? 0,
    default_pricing_type: "FIXED",
    default_price: row.price,
    stores: [],
  };
}

function variantsPayload(row, existingItem) {
  const variants = existingItem?.variants || [];
  if (!variants.length) return [newVariantPayload(row)];

  const preferred =
    variants.find((variant) => isSingleOrStandardVariant(variant)) ||
    variants.find((variant) => !isDoubleVariant(variant)) ||
    variants[0];

  return variants.map((variant) => {
    if (isDoubleVariant(variant)) {
      summary.doubleVariantsDisabled.push({
        item: row.name,
        variant: variant.option1_value || variant.sku || variant.variant_id,
      });
      return existingVariantPayload(variant, { cost: row.cost, availableForSale: false });
    }
    if (variant.variant_id === preferred.variant_id) {
      return existingVariantPayload(variant, { price: row.price, cost: row.cost, availableForSale: true });
    }
    return existingVariantPayload(variant, { cost: row.cost });
  });
}

function itemPayload(row, categoryId, modifierIds, existingItem) {
  const variants = variantsPayload(row, existingItem);
  const payload = {
    ...(existingItem?.id ? { id: existingItem.id } : {}),
    item_name: row.name,
    description: row.description || undefined,
    reference_id: existingItem?.reference_id || makeReferenceId(row),
    category_id: categoryId,
    track_stock: existingItem?.track_stock ?? false,
    sold_by_weight: existingItem?.sold_by_weight ?? false,
    is_composite: existingItem?.is_composite ?? false,
    use_production: existingItem?.use_production ?? false,
    components: existingItem?.components || [],
    tax_ids: existingItem?.tax_ids || [],
    modifiers_ids: modifierIds,
    form: existingItem?.form || "SQUARE",
    color: existingItem?.color || "GREEN",
    variants,
  };
  if (existingItem?.option1_name || variants.some((variant) => variant.option1_value)) {
    payload.option1_name = existingItem?.option1_name || "Size";
  }
  if (existingItem?.option2_name || variants.some((variant) => variant.option2_value)) {
    payload.option2_name = existingItem?.option2_name || "Option 2";
  }
  if (existingItem?.option3_name || variants.some((variant) => variant.option3_value)) {
    payload.option3_name = existingItem?.option3_name || "Option 3";
  }
  Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
  return payload;
}

function modifierPayload(group, existing) {
  const existingOptions = existing?.modifier_options || existing?.options || [];
  return {
    ...(existing?.id ? { id: existing.id } : {}),
    name: group.name,
    modifier_options: group.options.map((option) => {
      const current = findByName(existingOptions, "name", option.name);
      return {
        ...(current?.id ? { id: current.id } : {}),
        name: option.name,
        price: option.price,
      };
    }),
  };
}

function groupsForItem(item) {
  const names = [];
  for (const assignment of mapping.assignments || []) {
    const categoryMatches =
      !assignment.itemMatch?.category || norm(assignment.itemMatch.category) === norm(item.category);
    const nameMatches = !assignment.itemMatch?.name || norm(assignment.itemMatch.name) === norm(item.name);
    if (categoryMatches && nameMatches) names.push(...assignment.modifierGroups);
  }
  return names;
}

let categories = await listAll("categories", "categories");
const categoryByName = new Map(categories.map((category) => [norm(category.name), category]));

for (const category of mapping.categories) {
  const existing = categoryByName.get(norm(category.name));
  if (existing) {
    summary.categories.unchanged.push(category.name);
    continue;
  }
  const created = await request("/categories", {
    method: "POST",
    body: JSON.stringify({ name: category.name }),
  });
  categoryByName.set(norm(created.name), created);
  summary.categories.created.push(category.name);
}

let modifiers = await listAll("modifiers", "modifiers");
const modifierByName = new Map(modifiers.map((modifier) => [norm(modifier.name), modifier]));

for (const group of mapping.modifierGroups) {
  const existing = modifierByName.get(norm(group.name));
  const saved = await request("/modifiers", {
    method: "POST",
    body: JSON.stringify(modifierPayload(group, existing)),
  });
  modifierByName.set(norm(saved.name), saved);
  if (existing) summary.modifiers.updated.push(group.name);
  else summary.modifiers.created.push(group.name);
}

let items = await listAll("items", "items");
const itemByName = new Map(items.map((item) => [norm(item.item_name), item]));

for (const row of mapping.items) {
  const category = categoryByName.get(norm(row.category));
  if (!category) {
    summary.warnings.push(`Skipped ${row.name}: missing category ${row.category}`);
    continue;
  }

  const modifierIds = groupsForItem(row)
    .map((name) => modifierByName.get(norm(name))?.id)
    .filter(Boolean);
  const existing = itemByName.get(norm(row.name));
  const saved = await request("/items", {
    method: "POST",
    body: JSON.stringify(itemPayload(row, category.id, modifierIds, existing)),
  });
  itemByName.set(norm(saved.item_name), saved);
  if (existing) summary.items.updated.push(row.name);
  else summary.items.created.push(row.name);
  if (modifierIds.length) {
    summary.assignments.push({ item: row.name, modifiers: groupsForItem(row) });
  }
}

const finalItems = await listAll("items", "items");
const finalCategories = await listAll("categories", "categories");
const finalModifiers = await listAll("modifiers", "modifiers");

const relevantItems = finalItems
  .filter((item) => mapping.items.some((row) => norm(row.name) === norm(item.item_name)))
  .map((item) => ({
    name: item.item_name,
    category_id: item.category_id,
    description: item.description,
    modifiers: item.modifiers_ids || item.modifier_ids || [],
    variants: (item.variants || []).map((variant) => ({
      sku: variant.sku,
      cost: variant.cost,
      price: variant.default_price,
      store_price: variant.stores?.[0]?.price,
      available: variant.stores?.[0]?.available_for_sale,
    })),
  }));

await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile("artifacts/loyverse-update-summary.json", JSON.stringify(summary, null, 2));
await fs.writeFile(
  "artifacts/loyverse-verify.json",
  JSON.stringify({ categories: finalCategories.length, modifiers: finalModifiers.length, items: relevantItems }, null, 2),
);

console.log(JSON.stringify(summary, null, 2));
