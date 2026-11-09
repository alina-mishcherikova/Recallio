// Collections UI (ADR 0003 §5): shared-schema validation, the language lock, the server's fixed
// 409 messages, Active / Archived views with keyset "Load more", the explicit language pair,
// archive / unarchive, and the title-retype delete confirmation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery, readBody, type H3Event } from 'h3'
import { LANGUAGE_MESSAGE } from '#shared/constants/languages'
import { COLLECTION_MESSAGES, type Collection } from '#shared/schemas/collections'
import CollectionForm from '~/components/collections/CollectionForm.vue'
import DeleteCollectionDialog from '~/components/collections/DeleteCollectionDialog.vue'
import ListPage from '~/pages/collections/index.vue'
import NewPage from '~/pages/collections/new.vue'
import DetailPage from '~/pages/collections/[id]/index.vue'
import EditPage from '~/pages/collections/[id]/edit.vue'

// The pages are protected: sign in (session state only; the API is mocked per test), so the global
// auth middleware lets the route through instead of redirecting to /login.
beforeEach(() => {
  useState('nuxt-session').value = { user: { id: '00000000-0000-4000-8000-0000000000aa' } }
})

const mounted: VueWrapper[] = []
async function mount<T>(component: T, options: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(component as never, { attachTo: document.body, ...options })
  mounted.push(wrapper as VueWrapper)
  return wrapper as VueWrapper
}
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

async function settle() {
  for (let i = 0; i < 8; i++) await flushPromises()
}

function describedByText(el: Element): string {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

function fail(status: number, message: string, extra: Record<string, unknown> = {}) {
  return (event: H3Event) => {
    event.node.res.statusCode = status
    return { statusCode: status, message, ...extra }
  }
}

let seq = 0
function makeCollection(overrides: Partial<Collection> = {}): Collection {
  seq++
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    title: `Collection ${seq}`,
    nativeLanguage: 'en',
    targetLanguage: 'fr',
    description: null,
    topic: null,
    archivedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    entryCount: 0,
    ...overrides,
  }
}

const noop = async () => {}
const blankForm = {
  title: '',
  nativeLanguage: undefined,
  targetLanguage: undefined,
  description: '',
  topic: '',
}

describe('CollectionForm', () => {
  it('reports every missing field with the shared messages and focuses the summary', async () => {
    const wrapper = await mount(CollectionForm, {
      props: {
        initial: blankForm,
        submit: noop,
        submitLabel: 'Create collection',
        pendingLabel: 'Creating…',
        pendingStatus: 'Creating…',
        cancelTo: '/collections',
      },
    })
    await wrapper.get('form').trigger('submit')
    await settle()

    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(document.activeElement).toBe(summary.element)
    const links = summary.findAll('a').map((a) => [a.text(), a.attributes('href')])
    expect(links).toEqual([
      [COLLECTION_MESSAGES.titleRequired, '#collection-title'],
      [LANGUAGE_MESSAGE, '#collection-native-language'],
      [LANGUAGE_MESSAGE, '#collection-target-language'],
    ])
    const title = wrapper.get('#collection-title')
    expect(title.attributes('aria-invalid')).toBe('true')
    expect(describedByText(title.element)).toContain(COLLECTION_MESSAGES.titleRequired)
  })

  it('rejects the same language twice on the target field, as text', async () => {
    const wrapper = await mount(CollectionForm, {
      props: {
        initial: { ...blankForm, title: 'Travel', nativeLanguage: 'fr', targetLanguage: 'fr' },
        submit: noop,
        submitLabel: 'Create collection',
        pendingLabel: 'Creating…',
        pendingStatus: 'Creating…',
        cancelTo: '/collections',
      },
    })
    await wrapper.get('form').trigger('submit')
    await settle()
    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(summary.get('a').text()).toBe(COLLECTION_MESSAGES.languagesSame)
    expect(summary.get('a').attributes('href')).toBe('#collection-target-language')
    const target = wrapper.get('#collection-target-language')
    expect(target.attributes('aria-invalid')).toBe('true')
    expect(describedByText(target.element)).toContain(COLLECTION_MESSAGES.languagesSame)
  })

  it('locks both languages with a visible explanation when the collection has words', async () => {
    const wrapper = await mount(CollectionForm, {
      props: {
        initial: { ...blankForm, title: 'Travel', nativeLanguage: 'en', targetLanguage: 'fr' },
        languagesLocked: true,
        submit: noop,
        submitLabel: 'Save changes',
        pendingLabel: 'Saving…',
        pendingStatus: 'Saving…',
        cancelTo: '/collections',
      },
    })
    expect(wrapper.get('#collection-native-language').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('#collection-target-language').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('[data-testid="languages-locked"]').text()).toBe(COLLECTION_MESSAGES.languagesLocked)
    expect(wrapper.get('#collection-title').attributes()).not.toHaveProperty('disabled')
  })

  it('labels every field', async () => {
    await mount(CollectionForm, {
      props: {
        initial: blankForm,
        submit: noop,
        submitLabel: 'Create collection',
        pendingLabel: 'Creating…',
        pendingStatus: 'Creating…',
        cancelTo: '/collections',
      },
    })
    const label = (id: string) => document.querySelector(`label[for="${id}"]`)?.textContent ?? ''
    expect(label('collection-title')).toContain('Title')
    expect(label('collection-native-language')).toContain('Your language')
    expect(label('collection-target-language')).toContain("Language you're learning")
    expect(label('collection-description')).toContain('Description')
    expect(label('collection-topic')).toContain('Topic')
  })
})

