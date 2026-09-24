export function registeredUsersOnly(): boolean {
  return process.env.REGISTERED_USERS_ONLY === 'true'
}

export function registrationEnabled(): boolean {
  return registeredUsersOnly() && process.env.ENABLE_REGISTRATION !== 'false'
}
