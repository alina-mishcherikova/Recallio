// LEX-004 collection journeys (ADR 0003 §6.4). Runs on the desktop and mobile projects against the
// built server and the test database: create → rename → archive → unarchive → delete, a keyboard-only
// path, keyset "Load more", and small-screen checks. Fails on any CSP console message.
//
// Each test registers its own user (and sends its own client IP, like auth.spec.ts), so tests never
// share collections or rate-limit buckets.
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { E2E_ORIGIN, uniqueClientIpHeaders } from './env'

let ipHeaders: Record<string, string> = {}

test.beforeEach(async ({ page }) => {
  ipHeaders = uniqueClientIpHeaders()
  await page.setExtraHTTPHeaders(ipHeaders)
})

// The CSP is nonce-only for styles: an inline `style` attribute or an un-nonced <style> is a
// violation. Chromium logs every violation to the console, on every page the test visits.
const cspViolations = new WeakMap<Page, string[]>()

test.beforeEach(({ page }) => {
  const found: string[] = []
  cspViolations.set(page, found)
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) found.push(`${page.url()}: ${msg.text()}`)
  })
})

test.afterEach(({ page }) => {
  expect(cspViolations.get(page), 'CSP violations').toEqual([])
})

const LANGUAGES_SAME = 'Choose two different languages.'
const CONFIRM_MISMATCH = 'Type the collection title exactly to confirm.'

async function expectAccessible(page: Page, label: string) {
  // Let enter transitions (dialog fade-in, toasts) finish: axe measures colors as rendered.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  )
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(results.violations, `axe violations on ${label}`).toEqual([])
}

