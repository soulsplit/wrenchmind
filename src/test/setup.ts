import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { setConsoleEnabled } from '../services/logger'

setConsoleEnabled(false)

afterEach(() => {
  cleanup()
})
