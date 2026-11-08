// Auth forms (ADR 0002 §7): client-side validation with the shared schemas, error summary focus,
// inline errors tied to fields, server messages, and the password toggle.
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { AUTH_MESSAGES, PASSWORD_MESSAGES } from '#shared/schemas/auth'
import LoginPage from '~/pages/login.vue'
import RegisterPage from '~/pages/register.vue'
import AccountPage from '~/pages/account.vue'
import PasswordInput from '~/components/auth/PasswordInput.vue'
import FormErrorSummary from '~/components/auth/FormErrorSummary.vue'

const mounted: VueWrapper[] = []
async function mount<T>(component: T, options: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(component as never, { attachTo: document.body, ...options })
  mounted.push(wrapper as VueWrapper)
  return wrapper as VueWrapper
}
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

/** UForm validates asynchronously, and the summary focuses itself on the next tick. */
async function settle() {
  for (let i = 0; i < 5; i++) await flushPromises()
}

async function typeInto(wrapper: VueWrapper, selector: string, value: string) {
  const input = wrapper.find(selector)
  await input.setValue(value)
}

/** The text of every element referenced by `aria-describedby`. */
function describedByText(el: Element): string {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

function errorResponse(status: number, message: string, extra: Record<string, unknown> = {}) {
  return (event: { node: { res: { statusCode: number; setHeader: (k: string, v: string) => void } } }) => {
    event.node.res.statusCode = status
    if (status === 429) event.node.res.setHeader('retry-after', '120')
    return { statusCode: status, message, ...extra }
  }
}

describe('/login', () => {
  it('has labelled fields with the right autocomplete tokens', async () => {
    const wrapper = await mount(LoginPage)
    const email = wrapper.get('#login-email')
    const password = wrapper.get('#login-password')
    expect(email.attributes()).toMatchObject({ type: 'email', autocomplete: 'email', inputmode: 'email' })
    expect(password.attributes()).toMatchObject({ type: 'password', autocomplete: 'current-password' })
    expect(document.querySelector('label[for="login-email"]')?.textContent).toContain('Email')
    expect(document.querySelector('label[for="login-password"]')?.textContent).toContain('Password')
    expect(wrapper.text()).not.toMatch(/forgot/i)
  })

  it('on an empty submit, shows the shared messages, focuses the summary and marks the fields', async () => {
    const wrapper = await mount(LoginPage)
    await wrapper.get('form').trigger('submit')
    await settle()

    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(summary.attributes('role')).toBe('alert')
    expect(document.activeElement).toBe(summary.element)

    const links = summary.findAll('a')
    expect(links.map((a) => [a.text(), a.attributes('href')])).toEqual([
      [AUTH_MESSAGES.invalidEmail, '#login-email'],
      [AUTH_MESSAGES.passwordRequired, '#login-password'],
    ])

    const email = wrapper.get('#login-email')
    expect(email.attributes('aria-invalid')).toBe('true')
    expect(describedByText(email.element)).toContain(AUTH_MESSAGES.invalidEmail)
    const password = wrapper.get('#login-password')
    expect(password.attributes('aria-invalid')).toBe('true')
    expect(describedByText(password.element)).toContain(AUTH_MESSAGES.passwordRequired)
  })

  it('a summary link moves focus to its field', async () => {
    const wrapper = await mount(LoginPage)
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('[data-testid="form-error-summary"] a[href="#login-password"]').trigger('click')
    expect(document.activeElement?.id).toBe('login-password')
  })

  it("shows the server's fixed 401 message, not raw error details", async () => {
    registerEndpoint('/api/auth/login', {
      method: 'POST',
      handler: errorResponse(401, AUTH_MESSAGES.invalidCredentials),
    })
    const wrapper = await mount(LoginPage)
    await typeInto(wrapper, '#login-email', 'someone@example.test')
    await typeInto(wrapper, '#login-password', 'not the right one')
    await wrapper.get('form').trigger('submit')
    await settle()

    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(summary.text()).toContain(AUTH_MESSAGES.invalidCredentials)
    expect(summary.text()).not.toMatch(/FetchError|POST|\/api\//)
    expect(document.activeElement).toBe(summary.element)
  })

  it('shows the time left on a 429', async () => {
    registerEndpoint('/api/auth/login', {
      method: 'POST',
      handler: errorResponse(429, 'Too many attempts. Try again in 2 minutes.'),
    })
    const wrapper = await mount(LoginPage)
    await typeInto(wrapper, '#login-email', 'someone@example.test')
    await typeInto(wrapper, '#login-password', 'whatever it is')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.get('[data-testid="form-error-summary"]').text()).toContain(
      'Too many attempts. Try again in 2 minutes.',
    )
  })

  it('replaces unexpected server errors with a generic message', async () => {
    registerEndpoint('/api/auth/login', {
      method: 'POST',
      handler: errorResponse(500, 'relation "users" does not exist at /srv/app/server.mjs:1:1'),
    })
    const wrapper = await mount(LoginPage)
    await typeInto(wrapper, '#login-email', 'someone@example.test')
    await typeInto(wrapper, '#login-password', 'whatever it is')
    await wrapper.get('form').trigger('submit')
    await settle()
    const text = wrapper.get('[data-testid="form-error-summary"]').text()
    expect(text).toContain('Something went wrong')
    expect(text).not.toContain('relation')
  })
})

describe('/register', () => {
  it('uses new-password, links the requirements to the field, and says recovery is unavailable', async () => {
    const wrapper = await mount(RegisterPage)
    const password = wrapper.get('#register-password')
    expect(password.attributes('autocomplete')).toBe('new-password')
    expect(describedByText(password.element)).toMatch(/12 to 128 characters/)
    expect(wrapper.get('#register-email').attributes('autocomplete')).toBe('email')
    expect(wrapper.text()).toMatch(/No password recovery yet/)
    expect(wrapper.text()).not.toMatch(/forgot/i)
  })

  it('reports every problem in one pass, including the password policy and a readable language message', async () => {
    const wrapper = await mount(RegisterPage)
    await typeInto(wrapper, '#register-password', 'aaaa')
    await wrapper.get('form').trigger('submit')
    await settle()

    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(document.activeElement).toBe(summary.element)
    const text = summary.text()
    expect(text).toContain(AUTH_MESSAGES.invalidEmail)
    expect(text).toContain(PASSWORD_MESSAGES.too_short)
    expect(text).toContain(PASSWORD_MESSAGES.repetitive)
    expect(text).toContain('Choose your native language.')
    expect(text).not.toMatch(/expected one of/)
    // One entry per field, even when Zod reports the same message twice.
    expect(summary.findAll('li')).toHaveLength(3)

    const password = wrapper.get('#register-password')
    expect(password.attributes('aria-invalid')).toBe('true')
    expect(describedByText(password.element)).toContain(PASSWORD_MESSAGES.too_short)
  })

  it('rejects a password that contains the email address', async () => {
    const wrapper = await mount(RegisterPage)
    await typeInto(wrapper, '#register-email', 'Marguerite@example.test')
    await typeInto(wrapper, '#register-password', 'my marguerite password')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.get('[data-testid="form-error-summary"]').text()).toContain(
      PASSWORD_MESSAGES.contains_email,
    )
  })
})

