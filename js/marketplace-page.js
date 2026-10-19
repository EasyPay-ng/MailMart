import {
  auth, db, doc, onSnapshot, onAuthStateChanged,
  firestoreErrorHtml, firestoreErrorSummary
} from "./firebase.js";
import { installmentQuote } from "./installments.js";
import { STATES, lgasFor } from "./data/nigeria.js";
import { loadSettings, formatNaira } from "./wallet.js";
import { captureAffiliateVisit, rememberAffiliateCode, rememberMarketplaceReturn } from "./referrals.js";
import {
  CATEGORIES, watchActiveListings, placeOrder, quoteFor, hasDiscount,
  unitPriceOf, deliveryFeeFor
} from "./marketplace.js";
import { mountNotificationBell } from "./notifications.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICONS = {
  "Phones & Tablets": "📱", "Computers & Laptops": "💻", Electronics: "🎧",
  Fashion: "👟", "Beauty & Personal Care": "✨", "Home & Kitchen": "🏠",
  "Building Materials": "🧰", Groceries: "🛍️", "Baby Products": "🧸",
  "Sports & Outdoors": "⚽", Automobile: "🚘", Services: "⚡", Other: "✦"
};
const FAVORITES_KEY = "mailmart:favorites:v1";
const CART_KEY = "mailmart:cart:v1";
const HISTORY_KEY = "mailmart:recent:v1";

let currentUser = null;
let balance = 0;
let settings = null;
let listings = [];
let activeListing = null;
let activeGallery = [];
let affiliateCode = captureAffiliateVisit();
let activeCategory = "";
let wishlistOnly = false;
let favorites = loadArray(FAVORITES_KEY);
let cart = loadArray(CART_KEY);
let historyIds = loadArray(HISTORY_KEY);
let toastTimer;
const requestedItem = new URL(location.href).searchParams.get("item");
let requestedItemHandled = false;

