// Emits GitHub Actions annotations for failing node:test cases so failures are
// visible in the run summary (and through the public annotations API).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const relative = file => { try { return path.relative(process.cwd(), file.startsWith('file:') ? fileURLToPath(file) : file).split(path.sep).join('/') } catch { return file } }
const clean = value => String(value ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
export default async function* githubReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue
    const { name, details, file, line } = event.data
    if (details?.error?.failureType === 'subtestsFailed') continue
    const cause = details?.error?.cause ?? details?.error
    const message = [cause?.code, cause?.message ?? cause, cause?.stack?.split('\n').slice(1, 6).join('\n')].filter(Boolean).join('\n')
    const params = [...(file ? [`file=${relative(file)}`] : []), ...(file && line ? [`line=${line}`] : []), `title=${clean(name).slice(0, 200)}`]
    yield `::error ${params.join(',')}::${clean(message).slice(0, 4000)}\n`
  }
}
