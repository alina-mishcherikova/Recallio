// LEX-003 auth journeys (ADR 0002 §8.4). Runs on the desktop and mobile projects against the built
// server and the test database. Needs the backend routes from the same issue.
//
// Registration is limited to 10 attempts per IP per hour (ADR 0002 §5.4). Every run starts its own
// server (fresh limiter, tests/e2e/global-setup.ts), and every test sends its own client IP in the
// trusted header, so retries and repeated runs never share a bucket. No app-side bypass.
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { uniqueClientIpHeaders } from './env'

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientIpHeaders())
})

const INVALID_CREDENTIALS = 'Email or password is incorrect.'
const EMAIL_TAKEN = 'Could not create an account with this email. If you already have one, log in.'

async function expectAccessible(page: Page, label: string) {
  // Let enter transitions (dialog fade-in, toasts) finish: axe measures colors as rendered, and a
  // half-faded element reads as low contrast. Infinite animations (spinners) are skipped.
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

function credentials(testInfo: TestInfo) {
  const id = `${testInfo.project.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // The password must not contain the email's local part (password policy).
  return {
    email: `e2e-${id}@example.test`,
    password: `quiet harbor lamp ${Math.random().toString(36).slice(2, 8)}`,
  }
}

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

const passwordField = (page: Page, label = 'Password') => page.getByLabel(label, { exact: true })

async function register(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await passwordField(page).fill(password)
  await page.getByLabel('Native language').selectOption('en')
  await page.getByRole('button', { name: 'Create account' }).click()
}

async function login(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await passwordField(page).fill(password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
}

test.describe('auth journey', () => {
  test('register → dashboard → logout → guest redirect → login → delete account', async ({
    page,
  }, testInfo) => {
    const { email, password } = credentials(testInfo)

    await page.goto('/')
    await expectAccessible(page, '/')
    await page.getByRole('link', { name: 'Create account' }).click()

    await expect(page).toHaveURL(/\/register$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Create an account' })).toBeVisible()
    await expect(page.getByText('No password recovery yet')).toBeVisible()
    await expect(page.getByRole('link', { name: /forgot/i })).toHaveCount(0)
    await expectAccessible(page, '/register')

    await register(page, email, password)
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeFocused()
    await expect(page.getByTestId('signed-in-as')).toHaveText(`Signed in as ${email}`)
    // Credentials never end up in the URL or in web storage.
    expect(page.url()).not.toContain(encodeURIComponent(email))
    expect(page.url()).not.toContain('password')
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
    expect(storage).not.toContain(email)
    expect(storage).not.toContain(password)
    await expectAccessible(page, '/dashboard')

    await page.getByRole('main').getByRole('button', { name: 'Log out' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeFocused()
    await expectAccessible(page, '/login')

    // A guest opening a protected page goes to /login and comes back after logging in.
    await page.goto('/account')
    await expect(page).toHaveURL(/\/login\?redirect=(%2F|\/)account$/)
    await login(page, email, password)
    await expect(page).toHaveURL(/\/account$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible()
    await expect(page.getByTestId('profile')).toContainText(email)
    await expect(page.getByTestId('profile')).toContainText('English')
    await expectAccessible(page, '/account')

    // Deletion needs the current password, then an explicit confirmation.
    await page.getByRole('button', { name: 'Delete account…' }).click()
    await expect(page.getByTestId('form-error-summary')).toBeFocused()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await passwordField(page, 'Current password').fill(password)
    await page.getByRole('button', { name: 'Delete account…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete your account permanently?' })
    await expect(dialog).toBeVisible()
    await expectAccessible(page, '/account (confirmation dialog)')
    await dialog.getByRole('button', { name: 'Delete my account' }).click()

    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Recallio' })).toBeVisible()

    // The account is gone: the old credentials get the generic message.
    await page.goto('/login')
    await login(page, email, password)
    const summary = page.getByTestId('form-error-summary')
    await expect(summary).toBeFocused()
    await expect(summary).toContainText(INVALID_CREDENTIALS)
    await expectAccessible(page, '/login (invalid credentials)')
  })

  test('duplicate email shows the fixed message and links to login; the redirect is never off-site', async ({
    page,
  }, testInfo) => {
    const { email, password } = credentials(testInfo)

    await page.goto('/register')
    await register(page, email, password)
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.getByRole('main').getByRole('button', { name: 'Log out' }).click()
    await expect(page).toHaveURL(/\/login$/)

    await page.goto('/register')
    await register(page, email, password)
    const summary = page.getByTestId('form-error-summary')
    await expect(summary).toBeFocused()
    await expect(summary).toContainText(EMAIL_TAKEN)
    await expectAccessible(page, '/register (409)')

    // The link carries the email in memory only.
    await summary.getByRole('link', { name: 'Log in with this email' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email)

    // An off-site redirect parameter is replaced by /dashboard.
    await page.goto('/login?redirect=//evil.example/steal')
    await login(page, email, password)
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/dashboard$/)

    // Signed-in users are sent away from the guest pages.
    await page.goto('/login')
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.goto('/register')
    await expect(page).toHaveURL(/\/dashboard$/)

    // Clean up.
    await page.goto('/account')
    await passwordField(page, 'Current password').fill(password)
    await page.getByRole('button', { name: 'Delete account…' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete my account' }).click()
    await expect(page).toHaveURL(/\/$/)
  })
})

test.describe('guest access', () => {
  test('a protected page redirects a guest to /login with a same-origin redirect', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login\?redirect=(%2F|\/)dashboard$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible()
  })
})

test.describe('form errors', () => {
  test('an empty login focuses the error summary and marks the fields', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    const summary = page.getByTestId('form-error-summary')
    await expect(summary).toBeFocused()
    await expect(summary.getByRole('link', { name: 'Enter a valid email address.' })).toBeVisible()
    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('aria-invalid', 'true')
    await expect(passwordField(page)).toHaveAttribute('aria-invalid', 'true')
    await expectAccessible(page, '/login (errors)')

    await summary.getByRole('link', { name: 'Enter your password.' }).click()
    await expect(passwordField(page)).toBeFocused()
  })

  test('a weak password shows the policy message as text', async ({ page }) => {
    await page.goto('/register')
    await page.getByLabel('Email', { exact: true }).fill('someone@example.test')
    await passwordField(page).fill('aaaa')
    await page.getByRole('button', { name: 'Create account' }).click()
    const summary = page.getByTestId('form-error-summary')
    await expect(summary).toBeFocused()
    await expect(summary).toContainText('Use at least 12 characters.')
    await expect(summary).toContainText('Choose your native language.')
    await expectAccessible(page, '/register (errors)')
  })
})

test.describe('keyboard', () => {
  test.skip(({ isMobile }) => isMobile, 'keyboard-only flow is checked on desktop')

  test('tab order, the password toggle, and Enter to submit', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email', { exact: true }).focus()
    await page.keyboard.type('someone@example.test')
    await page.keyboard.press('Tab')
    await expect(passwordField(page)).toBeFocused()
    await page.keyboard.type('a password')
    await page.keyboard.press('Tab')
    const toggle = page.getByRole('button', { name: 'Show password' })
    await expect(toggle).toBeFocused()
    await page.keyboard.press('Space')
    await expect(passwordField(page)).toHaveAttribute('type', 'text')
    await expect(page.getByRole('button', { name: 'Hide password' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(passwordField(page)).toHaveAttribute('type', 'password')

    await passwordField(page).focus()
    await page.keyboard.press('Enter')
    // Unknown account: the generic message, in the focused summary.
    await expect(page.getByTestId('form-error-summary')).toBeFocused()
    await expect(page.getByTestId('form-error-summary')).toContainText(INVALID_CREDENTIALS)
  })
})

test.describe('small screens', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  for (const path of ['/login', '/register']) {
    test(`${path}: no horizontal scroll, 44px targets, focused field stays visible`, async ({ page }) => {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)

      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('a, button, input:not([type="hidden"])'))
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
      expect(small).toEqual([])

      await passwordField(page).focus()
      await expect(passwordField(page)).toBeInViewport()
    })
  }
})