describe('/register server errors', () => {
  async function fillValidForm(wrapper: VueWrapper) {
    await typeInto(wrapper, '#register-email', 'taken@example.test')
    await typeInto(wrapper, '#register-password', 'four unrelated plain words')
    // USelect keeps a hidden native <select> in sync for forms and autofill.
    const native = wrapper.find('select')
    await native.setValue('en')
    await settle()
  }

  it('shows the fixed 409 message and a way to log in, without putting the email in the URL', async () => {
    registerEndpoint('/api/auth/register', {
      method: 'POST',
      handler: errorResponse(409, AUTH_MESSAGES.emailTaken),
    })
    const wrapper = await mount(RegisterPage)
    await fillValidForm(wrapper)
    await wrapper.get('form').trigger('submit')
    await settle()

    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(document.activeElement).toBe(summary.element)
    expect(summary.text()).toContain(AUTH_MESSAGES.emailTaken)
    const login = summary.findAll('a').find((a) => a.text() === 'Log in with this email')
    expect(login).toBeDefined()
    expect(login!.attributes('href')).toBe('/login')
  })

  it('maps 400 issues from the server onto the fields', async () => {
    registerEndpoint('/api/auth/register', {
      method: 'POST',
      handler: errorResponse(400, 'Bad Request', {
        issues: [{ path: 'password', message: PASSWORD_MESSAGES.common }],
      }),
    })
    const wrapper = await mount(RegisterPage)
    await fillValidForm(wrapper)
    await wrapper.get('form').trigger('submit')
    await settle()

    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(summary.get('a').text()).toBe(PASSWORD_MESSAGES.common)
    expect(summary.get('a').attributes('href')).toBe('#register-password')
    const password = wrapper.get('#register-password')
    expect(password.attributes('aria-invalid')).toBe('true')
    expect(describedByText(password.element)).toContain(PASSWORD_MESSAGES.common)
  })
})

