import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
async function files(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename));
    else result.push(filename);
  }
  return result;
}

test("all browser modules and inline module scripts parse, and relative imports exist", async () => {
  for (const filename of await files(root)) {
    if (!/\.(js|html)$/.test(filename)) continue;
    const text = await fs.readFile(filename, "utf8");
    const scripts = filename.endsWith(".js") ? [text] :
      [...text.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    for (const script of scripts) {
      assert.doesNotThrow(() => new vm.SourceTextModule(script), filename);
      for (const match of script.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
        await fs.access(path.resolve(path.dirname(filename), match[1]));
      }
    }
  }
});

test("new page scripts have real DOM targets and local entry points", async () => {
  for (const basename of ["referrals", "admin-referrals", "services", "admin-services"]) {
    const html = await fs.readFile(path.join(root, basename + ".html"), "utf8");
    const js = await fs.readFile(path.join(root, "js", basename + "-page.js"), "utf8");
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const match of js.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(match[1]), basename + ": " + match[1]);
    for (const match of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
      if (/^(?:https?:|data:)/.test(match[1])) continue;
      await fs.access(path.join(root, match[1].split(/[?#]/)[0]));
    }
  }
});

test("new referral query has a deployable composite index and frontend has entry points", async () => {
  const indexes = JSON.parse(await fs.readFile(path.join(root, "firestore.indexes.json"), "utf8")).indexes;
  assert.ok(indexes.some((index) => index.collectionGroup === "referrals" &&
    index.fields.map((field) => field.fieldPath).join(",") === "referrerUid,joinedAt"));
  assert.match(await fs.readFile(path.join(root, "dashboard.html"), "utf8"), /href="referrals.html"/);
  assert.match(await fs.readFile(path.join(root, "admin.html"), "utf8"), /href="admin-referrals.html"/);
});

test("all private service and claim queries have deployable indexes and service navigation exists", async () => {
  const indexes = JSON.parse(await fs.readFile(path.join(root, "firestore.indexes.json"), "utf8"));
  for (const group of ["referralClaims", "socialRequests", "rentals"]) assert.ok(indexes.indexes.some((i) => i.collectionGroup === group && i.fields.map((f) => f.fieldPath).join(",") === "uid,createdAt"), group);
  assert.ok(indexes.fieldOverrides.some((field) => field.collectionGroup === "rentalCodes" && field.fieldPath === "code" && field.indexes.length === 0));
  assert.match(await fs.readFile(path.join(root, "dashboard.html"), "utf8"), /href="services.html"/);
  assert.match(await fs.readFile(path.join(root, "admin.html"), "utf8"), /href="admin-services.html"/);
});

test("rules keep all legacy/new collection boundaries and balanced delimiters (not a rules compiler)", async () => {
  const text = await fs.readFile(path.join(root, "firestore.rules"), "utf8");
  for (const collection of ["users", "sales", "presence", "settings", "transactions", "kyc", "listings", "orders", "mail", "referrals", "referralCodes", "affiliateApplications", "referralClaims", "referralAudit", "socialOffers", "socialRequests", "rentalCategories", "rentals", "rentalInboxes", "rentalCodes"]) assert.match(text, new RegExp("match /" + collection + "/"), collection);
  const stripped = text.replace(/'[^'\\]*(?:\\.[^'\\]*)*'|\"[^\"\\]*(?:\\.[^\"\\]*)*\"|\/\/[^\n]*/g, "");
  const stack = [], pair = { ")": "(", "]": "[", "}": "{" };
  for (const c of stripped) {
    if ("([{".includes(c)) stack.push(c);
    else if (")]}".includes(c)) assert.equal(stack.pop(), pair[c]);
  }
  assert.equal(stack.length, 0);
});
