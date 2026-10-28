import type { GuidanceResult } from '../types'

/**
 * Shared GuidanceResult fixtures for downstream pipeline/UI tests (Wave 1
 * contract). Both sides import these so neither drifts from `src/types.ts`.
 */

/** Fully populated, schema-valid guidance object. */
export const validGuidanceFixture: GuidanceResult = {
  title: 'MID-DRIVE DRIVE BELT',
  steps: [
    {
      title: 'Remove the belt cover',
      detail: 'Undo the four cover screws and lift the cover clear of the drive.',
    },
    {
      title: 'Release belt tension',
      detail: 'Rotate the tensioner clockwise and slip the belt off the rear pulley.',
      warning: 'Keep fingers clear of the tensioner spring.',
    },
    {
      title: 'Fit the new belt',
      detail: 'Seat the new belt on the front pulley first, then roll it onto the rear pulley.',
    },
  ],
  specs: [
    { label: 'Belt tension', value: '45 Hz' },
    { label: 'Cover screws', value: 'T25 Torx, 6 Nm' },
  ],
  tools: ['T25 Torx', 'Torque wrench'],
  warnings: ['Disconnect the battery before starting work.', 'Verify all specs against the manual.'],
  sources: [
    { title: 'Example Service Manual, Belt Drive chapter', url: 'https://example.com/manuals/belt-drive' },
  ],
  manualTitle: 'Example Service Manual',
  speechSummary:
    'Replace the mid-drive belt by removing the belt cover, releasing the tensioner, and fitting the new belt front pulley first. Disconnect the battery before starting, and verify the belt tension and screw torque against the manual.',
}

/**
 * Deliberately schema-invalid payload: wrong types, missing mandatory
 * slots, and markdown in speechSummary. Typed as `unknown` so validators
 * under test must narrow it themselves.
 */
export const invalidGuidanceFixture: unknown = {
  title: 42,
  steps: [{ title: 'Only a title, no detail' }],
  specs: 'not-an-array',
  tools: [null],
  // warnings slot missing entirely (mandatory per D2)
  sources: [{ title: 'Missing url' }],
  manualTitle: 7,
  speechSummary: '**Markdown** is *not* allowed here.',
}