/** Registers a fresh user (native language English) and lands on /dashboard. */
async function signUp(page: Page, testInfo: TestInfo) {
  const id = `${testInfo.project.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await page.goto('/register')
  await page.getByLabel('Email', { exact: true }).fill(`e2e-col-${id}@example.test`)
  await page
    .getByLabel('Password', { exact: true })
    .fill(`quiet harbor lamp ${Math.random().toString(36).slice(2, 8)}`)
  await page.getByLabel('Native language').selectOption('en')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

/** Creates a collection through the API with the browser's session (same Origin check as the UI). */
async function createViaApi(page: Page, title: string) {
  const res = await page.request.post('/api/collections', {
    headers: { origin: E2E_ORIGIN, ...ipHeaders },
    data: { title, nativeLanguage: 'en', targetLanguage: 'fr' },
  })
  expect(res.status()).toBe(201)
  return (await res.json()) as { id: string; title: string }
}

/** Presses Tab until `target` has focus (fails if it isn't reachable within `max` presses). */
async function tabTo(page: Page, target: Locator, max = 40) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 })

test.describe('collection journey', () => {
  test('create → rename → archive → unarchive → delete', async ({ page }, testInfo) => {
    await signUp(page, testInfo)

    // Header and dashboard both lead to the collections.
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Collections' }),
    ).toHaveAttribute('href', '/collections')
    await page.getByRole('main').getByRole('link', { name: 'Your collections' }).click()
    await expect(page).toHaveURL(/\/collections$/)
    await expect(heading(page)).toHaveText('Collections')
    await expect(page.getByTestId('collections-empty')).toContainText("You don't have any collections yet.")
    await expect(page.getByRole('link', { name: 'Active' })).toHaveAttribute('aria-current', 'page')
    await expectAccessible(page, '/collections (empty)')

    // Create: the languages are pre-filled from the profile (English → French).
    await page.getByRole('main').getByRole('link', { name: 'New collection' }).click()
    await expect(page).toHaveURL(/\/collections\/new$/)
    const native = page.getByLabel('Your language')
    const target = page.getByLabel("Language you're learning")
    await expect(native).toHaveValue('en')
    await expect(target).toHaveValue('fr')
    await expectAccessible(page, '/collections/new')

    // The same language twice is refused, as text.
    await page.getByLabel('Title').fill('Travel words')
    await target.selectOption('en')
    await page.getByRole('button', { name: 'Create collection' }).click()
    const summary = page.getByTestId('form-error-summary')
    await expect(summary).toBeFocused()
    await expect(summary).toContainText(LANGUAGES_SAME)
    await expect(target).toHaveAttribute('aria-invalid', 'true')
    await expectAccessible(page, '/collections/new (errors)')

    await target.selectOption('fr')
    await page.getByLabel('Topic').fill('Holidays')
    await page.getByRole('button', { name: 'Create collection' }).click()
    await expect(page).toHaveURL(/\/collections\/[0-9a-f-]{36}$/)
    await expect(heading(page)).toHaveText('Travel words')
    await expect(heading(page)).toBeFocused()
    await expect(page.getByTestId('language-pair').first()).toContainText('English → French')
    await expect(page.getByTestId('collection-details')).toContainText('Holidays')
    const detailUrl = page.url()
    // The title never ends up in the URL.
    expect(detailUrl).not.toContain('Travel')
    await expectAccessible(page, '/collections/[id]')

    // Rename. No words yet, so the languages can still change.
    await page.getByRole('link', { name: 'Edit' }).click()
    await expect(page).toHaveURL(/\/edit$/)
    await expect(heading(page)).toHaveText('Edit collection')
    await expect(page.getByLabel('Your language')).toBeEnabled()
    await expectAccessible(page, '/collections/[id]/edit')
    await page.getByLabel('Title').fill('Travel phrases')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(detailUrl)
    await expect(heading(page)).toHaveText('Travel phrases')
    await expect(heading(page)).toBeFocused()

    // Archive: badge text, read-only (no Edit), focus stays on the toggle.
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    const unarchive = page.getByRole('button', { name: 'Unarchive', exact: true })
    await expect(unarchive).toBeVisible()
    await expect(page.getByTestId('archived-badge')).toHaveText('Archived')
    await expect(page.getByTestId('action-status')).toContainText('Collection archived.')
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0)
    await expectAccessible(page, '/collections/[id] (archived)')

    // It moved from Active to Archived.
    await page.getByRole('link', { name: 'All collections' }).click()
    await expect(page).toHaveURL(/\/collections$/)
    await expect(page.getByTestId('collections-empty')).toBeVisible()
    await page.getByRole('link', { name: 'Archived' }).click()
    await expect(page).toHaveURL(/\/collections\?status=archived$/)
    await expect(page.getByRole('link', { name: 'Archived' })).toHaveAttribute('aria-current', 'page')
    const card = page.getByTestId('collection-card').filter({ hasText: 'Travel phrases' })
    await expect(card).toContainText('Archived')
    await expect(card).toContainText('English → French')
    await expectAccessible(page, '/collections?status=archived')

    // An archived collection's edit page is read-only with an Unarchive action.
    await page.goto(`${detailUrl}/edit`)
    await expect(page.getByTestId('archived-notice')).toContainText('read-only')
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveCount(0)

    // Unarchive from the detail page.
    await page.goto(detailUrl)
    await page.getByRole('button', { name: 'Unarchive', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible()
    await expect(page.getByTestId('archived-badge')).toHaveCount(0)
    await expect(page.getByTestId('action-status')).toContainText('Collection unarchived.')

    // Delete: a wrong title is refused as text, the right one deletes.
    await page.getByRole('button', { name: 'Delete…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete this collection?' })
    await expect(dialog).toBeVisible()
    const confirm = dialog.getByLabel('Type the collection title to confirm')
    await expect(confirm).toBeFocused()
    await expectAccessible(page, '/collections/[id] (delete dialog)')
    await confirm.fill('Travel')
    await dialog.getByRole('button', { name: 'Delete collection' }).click()
    await expect(dialog).toContainText(CONFIRM_MISMATCH)
    await expect(confirm).toHaveAttribute('aria-invalid', 'true')
    await expect(confirm).toBeFocused()
    await expectAccessible(page, '/collections/[id] (delete dialog, mismatch)')

    await confirm.fill('Travel phrases')
    await dialog.getByRole('button', { name: 'Delete collection' }).click()
    await expect(page).toHaveURL(/\/collections$/)
    await expect(heading(page)).toBeFocused()
    await expect(page.getByTestId('collections-empty')).toBeVisible()

    // Gone for good.
    await page.goto(detailUrl)
    await expect(heading(page)).toHaveText('Collection not found')
  })

  test('"Load more" fetches the next page and moves focus to the first new item', async ({
    page,
  }, testInfo) => {
    await signUp(page, testInfo)
    // 21 collections: one more than the default page size (20).
    for (let i = 1; i <= 21; i++) await createViaApi(page, `Batch ${String(i).padStart(2, '0')}`)

    await page.goto('/collections')
    const cards = page.getByTestId('collection-card')
    await expect(cards).toHaveCount(20)
    await expect(cards.first()).toContainText('Batch 21') // newest first
    await page.getByRole('button', { name: 'Load more' }).click()
    await expect(cards).toHaveCount(21)
    await expect(page.getByRole('link', { name: 'Batch 01' })).toBeFocused()
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
    await expectAccessible(page, '/collections (two pages)')
  })
})

test.describe('keyboard', () => {
  test.skip(({ isMobile }) => isMobile, 'keyboard-only flow is checked on desktop')

  test('create, archive, unarchive and delete with the keyboard only', async ({ page }, testInfo) => {
    await signUp(page, testInfo)
    await page.goto('/collections')
    await expect(page.getByTestId('collections-empty')).toBeVisible()

    // Create.
    await tabTo(page, page.getByRole('main').getByRole('link', { name: 'New collection' }))
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/collections\/new$/)
    await expect(page.getByLabel('Your language')).toHaveValue('en')
    await tabTo(page, page.getByLabel('Title'))
    await page.keyboard.type('Kitchen')
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Your language')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel("Language you're learning")).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Description')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Topic')).toBeFocused()
    await page.keyboard.type('Home')
    await page.keyboard.press('Enter')
    await expect(heading(page)).toHaveText('Kitchen')
    await expect(heading(page)).toBeFocused()

    // Archive and unarchive: focus stays on the toggle.
    await tabTo(page, page.getByRole('button', { name: 'Archive', exact: true }))
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Unarchive', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeFocused()

    // The dialog traps focus, Escape cancels and focus returns to the trigger.
    const trigger = page.getByRole('button', { name: 'Delete…' })
    await tabTo(page, trigger)
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Delete this collection?' })
    const confirm = dialog.getByLabel('Type the collection title to confirm')
    await expect(confirm).toBeFocused()
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()

    // Delete with Enter in the field.
    await page.keyboard.press('Enter')
    await expect(confirm).toBeFocused()
    await page.keyboard.type('Kitchen')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/collections$/)
    await expect(heading(page)).toBeFocused()
    await expect(page.getByTestId('collections-empty')).toBeVisible()
  })
})

test.describe('small screens', () => {
  test.use({ viewport: { width: 320, height: 640 } })

  test('every collection page: no horizontal scroll, 44px targets, focused field stays visible', async ({
    page,
  }, testInfo) => {
    await signUp(page, testInfo)
    const created = await createViaApi(
      page,
      'A collection with a rather long title that has to wrap on phones',
    )

    const pages = [
      { path: '/collections', ready: 'collection-card' },
      { path: '/collections/new', ready: null },
      { path: `/collections/${created.id}`, ready: 'collection-details' },
      { path: `/collections/${created.id}/edit`, ready: null },
    ]
    for (const { path, ready } of pages) {
      await page.goto(path)
      await expect(heading(page)).toBeVisible()
      if (ready) await expect(page.getByTestId(ready).first()).toBeVisible()
      else await expect(page.getByLabel('Title')).toBeVisible()

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `${path} scrolls horizontally`).toBeLessThanOrEqual(0)

      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('a, button, input:not([type="hidden"]), select'))
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'
          })
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.height < 44 || r.width < 44
          })
          .map(
            (el) =>
              `${el.tagName.toLowerCase()} "${el.textContent?.trim() || el.getAttribute('aria-label') || el.id}"`,
          ),
      )
      expect(small, `${path} has targets under 44px`).toEqual([])

      if (!ready) {
        await page.getByLabel('Topic').focus()
        await expect(page.getByLabel('Topic')).toBeInViewport()
      }
      await expectAccessible(page, `${path} at 320px`)
    }

    // The delete dialog fits too.
    await page.goto(`/collections/${created.id}`)
    await page.getByRole('button', { name: 'Delete…' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await expect(dialog.getByRole('button', { name: 'Delete collection' })).toBeInViewport()
  })
})
