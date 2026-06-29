/**
 * Single source of truth for products.
 * Change a price or a Drive link here — everything else (webhook checks,
 * token minting, the front-end's displayed price) should be kept in sync
 * with this file by hand, but the *security* checks (amount/currency
 * matching) all read from here automatically.
 */

const BOOK_FILE = {
  id: 'book',
  filename: 'Vibe-and-Launch-Book.pdf',
  driveUrl: 'https://drive.google.com/uc?export=download&id=1R3Y_y0VYz7lF6-sByOlADA0vVf_AvIYg'
};

const WORKBOOK_FILE = {
  id: 'workbook',
  filename: 'Vibe-and-Launch-Workbook.pdf',
  driveUrl: 'https://drive.google.com/uc?export=download&id=1_T9BxhBeRS8gvTeKprhDqjBLMFiloYmy'
};

const QUIZ_FILE = {
  id: 'quiz',
  filename: 'Vibe-and-Launch-Quiz.pdf',
  driveUrl: 'https://drive.google.com/uc?export=download&id=1jMktyDtysAieU_CkOXCNUi3yXSBqb5CV'
};

const PRODUCTS = {
  book: {
    label: 'The Book',
    amountNaira: 2500,
    refPrefix: 'VL-ebook-',
    files: [BOOK_FILE]
  },
  workbook: {
    label: 'The Workbook',
    amountNaira: 2500,
    refPrefix: 'VL-workbook-',
    files: [WORKBOOK_FILE]
  },
  quiz: {
    label: 'The Quiz',
    amountNaira: 2000,
    refPrefix: 'VL-quiz-',
    files: [QUIZ_FILE]
  },
  fullbundle: {
    label: 'Full Bundle',
    refPrefix: 'VL-fullbundle-',
    files: [BOOK_FILE, WORKBOOK_FILE, QUIZ_FILE],
    // Tiered, multi-currency pricing — ONLY the bundle uses this shape.
    // The first `introLimit` confirmed bundle purchases get `intro`;
    // every purchase after that gets `regular`. Nothing else in this file
    // (or any other product) is affected by this.
    introLimit: 20,
    pricing: {
      NGN: { intro: 5000, regular: 6000 },
      USD: { intro: 3.99, regular: 4.99 }
    }
  }
};

/**
 * Convert a major-unit price (naira, dollars) to the minor unit Paystack
 * actually charges in (kobo, cents). Rounded to avoid float artifacts
 * like 3.99 * 100 = 398.99999999999994.
 */
function toMinorUnits(amountMajor) {
  return Math.round(amountMajor * 100);
}

/**
 * What should the Full Bundle cost right now, in the given currency,
 * given how many confirmed bundle purchases have happened so far?
 */
function getBundlePricing(currency, purchaseCount) {
  const pricing = PRODUCTS.fullbundle.pricing[currency];
  if (!pricing) return null;

  const tier = purchaseCount < PRODUCTS.fullbundle.introLimit ? 'intro' : 'regular';
  const amountMajor = pricing[tier];
  const introSpotsLeft = Math.max(0, PRODUCTS.fullbundle.introLimit - purchaseCount);

  return {
    currency,
    tier,
    amountMajor,
    amountMinor: toMinorUnits(amountMajor),
    introSpotsLeft
  };
}

/**
 * Does this amount/currency match what a buyer SHOULD have paid for this
 * plan? For the bundle, either tier's price counts as valid — the price
 * may have ticked over between when the buyer opened checkout and when
 * the webhook arrives, and we never want to reject a real payment over
 * that timing gap. For every other product, the price is fixed and NGN-only.
 */
function validatePaymentAmount(plan, amountMinor, currency) {
  const product = PRODUCTS[plan];
  if (!product) return false;

  if (plan === 'fullbundle') {
    const pricing = product.pricing[currency];
    if (!pricing) return false;
    const introMinor = toMinorUnits(pricing.intro);
    const regularMinor = toMinorUnits(pricing.regular);
    return amountMinor === introMinor || amountMinor === regularMinor;
  }

  return currency === 'NGN' && amountMinor === product.amountNaira * 100;
}

/**
 * Identify which product was purchased from the Paystack reference prefix.
 * Sorted longest-prefix-first so e.g. "VL-ebook-" can never accidentally
 * match before a more specific prefix would.
 */
function planFromReference(reference) {
  if (!reference || typeof reference !== 'string') return null;
  const entries = Object.entries(PRODUCTS).sort(
    (a, b) => b[1].refPrefix.length - a[1].refPrefix.length
  );
  for (const [slug, product] of entries) {
    if (reference.startsWith(product.refPrefix)) return slug;
  }
  return null;
}

module.exports = { PRODUCTS, planFromReference, getBundlePricing, validatePaymentAmount };
