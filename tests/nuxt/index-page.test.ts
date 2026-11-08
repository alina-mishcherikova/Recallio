import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'

describe('home page', () => {
  it('renders a single top-level heading', async () => {
    const wrapper = await mountSuspended(IndexPage)
    const headings = wrapper.findAll('h1')
    expect(headings).toHaveLength(1)
    expect(headings[0]!.text()).toBe('Recallio')
  })
})