describe('/account', () => {
  it('asks for the current password before anything else', async () => {
    const wrapper = await mount(AccountPage)
    const password = wrapper.get('#delete-account-password')
    expect(password.attributes('autocomplete')).toBe('current-password')
    await wrapper.get('form').trigger('submit')
    await settle()
    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(summary.text()).toContain(AUTH_MESSAGES.passwordRequired)
    expect(document.activeElement).toBe(summary.element)
    // No confirmation dialog without a password.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens an explicit confirmation dialog once a password is entered', async () => {
    const wrapper = await mount(AccountPage)
    await typeInto(wrapper, '#delete-account-password', 'my current password')
    await wrapper.get('form').trigger('submit')
    await settle()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Delete your account permanently?')
    expect(dialog?.textContent).toContain('Cancel')
    expect(dialog?.textContent).toContain('Delete my account')
  })
})

describe('PasswordInput', () => {
  it('toggles visibility with an accessible name and announces the state', async () => {
    const wrapper = await mount(PasswordInput, { props: { id: 'pw', autocomplete: 'current-password' } })
    const input = wrapper.get('#pw')
    const toggle = wrapper.get('button')
    expect(input.attributes('type')).toBe('password')
    expect(toggle.attributes()).toMatchObject({
      type: 'button',
      'aria-label': 'Show password',
      'aria-controls': 'pw',
    })
    expect(toggle.text()).toContain('Show')

    await toggle.trigger('click')
    expect(input.attributes('type')).toBe('text')
    expect(toggle.attributes('aria-label')).toBe('Hide password')
    expect(wrapper.get('[role="status"]').text()).toBe('Your password is shown.')

    await toggle.trigger('click')
    expect(input.attributes('type')).toBe('password')
    expect(wrapper.get('[role="status"]').text()).toBe('Your password is hidden.')
  })
})

describe('FormErrorSummary', () => {
  it('renders nothing without errors and plain text for form-level errors', async () => {
    const empty = await mount(FormErrorSummary, { props: { errors: [] } })
    expect(empty.find('[data-testid="form-error-summary"]').exists()).toBe(false)

    const wrapper = await mount(FormErrorSummary, { props: { errors: [{ message: 'Too many attempts.' }] } })
    await settle()
    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(summary.find('a').exists()).toBe(false)
    expect(summary.find('h2').text()).toBe('There is a problem')
    expect(summary.attributes('aria-labelledby')).toBe(summary.find('h2').attributes('id'))
  })

  it('takes focus again for every new set of errors', async () => {
    const wrapper = await mount(FormErrorSummary, { props: { errors: [] } })
    await wrapper.setProps({ errors: [{ message: 'First.' }] })
    await settle()
    const summary = wrapper.get('[data-testid="form-error-summary"]').element as HTMLElement
    expect(document.activeElement).toBe(summary)
    summary.blur()
    await wrapper.setProps({ errors: [{ message: 'First.' }] })
    await settle()
    expect(document.activeElement).toBe(summary)
  })
})
