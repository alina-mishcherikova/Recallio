<script setup lang="ts">
// Placeholder until the real dashboard (LEX-014).
useSeoMeta({ title: 'Dashboard · Recallio' })

const { logout } = useAuth()
const { data: user, status, refresh } = useProfile()

const loggingOut = ref(false)
const logoutError = ref('')

async function onLogout() {
  loggingOut.value = true
  logoutError.value = ''
  try {
    await logout()
  } catch (error) {
    logoutError.value = toUiApiError(error).message
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <UContainer class="flex max-w-3xl flex-col gap-6 py-8 sm:py-12">
    <div class="flex flex-col gap-2">
      <h1 tabindex="-1" class="text-3xl font-bold tracking-tight focus:outline-none">Dashboard</h1>
      <p role="status" class="text-muted" data-testid="signed-in-as">
        <template v-if="user">
          Signed in as <span class="font-medium text-default">{{ user.email }}</span>
        </template>
        <template v-else-if="status === 'error'">We couldn't load your profile.</template>
        <template v-else>Loading your profile…</template>
      </p>
      <div v-if="status === 'error'">
        <UButton
          color="neutral"
          variant="outline"
          label="Try again"
          class="min-h-11 min-w-11"
          @click="() => refresh()"
        />
      </div>
    </div>

    <p>Your collections, reviews and practice will appear here.</p>

    <div class="flex flex-col gap-3 sm:flex-row">
      <UButton
        to="/account"
        color="neutral"
        variant="outline"
        size="lg"
        label="Account"
        class="min-h-11 min-w-11 justify-center"
      />
      <UButton
        color="neutral"
        variant="ghost"
        size="lg"
        :loading="loggingOut"
        :label="loggingOut ? 'Logging out…' : 'Log out'"
        class="min-h-11 min-w-11 justify-center"
        @click="onLogout"
      />
    </div>
    <p v-if="logoutError" role="alert" class="flex items-center gap-2 text-sm text-error">
      <UIcon name="i-lucide-circle-alert" aria-hidden="true" class="size-4 shrink-0" />
      <span>{{ logoutError }}</span>
    </p>
  </UContainer>
</template>