describe('/collections/new', () => {
  it("pre-fills the languages from the profile and shows the server's 409 limit message", async () => {
    registerEndpoint('/api/auth/me', () => ({
      user: {
        id: '00000000-0000-4000-8000-0000000000aa',
        email: 'learner@example.test',
        nativeLanguage: 'fr',
        timezone: 'UTC',
        dailyNewLimit: 20,
        dailyReviewLimit: 200,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }))
    let sent: unknown
    registerEndpoint('/api/collections', {
      method: 'POST',
      handler: async (event: H3Event) => {
        sent = await readBody(event)
        return fail(409, COLLECTION_MESSAGES.limitReached)(event)
      },
    })
    const wrapper = await mount(NewPage)
    await settle()
    expect((wrapper.get('#collection-native-language').element as HTMLSelectElement).value).toBe('fr')
    expect((wrapper.get('#collection-target-language').element as HTMLSelectElement).value).toBe('en')

    await wrapper.get('#collection-title').setValue('  Travel  ')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(sent).toEqual({
      title: 'Travel',
      nativeLanguage: 'fr',
      targetLanguage: 'en',
      description: null,
      topic: null,
    })
    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(summary.text()).toContain(COLLECTION_MESSAGES.limitReached)
    expect(document.activeElement).toBe(summary.element)
  })
})

describe('/collections', () => {
  it('marks the current view with aria-current and shows the empty state', async () => {
    registerEndpoint('/api/collections', { method: 'GET', handler: () => ({ items: [], nextCursor: null }) })
    const wrapper = await mount(ListPage, { route: '/collections' })
    await settle()
    const views = wrapper.get('nav[aria-label="Collection views"]').findAll('a')
    expect(views.map((a) => [a.text(), a.attributes('aria-current')])).toEqual([
      ['Active', 'page'],
      ['Archived', 'false'],
    ])
    const empty = wrapper.get('[data-testid="collections-empty"]')
    expect(empty.text()).toContain("You don't have any collections yet.")
    expect(empty.find('a[href="/collections/new"]').exists()).toBe(true)
  })

  it('asks for the archived view and shows its own empty state', async () => {
    let status: unknown
    registerEndpoint('/api/collections', {
      method: 'GET',
      handler: (event: H3Event) => {
        status = getQuery(event).status
        return { items: [], nextCursor: null }
      },
    })
    const wrapper = await mount(ListPage, { route: '/collections?status=archived' })
    await settle()
    expect(status).toBe('archived')
    expect(wrapper.get('a[aria-current="page"]').text()).toBe('Archived')
    expect(wrapper.get('[data-testid="collections-empty"]').text()).toContain('No archived collections.')
  })

  it('loads the next page with the cursor and moves focus to the first new item', async () => {
    const first = [makeCollection({ title: 'Newest' }), makeCollection()]
    const second = [makeCollection({ title: 'Older', archivedAt: null })]
    const cursors: unknown[] = []
    registerEndpoint('/api/collections', {
      method: 'GET',
      handler: (event: H3Event) => {
        const { cursor } = getQuery(event)
        cursors.push(cursor)
        return cursor ? { items: second, nextCursor: null } : { items: first, nextCursor: first.at(-1)!.id }
      },
    })
    const wrapper = await mount(ListPage, { route: '/collections' })
    await settle()
    expect(wrapper.findAll('[data-testid="collection-card"]')).toHaveLength(2)
    // The pair is explicit text, with a spoken form for screen readers.
    const pair = wrapper.get('[data-testid="language-pair"]')
    expect(pair.get('[aria-hidden="true"]').text()).toBe('English → French')
    expect(pair.get('.sr-only').text()).toBe('English to French')

    const loadMore = wrapper.findAll('button').find((b) => b.text() === 'Load more')!
    await loadMore.trigger('click')
    await settle()
    expect(cursors).toEqual([undefined, first.at(-1)!.id])
    expect(wrapper.findAll('[data-testid="collection-card"]')).toHaveLength(3)
    expect(document.activeElement?.id).toBe(`collection-link-${second[0]!.id}`)
    expect(wrapper.findAll('button').some((b) => b.text() === 'Load more')).toBe(false)
  })

  it('renders titles as text, never as HTML', async () => {
    registerEndpoint('/api/collections', {
      method: 'GET',
      handler: () => ({
        items: [makeCollection({ title: '<img src=x onerror=alert(1)>' })],
        nextCursor: null,
      }),
    })
    const wrapper = await mount(ListPage, { route: '/collections' })
    await settle()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-testid="collection-card"] h2').text()).toBe('<img src=x onerror=alert(1)>')
  })

  it('shows a fixed message and a retry button when loading fails', async () => {
    registerEndpoint('/api/collections', {
      method: 'GET',
      handler: fail(500, 'relation "collections" does not exist'),
    })
    const wrapper = await mount(ListPage, { route: '/collections' })
    await settle()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('Something went wrong')
    expect(alert.text()).not.toContain('relation')
    expect(alert.find('button').text()).toBe('Try again')
  })
})

