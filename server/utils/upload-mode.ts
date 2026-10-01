export function registeredUsersOnly(): boolean {
  return process.env.REGISTERED_USERS_ONLY === 'true'
}

export function registrationEnabled(): boolean {
  return registeredUsersOnly() && process.env.ENABLE_REGISTRATION !== 'false'
}

/** Whether the public upload form may offer the site Data API opt-in (ENABLE_DATA_API_TOGGLE). */
export function dataApiToggleEnabled(): boolean {
  return process.env.ENABLE_DATA_API_TOGGLE !== 'false'
}
