import packageJson from '../package.json'

/**
 * App version shown in the header top bar. Single source of truth is the
 * `version` field in package.json — bump it there for each release.
 */
export const APP_VERSION: string = packageJson.version
