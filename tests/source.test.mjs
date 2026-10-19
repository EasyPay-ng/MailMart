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
  for (const collection of ["users", "sales", "presence", "settings", "transactions", "kyc", "listings", "orders", "mail", "referrals", "referralCodes", "affiliateApplications", "referralClaims", "referralAudit", "pushSubscriptions", "socialOffers", "socialRequests", "rentalCategories", "rentals", "rentalInboxes", "rentalCodes"]) assert.match(text, new RegExp("match /" + collection + "/"), collection);
  assert.doesNotMatch(text, /[A-Za-z0-9_]\$\(/, "Build dynamic document IDs first, then interpolate them as a full Firestore path segment.");
  const stripped = text.replace(/'[^'\\]*(?:\\.[^'\\]*)*'|\"[^\"\\]*(?:\\.[^\"\\]*)*\"|\/\/[^\n]*/g, "");
  const stack = [], pair = { ")": "(", "]": "[", "}": "{" };
  for (const c of stripped) {
    if ("([{".includes(c)) stack.push(c);
    else if (")]}".includes(c)) assert.equal(stack.pop(), pair[c]);
  }
  assert.equal(stack.length, 0);
});

test("notification surfaces are wired together (bell, admin policy, phone alerts, sender)", async () => {
  const admin = await fs.readFile(path.join(root, "admin.html"), "utf8");
  assert.match(admin, /href="admin-notifications\.html"/);
  assert.match(admin, /mountNotificationBell\(user,\{isAdmin:true\}\)/);

  for (const page of ["dashboard.html", "orders.html", "wallet.html", "sell.html"]) {
    assert.match(await fs.readFile(path.join(root, page), "utf8"), /mountNotificationBell/, page);
  }
  // The storefront keeps its logic in a module, not inline.
  assert.match(await fs.readFile(path.join(root, "js/marketplace-page.js"), "utf8"), /mountNotificationBell/);

  const dashboard = await fs.readFile(path.join(root, "dashboard.html"), "utf8");
  assert.match(dashboard, /id="phone-alerts"/);
  assert.match(dashboard, /mountPhoneAlerts\(user/);

  const adminPage = await fs.readFile(path.join(root, "admin-notifications.html"), "utf8");
  for (const id of ["channelInApp", "channelBrowser", "channelSound", "channelPhone", "channelDigest",
    "audienceBuyer", "audienceSeller", "audienceAccount", "audienceAdmin"]) {
    assert.match(adminPage, new RegExp(`id="${id}"`), id);
  }

  const workflow = await fs.readFile(path.join(root, ".github/workflows/notify-cron.yml"), "utf8");
  assert.match(workflow, /scripts\/notify-worker\.mjs/);
  assert.match(workflow, /FIREBASE_SERVICE_ACCOUNT/);
  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);

  const sender = await fs.readFile(path.join(root, "scripts/notify-worker.mjs"), "utf8");
  assert.match(sender, /collectAlerts\(/);
  // One message per person: the sender must group before publishing.
  assert.match(sender, /buildDigest\(/);
  assert.match(sender, /channels\.digest/);
  assert.match(sender, /pending/);
  assert.match(sender, /pushSubscriptions/);
  assert.match(sender, /notifyLog/);

  const rules = await fs.readFile(path.join(root, "firestore.rules"), "utf8");
  assert.match(rules, /match \/pushSubscriptions\/\{userId\}/);
});
