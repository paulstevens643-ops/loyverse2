import fs from "node:fs/promises";

const token = process.env.LOYVERSE_TOKEN;
if (!token) {
  throw new Error("Missing LOYVERSE_TOKEN secret.");
}

const apiBase = "https://api.loyverse.com/v1.0";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

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
  if (!response.ok) {
    throw new Error(`Loyverse ${response.status} ${path}: ${text}`);
  }
  await sleep(120);
  return text ? JSON.parse(text) : null;
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

const categories = await listAll("categories", "categories");
const burgerCategory = categories.find((category) => norm(category.name) === "gourmet burgers");
if (!burgerCategory) {
  throw new Error("Could not find Gourmet Burgers category.");
}

const items = await listAll("items", "items");
const burgers = items
  .filter((item) => item.category_id === burgerCategory.id)
  .sort((a, b) => a.item_name.localeCompare(b.item_name));

const report = burgers.map((item) => ({
  id: item.id,
  name: item.item_name,
  description: item.description || null,
  variants: (item.variants || []).map((variant) => ({
    id: variant.variant_id,
    label: variantLabel(variant),
    cost: variant.cost ?? null,
    price: variant.default_price ?? null,
    store_price: variant.stores?.[0]?.price ?? null,
    available: variant.stores?.[0]?.available_for_sale ?? null,
  })),
}));

const duplicateNames = Object.entries(
  report.reduce((acc, item) => {
    const key = norm(item.name);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}),
)
  .filter(([, count]) => count > 1)
  .map(([name, count]) => ({ name, count }));

await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile("artifacts/burger-verification.json", JSON.stringify({ count: report.length, duplicateNames, burgers: report }, null, 2));

console.log(JSON.stringify({ count: report.length, duplicateNames, burgers: report }, null, 2));
