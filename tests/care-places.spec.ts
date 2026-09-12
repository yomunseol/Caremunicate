import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Care Places — end-to-end flow.
//
// Auth: the favorites-persistence assertion below deliberately talks to the real
// Supabase project (that is what proves RLS), so this suite needs a real test
// account:
//
//   E2E_EMAIL / E2E_PASSWORD   — credentials for a confirmed user WITHOUT 2FA
//   E2E_BASE_URL               — optional, defaults to http://localhost:5173
//   E2E_STORAGE_STATE          — optional, a saved storageState to skip UI login
//
// Prerequisite in Supabase: place_favorites(user_id, place_id, …) with a unique
// constraint on (user_id, place_id) and RLS letting a user read/write their own
// rows. Nominatim + geolocation are mocked, so no real map traffic is made.
// ---------------------------------------------------------------------------

const EMAIL = process.env.E2E_EMAIL ?? '';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const STORAGE_STATE = process.env.E2E_STORAGE_STATE;

// Paris — used to assert the viewbox bias.
const PARIS = { latitude: 48.8566, longitude: 2.3522 };

const NOMINATIM = /nominatim\.openstreetmap\.org\/search/;

const FIXTURE = [
  {
    place_id: 1,
    osm_id: 900001,
    lat: '44.0225',
    lon: '-92.4665',
    display_name:
      'Mayo Clinic, 200, 1st Street SW, Rochester, Olmsted County, Minnesota, United States',
    type: 'hospital',
  },
  {
    place_id: 2,
    osm_id: 900002,
    lat: '44.0230',
    lon: '-92.4670',
    display_name: 'Mayo Clinic Hospital, Rochester, Minnesota, United States',
    type: 'clinic',
  },
];

// Every Nominatim URL the page requested, so tests can inspect query params.
let nominatimCalls: string[] = [];

test.use({
  ...(STORAGE_STATE ? { storageState: STORAGE_STATE } : {}),
});

/** Mocks Nominatim and records each request URL. */
async function mockNominatim(page: Page) {
  await page.route(NOMINATIM, async (route) => {
    nominatimCalls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE),
    });
  });
}

/** Signs in through the real login form and lands on the dashboard. */
async function signIn(page: Page) {
  await page.goto('/#login');

  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // A code screen means the test account has 2FA, which this suite can't drive.
  if (await page.getByLabel('Authenticator code').isVisible()) {
    throw new Error(
      'The E2E test account has 2FA enabled. Use a 2FA-free account or pass E2E_STORAGE_STATE.',
    );
  }

  await expect(page).toHaveURL(/#profile/, { timeout: 20_000 });
  await expect(page.locator('#care-places-heading')).toBeVisible();
}

/** Types a query and resolves once the (debounced) Nominatim request fires. */
async function search(page: Page, value: string) {
  const input = page.getByLabel('Search care places');
  const request = page.waitForRequest(
    (req) => NOMINATIM.test(req.url()) && new URL(req.url()).searchParams.get('q') === value,
    { timeout: 15_000 },
  );
  await input.fill(value);
  await request;
}

test.beforeEach(async ({ page }) => {
  test.skip(
    !STORAGE_STATE && (!EMAIL || !PASSWORD),
    'Set E2E_EMAIL and E2E_PASSWORD (and/or E2E_STORAGE_STATE) to run this suite.',
  );

  nominatimCalls = [];
  await mockNominatim(page);

  if (!STORAGE_STATE) {
    await signIn(page);
  } else {
    await page.goto('/#profile');
    await expect(page.locator('#care-places-heading')).toBeVisible();
  }
});

test.describe('Care Places', () => {
  test('global search returns results for "Mayo Clinic"', async ({ page }) => {
    await search(page, 'Mayo Clinic');

    // First card name is the display_name before the first comma.
    await expect(page.getByText('Mayo Clinic', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Mayo Clinic Hospital', { exact: true })).toBeVisible();

    // Global search: no country filter, and accept-language uses the locale.
    const url = new URL(nominatimCalls.at(-1)!);
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('limit')).toBe('8');
    expect(url.searchParams.get('accept-language')).toMatch(/^\w+,en$/);
    expect(url.searchParams.has('countrycodes')).toBe(false);
    expect(url.searchParams.has('viewbox')).toBe(false);
  });

  test('a starred place stays starred after a reload (Supabase RLS)', async ({ page }) => {
    await search(page, 'Mayo Clinic');

    const saveStar = page.getByRole('button', { name: 'Save Mayo Clinic', exact: true }).first();
    await expect(saveStar).toHaveAttribute('aria-pressed', 'false');
    await saveStar.click();

    // The star flips once the upsert round-trips through Supabase.
    await expect(
      page.getByRole('button', { name: 'Remove Mayo Clinic from saved places', exact: true }).first(),
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

    await page.reload();
    await expect(page.locator('#care-places-heading')).toBeVisible();

    // Favorites reload on mount, scoped to the signed-in user — a filled star
    // after reload proves the row was written and is readable under RLS.
    await expect(
      page.getByRole('button', { name: 'Remove Mayo Clinic from saved places', exact: true }).first(),
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  });

  test('switching to Arabic mirrors the layout (dir="rtl")', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('option', { name: 'العربية' }).click();

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('button', { name: 'Language' })).toContainText('العربية');

    // The search input now runs right-to-left; text-align:start resolves right.
    const input = page.getByLabel('Search care places');
    const alignment = await input.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { direction: computed.direction, textAlign: computed.textAlign };
    });
    expect(alignment.direction).toBe('rtl');
    expect(['start', 'right']).toContain(alignment.textAlign);

    // Direction survives a reload (persisted alongside the locale).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});

test.describe('Care Places — geolocation bias', () => {
  test.use({ geolocation: PARIS, permissions: ['geolocation'] });

  test('"Near me" adds a viewbox around the current coordinates', async ({ page }) => {
    await search(page, 'Mayo Clinic');
    expect(nominatimCalls.some((u) => new URL(u).searchParams.has('viewbox'))).toBe(false);

    await page.getByRole('button', { name: /near me/i }).click();
    await expect(page.getByText('Using your location')).toBeVisible();

    // Toggling re-runs the active query, now with a location bias.
    await expect
      .poll(
        () => nominatimCalls.filter((u) => new URL(u).searchParams.has('viewbox')).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    const biased = nominatimCalls.find((u) => new URL(u).searchParams.has('viewbox'))!;
    const viewbox = new URL(biased).searchParams.get('viewbox')!;
    const [west, north, east, south] = viewbox.split(',').map(Number);

    expect(west).toBeCloseTo(PARIS.longitude - 0.5, 3);
    expect(north).toBeCloseTo(PARIS.latitude + 0.25, 3);
    expect(east).toBeCloseTo(PARIS.longitude + 0.5, 3);
    expect(south).toBeCloseTo(PARIS.latitude - 0.25, 3);

    // Still a bias, not a restriction.
    expect(new URL(biased).searchParams.has('countrycodes')).toBe(false);
  });
});
