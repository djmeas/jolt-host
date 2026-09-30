/**
 * Runtime environment classification.
 *
 * Vite rewrites the literal `process.env.NODE_ENV` expression to the mode used
 * for the build, so bundling server code would freeze every production/dev
 * branch to the build machine's value. Reading it through an alias keeps the
 * value the server actually runs with.
 *
 * Anything that is not an explicit development or test run counts as
 * production, so a deployment with missing configuration fails closed.
 */
const runtimeEnv = process.env

export function isProductionRuntime(): boolean {
  return (
    runtimeEnv.NODE_ENV !== 'development' &&
    runtimeEnv.NODE_ENV !== 'test' &&
    runtimeEnv.JOLT_TEST_MODE !== '1'
  )
}