function loadArray(key) {
  try { const parsed = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function storeArray(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private browsing */ }
}
function dateMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
function galleryFor(listing) {
  return [...new Set([listing?.image, ...(Array.isArray(listing?.gallery) ? listing.gallery : []), ...(Array.isArray(listing?.images) ? listing.images : [])].filter((url) => typeof url === "string" && url.length > 0))].slice(0, 5);
}
function variantsFor(listing) {
  const variants = Array.isArray(listing?.variants) ? listing.variants : [];
  return variants.map((variant) => typeof variant === "string" ? variant : (variant?.value || variant?.label || variant?.name || ""))
    .map((value) => String(value).trim()).filter(Boolean);
}
function stockFor(listing) {
  const stock = Number(listing?.stock ?? 1);
  return Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0;
}
function lowStockAt(listing) {
  const value = Number(listing?.lowStockThreshold ?? 3);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 3;
}
function promoExpires(listing, kind) {
  const promo = listing?.promotions || {};
  const values = kind === "featured"
    ? [listing?.featuredUntil, listing?.featuredExpiresAt, promo.featuredUntil, promo.featuredExpiresAt]
    : [listing?.hotDealUntil, listing?.hotDealsUntil, listing?.hotDealExpiresAt, promo.hotDealUntil, promo.hotDealsUntil];
  return values.some((value) => dateMillis(value) > Date.now());
}
function activePromoted(listing) { return promoExpires(listing, "featured"); }

onAuthStateChanged(auth, (user) => {
  if (!user) {
    rememberMarketplaceReturn();
    location.href = "login.html";
    return;
  }
  currentUser = user;
  boot();
  mountNotificationBell(user, { isAdmin: false });
});

async function boot() {
  onSnapshot(doc(db, "users", currentUser.uid), (snapshot) => {
    balance = Number((snapshot.exists() ? snapshot.data() : {}).balance || 0);
    const wallet = $("walletValue");
    if (wallet) wallet.textContent = formatNaira(balance);
  }, (error) => console.warn("Wallet preview unavailable", error));

  settings = await loadSettings().catch(() => null);
  renderSocialLinks(settings || {});
  if (!settings) {
    $("setupNotice").innerHTML = '<div class="market-notice info">Marketplace fees are being configured. The checkout will show your exact total before you place an order.</div>';
  }
  buildCategories();
  bindPage();
  refreshCounts();
  renderCart();

  watchActiveListings((rows) => {
    listings = rows;
    renderAll();
    if (requestedItem && !requestedItemHandled) {
      requestedItemHandled = true;
      const linked = listings.find((item) => item.id === requestedItem);
      if (linked) openListing(linked);
      else showToast("That product is no longer available. Browse other items below.");
    }
  }, (error) => {
    console.error("Could not load marketplace listings:", error);
    const message = firestoreErrorHtml(error, "marketplace products");
    ["dealGrid", "featuredGrid", "trendingGrid", "productGrid"].forEach((id) => {
      $(id).innerHTML = `<div class="empty-store"><strong>We couldn’t load products</strong><p>${message}</p></div>`;
    });
  });
  $("loadingScreen").style.display = "none";
  $("app").hidden = false;
}

function renderSocialLinks(config) {
  const entries = [["WhatsApp", config.whatsAppUrl], ["Telegram", config.telegramUrl], ["YouTube", config.youTubeUrl], ["X", config.xUrl]]
    .filter(([, value]) => {
      try { return new URL(value).protocol === "https:"; } catch { return false; }
    });
  const container = $("marketSocialLinks");
  container.hidden = !entries.length;
  container.innerHTML = entries.map(([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`).join("");
}

function buildCategories() {
  const categories = ["All products", ...CATEGORIES];
  $("categoryRow").innerHTML = categories.map((category) => {
    const value = category === "All products" ? "" : category;
    return `<button class="category-chip${activeCategory === value ? " active" : ""}" type="button" data-category="${esc(value)}"><span class="emoji">${category === "All products" ? "✨" : (ICONS[category] || "✦")}</span>${esc(category)}</button>`;
  }).join("") + '<a class="category-chip" href="services.html"><span class="emoji">⚡</span>VTU & digital services</a>';
}

function bindPage() {
  $("search").addEventListener("input", renderCatalog);
  $("sortBy").addEventListener("change", renderCatalog);
  $("filterFocus").addEventListener("click", () => $("categoryRow").scrollIntoView({ behavior: "smooth", block: "center" }));
  $("categoryRow").addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    activeCategory = button.dataset.category;
    wishlistOnly = false;
    buildCategories();
    renderCatalog();
    $("productsSection").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("productGrid").addEventListener("click", (event) => onProductGridClick(event));
  ["dealGrid", "featuredGrid", "trendingGrid", "wishlistGrid", "historyGrid"].forEach((id) => $(id).addEventListener("click", onProductGridClick));
  $("viewAllDeals").addEventListener("click", () => { activeCategory = ""; wishlistOnly = false; buildCategories(); renderCatalog(); $("productsSection").scrollIntoView({ behavior: "smooth" }); });
  $("trendSort").addEventListener("click", () => { $("sortBy").value = "popular"; renderCatalog(); $("productsSection").scrollIntoView({ behavior: "smooth" }); });
  $("trendingQuick").addEventListener("click", () => $("trendingSection").scrollIntoView({ behavior: "smooth" }));
  $("wishlistQuick").addEventListener("click", openWishlist);
  $("wishlistHeader").addEventListener("click", openWishlist);
  $("bottomWishlist").addEventListener("click", openWishlist);
  $("closeWishlist").addEventListener("click", closeWishlist);
  $("closeHistory").addEventListener("click", () => { $("historySection").hidden = true; $("productsSection").scrollIntoView({ behavior: "smooth" }); });
  $("cartHeader").addEventListener("click", openCart);
  $("cartClose").addEventListener("click", closeCart);
  $("cartDrawer").addEventListener("click", (event) => { if (event.target === $("cartDrawer")) closeCart(); });
  $("cartList").addEventListener("click", onCartClick);
  $("productModal").addEventListener("click", (event) => { if (event.target === $("productModal")) closeListing(); });
  $("mClose").addEventListener("click", closeListing);
  $("mBuy").addEventListener("click", placeActiveOrder);
  $("mVariant").addEventListener("change", updateModalQuote);
  ["mQty", "mState", "mPaymentMode"].forEach((id) => $(id).addEventListener("input", updateModalQuote));
  $("mState").innerHTML = '<option value="">Select your state</option>' + STATES.map((state) => `<option value="${esc(state)}">${esc(state)}</option>`).join("");
  $("mState").addEventListener("change", () => {
    const state = $("mState").value;
    $("mLga").innerHTML = '<option value="">Select your area</option>' + lgasFor(state).map((lga) => `<option value="${esc(lga)}">${esc(lga)}</option>`).join("");
    updateModalQuote();
  });
  $("mMainImage").addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
  });
  $("mThumbs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-image-index]");
    if (button) selectGalleryImage(Number(button.dataset.imageIndex));
  });
  $("mShare").addEventListener("click", shareActiveListing);
  $("mAddCart").addEventListener("click", addActiveToCart);
}

function listMatches(listing) {
  const term = $("search").value.trim().toLocaleLowerCase();
  const categoryMatch = !activeCategory || listing.category === activeCategory;
  const searchMatch = !term || `${listing.title || ""} ${listing.description || ""} ${listing.category || ""}`.toLocaleLowerCase().includes(term);
  const favoriteMatch = !wishlistOnly || favorites.includes(listing.id);
  return categoryMatch && searchMatch && favoriteMatch;
}
function sortedListings(rows) {
  const sort = $("sortBy").value;
  return [...rows].sort((a, b) => {
    if (sort === "price-low") return unitPriceOf(a) - unitPriceOf(b);
    if (sort === "price-high") return unitPriceOf(b) - unitPriceOf(a);
    if (sort === "popular") return Number(b.soldCount || 0) - Number(a.soldCount || 0) || dateMillis(b.createdAt) - dateMillis(a.createdAt);
    return dateMillis(b.createdAt) - dateMillis(a.createdAt);
  });
}
function renderAll() {
  const inStock = listings.filter((item) => stockFor(item) > 0);
  const deals = inStock.filter((item) => hasDiscount(item) || promoExpires(item, "hotDeals"))
    .sort((a, b) => Number(promoExpires(b, "hotDeals")) - Number(promoExpires(a, "hotDeals")) || unitPriceOf(a) - unitPriceOf(b));
  const featured = inStock.filter(activePromoted).sort((a, b) => dateMillis(b.featuredUntil || b.featuredExpiresAt) - dateMillis(a.featuredUntil || a.featuredExpiresAt));
  const trending = [...inStock].sort((a, b) => Number(b.soldCount || 0) - Number(a.soldCount || 0) || dateMillis(b.createdAt) - dateMillis(a.createdAt)).slice(0, 4);
  const recent = historyIds.map((id) => listings.find((item) => item.id === id)).filter(Boolean).slice(0, 4);
  renderGrid("dealGrid", deals.slice(0, 4), "No deals are live just yet", "Check back soon—new seller offers are added regularly.");
  renderGrid("featuredGrid", featured.slice(0, 4), "Featured picks will appear here", "Products with an active 24-hour Featured placement will show in this space.");
  renderGrid("trendingGrid", trending, "Your marketplace is warming up", "Popular products will appear here as sales activity builds.");
  renderGrid("historyGrid", recent, "No recent views", "Products you open will be saved here on this device.");
  if (!recent.length) $("historySection").hidden = true;
  renderWishlist();
  renderCatalog();
}
function renderGrid(id, rows, title, copy) {
  const grid = $(id);
  grid.innerHTML = rows.length ? rows.map(productCard).join("") : `<div class="empty-store"><strong>${esc(title)}</strong><p>${esc(copy)}</p></div>`;
}
function productCard(listing) {
  const stock = stockFor(listing);
  const low = stock <= lowStockAt(listing);
  const discounted = hasDiscount(listing);
  const unit = unitPriceOf(listing);
  const original = Number(listing.price || 0);
  const saving = discounted && original > 0 ? Math.round((1 - unit / original) * 100) : 0;
  const gallery = galleryFor(listing);
  const image = gallery[0];
  const hot = promoExpires(listing, "hotDeals");
  const featured = activePromoted(listing);
  const badges = [
    hot || discounted ? `<span class="product-badge deal">${hot ? "HOT DEAL" : `−${saving}%`}</span>` : "",
    featured ? '<span class="product-badge featured">FEATURED · 24H</span>' : "",
    low && stock > 0 ? `<span class="product-badge low">ONLY ${stock} LEFT</span>` : ""
  ].filter(Boolean).join("");
  return `<article class="product-card" data-id="${esc(listing.id)}" tabindex="0" role="button" aria-label="View ${esc(listing.title || "product")}">
    <div class="product-media">${image ? `<img src="${esc(image)}" alt="${esc(listing.title || "Product")}" loading="lazy">` : `<div class="product-placeholder" aria-hidden="true">${ICONS[listing.category] || "✦"}</div>`}
      <div class="product-badges">${badges}</div>
      <button class="favorite-button${favorites.includes(listing.id) ? " saved" : ""}" data-action="favorite" data-id="${esc(listing.id)}" type="button" aria-label="${favorites.includes(listing.id) ? "Remove from" : "Add to"} wishlist">${favorites.includes(listing.id) ? "♥" : "♡"}</button>
    </div>
    <div class="product-info"><span class="product-category">${esc(listing.category || "Marketplace")}</span><strong class="product-name">${esc(listing.title || "Untitled product")}</strong>
      <div class="product-prices"><span class="product-price">${esc(formatNaira(unit))}</span>${discounted ? `<del class="product-old">${esc(formatNaira(original))}</del><span class="product-save">Save ${saving}%</span>` : ""}</div>
      <span class="product-stock${low ? " urgent" : ""}">${stock > 0 ? (low ? `Only ${stock} left — order soon` : `${stock} available`) : "Sold out"}${variantsFor(listing).length ? ` · ${variantsFor(listing).length} options` : ""}</span>
      <div class="product-actions"><button class="add-cart-button" data-action="cart" data-id="${esc(listing.id)}" type="button" ${stock < 1 ? "disabled" : ""}><span aria-hidden="true">🛒</span> Add to cart</button><button class="share-button" data-action="share" data-id="${esc(listing.id)}" type="button" aria-label="Share ${esc(listing.title || "product")}">↗</button></div>
    </div></article>`;
}
function onProductGridClick(event) {
  const action = event.target.closest("[data-action]");
  if (action) {
    const listing = listings.find((item) => item.id === action.dataset.id);
    if (!listing) return;
    if (action.dataset.action === "favorite") { toggleFavorite(listing.id); return; }
    if (action.dataset.action === "cart") { addToCart(listing); return; }
    if (action.dataset.action === "share") { shareListing(listing); return; }
  }
  const card = event.target.closest("[data-id]");
  if (!card) return;
  const listing = listings.find((item) => item.id === card.dataset.id);
  if (listing) openListing(listing);
}
function renderCatalog() {
  const rows = sortedListings(listings.filter((item) => stockFor(item) > 0 && listMatches(item)));
  $("resultCount").textContent = wishlistOnly ? `${rows.length} saved product${rows.length === 1 ? "" : "s"}` : `${rows.length} product${rows.length === 1 ? "" : "s"} available`;
  $("catalogTitle").textContent = wishlistOnly ? "Your wishlist" : activeCategory ? activeCategory : "Shop all products";
  $("catalogSubhead").textContent = wishlistOnly ? "Your saved products, in one place." : "Thoughtful finds from verified MailMart sellers.";
  renderGrid("productGrid", rows, wishlistOnly ? "Your wishlist is empty" : "No products match that search", wishlistOnly ? "Tap the heart on a product to save it here." : "Try another search or choose a different category.");
}
function renderWishlist() {
  const rows = favorites.map((id) => listings.find((item) => item.id === id)).filter((item) => item && stockFor(item) > 0).slice(0, 4);
  renderGrid("wishlistGrid", rows, "Your wishlist is empty", "Tap the heart on any product to keep it handy.");
  $("wishlistSection").hidden = !wishlistOnly && !rows.length;
}
function openWishlist() {
  wishlistOnly = true;
  activeCategory = "";
  buildCategories();
  renderWishlist(); renderCatalog();
  $("wishlistSection").hidden = false;
  $("wishlistSection").scrollIntoView({ behavior: "smooth", block: "start" });
}
function closeWishlist() {
  wishlistOnly = false;
  $("wishlistSection").hidden = true;
  renderCatalog();
  $("productsSection").scrollIntoView({ behavior: "smooth", block: "start" });
}
function toggleFavorite(id) {
  favorites = favorites.includes(id) ? favorites.filter((item) => item !== id) : [...favorites, id];
  storeArray(FAVORITES_KEY, favorites);
  refreshCounts(); renderAll();
  showToast(favorites.includes(id) ? "Saved to your wishlist" : "Removed from your wishlist");
}
function refreshCounts() {
  const favoriteCount = $("favCount");
  const bottomCount = $("bottomFavCount");
  if (favoriteCount) { favoriteCount.textContent = String(favorites.length); favoriteCount.hidden = favorites.length === 0; }
  if (bottomCount) { bottomCount.textContent = String(favorites.length); bottomCount.hidden = favorites.length === 0; }
  const cartCount = $("cartCount");
  if (cartCount) { cartCount.textContent = String(cart.length); cartCount.hidden = cart.length === 0; }
}
function rememberViewed(id) {
  historyIds = [id, ...historyIds.filter((item) => item !== id)].slice(0, 12);
  storeArray(HISTORY_KEY, historyIds);
}

function openListing(listing) {
  activeListing = listing;
  activeGallery = galleryFor(listing);
  rememberViewed(listing.id);
  renderAll();
  const stock = stockFor(listing);
  const unit = unitPriceOf(listing);
  $("mCategory").textContent = listing.category || "Marketplace";
  $("mTitle").textContent = listing.title || "Product details";
  $("mDescription").textContent = listing.description || "Product details provided by the seller.";
  $("mStock").textContent = stock <= lowStockAt(listing) ? `Only ${stock} left — order soon` : `${stock} available`;
  $("mStock").classList.toggle("low", stock <= lowStockAt(listing));
  const original = Number(listing.price || 0);
  $("mPrice").innerHTML = `<strong>${esc(formatNaira(unit))}</strong>${hasDiscount(listing) ? `<del>${esc(formatNaira(original))}</del>` : ""}`;
  const variants = variantsFor(listing);
  $("mVariantWrap").hidden = !variants.length;
  $("mVariant").innerHTML = variants.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
  $("mQty").value = "1";
  $("mState").value = "";
  $("mLga").innerHTML = '<option value="">Select your area</option>';
  $("mName").value = ""; $("mPhone").value = ""; $("mStreet").value = "";
  $("mPaymentMode").value = "full";
  const planCount = Number(listing.installmentCount || listing.installmentMonths || 12);
  const planUnit = listing.installmentUnit === "week" ? "week" : "month";
  const warehouseReady = !listing.warehouseRequired || listing.warehouseVerified === true;
  const canInstallment = listing.installmentEnabled === true && warehouseReady;
  $("mInstallmentOption").disabled = !canInstallment;
  $("mInstallmentOption").textContent = canInstallment ? `${planCount} ${planUnit}${planCount === 1 ? "" : "s"} · no interest` : "Installments unavailable";
  $("mPlanTerms").textContent = listing.warehouseRequired && !listing.warehouseVerified
    ? "The seller’s long-term plan is pending MailMart warehouse verification."
    : canInstallment ? `Seller offers ${planCount} ${planUnit}${planCount === 1 ? "" : "s"}. The item is dispatched after the full balance is paid.`
    : "Pay in full before dispatch.";
  $("mAffiliateCode").value = affiliateCode;
  $("mReviewConfirm").checked = false;
  $("mMsg").innerHTML = "";
  renderGallery();
  updateModalQuote();
  $("productModal").classList.add("open");
  $("productModal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function renderGallery() {
  const url = activeGallery[0];
  $("mMainImage").innerHTML = url ? `<img id="mImage" src="${esc(url)}" alt="${esc(activeListing?.title || "Product photo")}">` : `<div class="product-placeholder">${ICONS[activeListing?.category] || "✦"}</div>`;
  $("mThumbs").innerHTML = activeGallery.map((src, index) => `<button class="gallery-thumb${index === 0 ? " active" : ""}" type="button" data-image-index="${index}" aria-label="View product photo ${index + 1}"><img src="${esc(src)}" alt=""></button>`).join("");
}
function selectGalleryImage(index) {
  const source = activeGallery[index];
  if (!source) return;
  const image = $("mMainImage").querySelector("img");
  if (image) image.src = source;
  $("mThumbs").querySelectorAll(".gallery-thumb").forEach((button, current) => button.classList.toggle("active", current === index));
}
function closeListing() {
  $("productModal").classList.remove("open");
  $("productModal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  activeListing = null;
}
function selectedVariant() { return $("mVariantWrap").hidden ? "" : $("mVariant").value; }
function updateModalQuote() {
  if (!activeListing) return;
  const qty = Math.max(1, Math.floor(Number($("mQty").value) || 1));
  const state = $("mState").value;
  const quote = quoteFor(activeListing, qty, state, settings);
  const planCount = Number(activeListing.installmentCount || activeListing.installmentMonths || 12);
  const planUnit = activeListing.installmentUnit === "week" ? "week" : "month";
  const plan = $("mPaymentMode").value === "installment" ? installmentQuote(quote.total, planCount, planUnit) : null;
  const stock = stockFor(activeListing);
  if (qty > stock) {
    $("mMsg").innerHTML = `<div class="market-notice bad">Only ${stock} item${stock === 1 ? "" : "s"} currently available.</div>`;
    $("mBuy").disabled = true;
  } else {
    if ($("mMsg").querySelector(".market-notice.bad")?.textContent.startsWith("Only")) $("mMsg").innerHTML = "";
    $("mBuy").disabled = stock < 1;
  }
  const type = activeListing.installmentUnit === "week" ? "week" : "month";
  $("mBreakdown").innerHTML = `<div class="line"><span>${esc(activeListing.title || "Product")} × ${qty}${selectedVariant() ? ` · ${esc(selectedVariant())}` : ""}</span><b>${esc(formatNaira(quote.subtotal))}</b></div>
    <div class="line"><span>Delivery${state ? ` to ${esc(state)}` : ""}</span><b>${esc(formatNaira(quote.deliveryFee))}</b></div>
    <div class="line"><span>Buyer purchase fee</span><b>${esc(formatNaira(quote.serviceFee))}</b></div>
    <div class="line total"><span>Total${plan ? ` · ${planCount} ${type}${planCount === 1 ? "" : "s"}` : ""}</span><b>${esc(formatNaira(quote.total))}</b></div>
    ${plan ? `<div class="line"><span>First payment due now</span><b>${esc(formatNaira(plan.first))}</b></div>` : ""}`;
  if (plan) $("mPlanTerms").textContent = `${planCount} equal ${type}ly payments at 0% interest. The item is dispatched after the full balance is paid.`;
}

async function placeActiveOrder() {
  if (!activeListing) return;
  const name = $("mName").value.trim();
  const phone = $("mPhone").value.trim();
  const state = $("mState").value;
  const lga = $("mLga").value;
  const street = $("mStreet").value.trim();
  const qty = Math.max(1, Math.floor(Number($("mQty").value) || 1));
  if (!name) return modalError("Enter the recipient’s name.");
  if (!phone) return modalError("Enter a phone number for delivery updates.");
  if (!state || !lga || !street) return modalError("Complete the delivery address before ordering.");
  if (!$("mReviewConfirm").checked) return modalError("Confirm that you reviewed the product and order terms.");

  const button = $("mBuy");
  button.disabled = true; button.textContent = "Refreshing fees…";
  try {
    const previousQuote = quoteFor(activeListing, qty, state, settings);
    const previousAffiliateRate = activeListing.affiliateRatePercent ?? settings?.affiliateRatesByCategory?.[activeListing.category] ?? 5;
    settings = await loadSettings();
    const quote = quoteFor(activeListing, qty, state, settings);
    const currentAffiliateRate = activeListing.affiliateRatePercent ?? settings?.affiliateRatesByCategory?.[activeListing.category] ?? 5;
    updateModalQuote();
    if (quote.total !== previousQuote.total || quote.serviceFee !== previousQuote.serviceFee
        || quote.sellerSaleFeePercent !== previousQuote.sellerSaleFeePercent
        || currentAffiliateRate !== previousAffiliateRate) {
      $("mReviewConfirm").checked = false;
      modalError("Marketplace fees or affiliate terms changed. Review the updated order total and confirm again before placing it.");
      return;
    }
    const planCount = Number(activeListing.installmentCount || activeListing.installmentMonths || 12);
    const dueNow = $("mPaymentMode").value === "installment"
      ? installmentQuote(quote.total, planCount, activeListing.installmentUnit === "week" ? "week" : "month").first
      : quote.total;
    if (dueNow > balance) { modalError(`You need ${formatNaira(dueNow)} in your wallet. Your available balance is ${formatNaira(balance)}.`); return; }
    if (qty > stockFor(activeListing)) { modalError(`Only ${stockFor(activeListing)} item${stockFor(activeListing) === 1 ? "" : "s"} currently available.`); return; }

    button.textContent = "Placing order…";
    await placeOrder({
      listing: activeListing, quantity: qty,
      address: { name, phone, state, lga, street }, settings,
      affiliateCode: $("mAffiliateCode").value.trim(),
      paymentMode: $("mPaymentMode").value,
      selectedVariant: selectedVariant()
    });
    affiliateCode = $("mAffiliateCode").value.trim();
    rememberAffiliateCode(affiliateCode);
    $("mMsg").innerHTML = '<div class="market-notice good">Order placed. The seller has been notified. Track the payment and delivery from Order history.</div>';
    setTimeout(closeListing, 1300);
  } catch (error) {
    console.error(error);
    modalError(error.code ? firestoreErrorSummary(error, "your order") : error.message);
  } finally { button.disabled = false; button.textContent = "Place order"; }
}
function modalError(message) { $("mMsg").innerHTML = `<div class="market-notice bad">${esc(message)}</div>`; }

function addToCart(listing, variant = "") {
  const existing = cart.find((row) => row.id === listing.id && row.variant === variant);
  if (existing) existing.quantity = Math.min(stockFor(listing), Number(existing.quantity || 1) + 1);
  else cart.push({ id: listing.id, variant, quantity: 1 });
  cart = cart.filter((row) => listings.some((item) => item.id === row.id && stockFor(item) > 0));
  storeArray(CART_KEY, cart); refreshCounts(); renderCart(); showToast("Added to your cart");
}
function addActiveToCart() { if (activeListing) addToCart(activeListing, selectedVariant()); }
function renderCart() {
  if (!$("cartList")) return;
  const rows = cart.map((row) => ({ ...row, listing: listings.find((item) => item.id === row.id) })).filter((row) => row.listing);
  if (!rows.length) {
    $("cartList").innerHTML = '<div class="empty-store" style="margin-top:18px"><strong>Your cart is empty</strong><p>Add products you like, then open each one to place its order.</p></div>';
    return;
  }
  $("cartList").innerHTML = '<p class="field-tip" style="margin:12px 0;color:#7789a1;font-size:10px;line-height:1.6">Each product is ordered separately so its delivery and payment terms stay clear.</p>' + rows.map((row) => `<article class="cart-row"><img src="${esc(galleryFor(row.listing)[0] || "")}" alt=""><div><strong>${esc(row.listing.title || "Product")}</strong><small>${esc(formatNaira(unitPriceOf(row.listing)))} · Qty ${Number(row.quantity || 1)}${row.variant ? ` · ${esc(row.variant)}` : ""}</small></div><button type="button" data-cart-remove="${esc(row.id)}" data-cart-variant="${esc(row.variant)}" aria-label="Remove ${esc(row.listing.title)}">×</button><button class="cart-continue" type="button" data-cart-open="${esc(row.id)}" data-cart-variant="${esc(row.variant)}">Review & order →</button></article>`).join("");
}
function openCart() { renderCart(); $("cartDrawer").classList.add("open"); $("cartDrawer").setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; }
function closeCart() { $("cartDrawer").classList.remove("open"); $("cartDrawer").setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; }
function onCartClick(event) {
  const remove = event.target.closest("[data-cart-remove]");
  const open = event.target.closest("[data-cart-open]");
  if (remove) {
    cart = cart.filter((row) => !(row.id === remove.dataset.cartRemove && row.variant === remove.dataset.cartVariant));
    storeArray(CART_KEY, cart); refreshCounts(); renderCart(); return;
  }
  if (open) {
    const listing = listings.find((item) => item.id === open.dataset.cartOpen);
    if (!listing) return;
    closeCart(); openListing(listing);
    if (open.dataset.cartVariant && variantsFor(listing).includes(open.dataset.cartVariant)) $("mVariant").value = open.dataset.cartVariant;
    updateModalQuote();
  }
}
function shareListing(listing) {
  const url = new URL("marketplace.html", location.href);
  url.searchParams.set("item", listing.id);
  const title = listing.title || "Product on MailMart";
  if (navigator.share) navigator.share({ title, text: `Take a look at ${title} on MailMart.`, url: url.toString() }).catch(() => {});
  else navigator.clipboard?.writeText(url.toString()).then(() => showToast("Product link copied")).catch(() => showToast(url.toString()));
}
function shareActiveListing() { if (activeListing) shareListing(activeListing); }
function showToast(message) {
  const element = $("toast");
  if (!element) return;
  element.textContent = message; element.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove("show"), 2300);
}