describe('/collections/[id]', () => {
  it('shows the language pair explicitly and toggles archive without losing focus', async () => {
    const collection = makeCollection({ title: 'Kitchen', topic: 'Home', entryCount: 3 })
    registerEndpoint(`/api/collections/${collection.id}`, { method: 'GET', handler: () => collection })
    registerEndpoint(`/api/collections/${collection.id}/archive`, {
      method: 'POST',
      handler: () => ({ ...collection, archivedAt: '2026-11-09T10:00:00.000Z' }),
    })
    registerEndpoint(`/api/collections/${collection.id}/unarchive`, {
      method: 'POST',
      handler: () => collection,
    })
    const wrapper = await mount(DetailPage, { route: `/collections/${collection.id}` })
    await settle()

    expect(wrapper.get('h1').text()).toBe('Kitchen')
    expect(wrapper.get('[data-testid="language-pair"] [aria-hidden="true"]').text()).toBe('English → French')
    const details = wrapper.get('[data-testid="collection-details"]').text()
    expect(details).toContain('Your language')
    expect(details).toContain('English')
    expect(details).toContain("Language you're learning")
    expect(details).toContain('French')
    expect(details).toContain('3 words')
    expect(wrapper.find(`a[href="/collections/${collection.id}/edit"]`).exists()).toBe(true)

    const toggle = () => wrapper.findAll('button').find((b) => /^(Archive|Unarchive)$/.test(b.text()))!
    ;(toggle().element as HTMLButtonElement).focus()
    await toggle().trigger('click')
    await settle()
    expect(toggle().text()).toBe('Unarchive')
    expect(document.activeElement).toBe(toggle().element)
    expect(wrapper.get('[data-testid="archived-badge"]').text()).toBe('Archived')
    expect(wrapper.get('[data-testid="action-status"]').text()).toContain('Collection archived.')
    // Archived = read-only: no edit link.
    expect(wrapper.find(`a[href="/collections/${collection.id}/edit"]`).exists()).toBe(false)

    await toggle().trigger('click')
    await settle()
    expect(toggle().text()).toBe('Archive')
    expect(wrapper.find('[data-testid="archived-badge"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="action-status"]').text()).toContain('Collection unarchived.')
  })

  it('shows "not found" for a 404 and for a malformed id, without a request for the latter', async () => {
    const id = '00000000-0000-4000-8000-00000000ffff'
    registerEndpoint(`/api/collections/${id}`, { method: 'GET', handler: fail(404, 'Not Found') })
    const wrapper = await mount(DetailPage, { route: `/collections/${id}` })
    await settle()
    expect(wrapper.get('h1').text()).toBe('Collection not found')

    const malformed = await mount(DetailPage, { route: '/collections/not-a-uuid' })
    await settle()
    expect(malformed.get('h1').text()).toBe('Collection not found')
  })
})

