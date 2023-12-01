import { promises as fs } from 'fs'
import * as path from 'path'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export async function readFromFile<T>(filepath: string): Promise<T> {
  try {
    const data = await fs.readFile(filepath, 'utf-8')
    return JSON.parse(data) as T
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Return a default state if the state file is not found
      return null as unknown as T
    }
    throw new Error(`failed to read file: ${filepath}, err: ${err.message}`)
  }
}

export async function writeToFile<T>(
  filepath: string,
  state: T
): Promise<void> {
  const dir = path.dirname(filepath)

  try {
    await fs.access(dir)
  } catch (error) {
    // create dir if not exists
    await fs.mkdir(dir, { recursive: true })
  }

  const data = JSON.stringify(state, null, 2)
  await fs.writeFile(filepath, data, 'utf-8')
}

export function splitArray<T>(array: T[]): [T[], T[]] {
  const middle = Math.ceil(array.length / 2)
  const firstHalf = array.slice(0, middle)
  const secondHalf = array.slice(middle)
  return [firstHalf, secondHalf]
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
