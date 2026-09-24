import { isAdminAuthenticated } from '~/server/utils/admin-auth'

export default defineEventHandler((event) => ({ authenticated: isAdminAuthenticated(event) }))