describe('/collections/[id]/edit', () => {
  it('disables the languages when the collection has words and shows the 409 message', async () => {
    const collection = makeCollection({ title: 'Verbs', entryCount: 2 })
    let sent: unknown
    registerEndpoint(`/api/collections/${collection.id}`, {
      method: 'GET',
      handler: () => collection,
    })
    registerEndpoint(`/api/collections/${collection.id}`, {
      method: 'PATCH',
      handler: async (event: H3Event) => {
        sent = await readBody(event)
        return fail(409, COLLECTION_MESSAGES.languagesLocked)(event)
      },
    })
    const wrapper = await mount(EditPage, { route: `/collections/${collection.id}/edit` })
    await settle()

    expect(wrapper.get('#collection-native-language').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('[data-testid="languages-locked"]').text()).toBe(COLLECTION_MESSAGES.languagesLocked)

    await wrapper.get('#collection-title').setValue('Irregular verbs')
    await wrapper.get('form').trigger('submit')
    await settle()
    // Locked languages are not sent.
    expect(sent).toEqual({ title: 'Irregular verbs', description: null, topic: null })
    const summary = wrapper.get('[data-testid="form-error-summary"]')
    expect(summary.text()).toContain(COLLECTION_MESSAGES.languagesLocked)
    expect(document.activeElement).toBe(summary.element)
  })

  it('shows a read-only notice with Unarchive for an archived collection, then the form', async () => {
    const collection = makeCollection({ archivedAt: '2026-11-09T10:00:00.000Z' })
    registerEndpoint(`/api/collections/${collection.id}`, { method: 'GET', handler: () => collection })
    registerEndpoint(`/api/collections/${collection.id}/unarchive`, {
      method: 'POST',
      handler: () => ({ ...collection, archivedAt: null }),
    })
    const wrapper = await mount(EditPage, { route: `/collections/${collection.id}/edit` })
    await settle()
    expect(wrapper.find('form').exists()).toBe(false)
    const notice = wrapper.get('[data-testid="archived-notice"]')
    expect(notice.text()).toContain('read-only')

    await notice.get('button').trigger('click')
    await settle()
    expect(wrapper.find('form').exists()).toBe(true)
    expect(document.activeElement?.id).toBe('collection-title')
  })
})

describe('DeleteCollectionDialog', () => {
  it('requires the exact title, shows a text error, and sends it in the body', async () => {
    const collection = makeCollection({ title: 'Café', entryCount: 12 })
    let sent: unknown
    registerEndpoint(`/api/collections/${collection.id}`, {
      method: 'DELETE',
      handler: async (event: H3Event) => {
        sent = await readBody(event)
        event.node.res.statusCode = 204
        return null
      },
    })
    const wrapper = await mount(DeleteCollectionDialog, { props: { open: true, collection } })
    await settle()

    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Delete this collection?')
    expect(dialog.textContent).toContain('“Café” and its 12 words will be deleted')
    const input = document.getElementById('delete-collection-confirm') as HTMLInputElement
    expect(document.querySelector('label[for="delete-collection-confirm"]')?.textContent).toContain(
      'Type the collection title to confirm',
    )

    input.value = 'cafe'
    input.dispatchEvent(new Event('input'))
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(sent).toBeUndefined()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(describedByText(input)).toContain(COLLECTION_MESSAGES.confirmMismatch)
    expect(document.activeElement).toBe(input)

    // NFD input and surrounding spaces still match after NFC + trim.
    input.value = '  Cafe\u0301 '
    input.dispatchEvent(new Event('input'))
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(sent).toEqual({ confirmTitle: 'Café' })
    expect(wrapper.emitted('deleted')).toEqual([[{ alreadyGone: false }]])
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })
})
