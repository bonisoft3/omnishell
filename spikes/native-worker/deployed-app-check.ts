import assert from 'node:assert/strict'
import { chromium } from 'npm:playwright@1.61.1'

const [origin, output] = Deno.args
if (!origin || !output) throw new Error('deployed-app-check.ts <origin> <results.json>')
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 412, height: 823 }, isMobile: true })
  const page = await context.newPage()
  const errors: string[] = []
  const reads: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/crud/')) reads.push(request.url()) })
  const publicRoutes = ['/en/championships', '/en/matches', '/en/teams', '/en/stadiums', '/en/referees', '/usuarios', '/en/team/flamengo-rj', '/en/championship/brazil-campeonato-brasileiro-2026']
  for (const path of publicRoutes) {
    const response = await context.request.get(origin + path, { timeout: 60_000 })
    assert.equal(response.status(), 200, `public route ${path}`)
    assert.ok((await response.text()).includes('data-served'), `SSR HTML for ${path}`)
  }
  const home = await page.goto(origin + '/', { waitUntil: 'domcontentloaded' })
  assert.equal(home?.status(), 200, 'homepage must render before any browser code')
  const homeHtml = await home!.text()
  assert.ok(homeHtml.includes('data-served') && homeHtml.includes('home-championships'))
  await page.waitForFunction(() => document.querySelector('.shell-screen:not([data-served]) .home-championships'), undefined, { timeout: 60_000 })
  const players = await page.goto(origin + '/en/players', { waitUntil: 'domcontentloaded' })
  assert.equal(players?.status(), 200)
  const playerHtml = await players!.text()
  assert.ok(playerHtml.includes('Harry Kane') && playerHtml.includes('data-served'))
  await page.waitForFunction(() => document.querySelector('.shell-screen:not([data-served]) #players-directory-q'), undefined, { timeout: 60_000 })
  const firstRow = page.locator('tbody[data-live="player_directory"] tr').first()
  const initial = await firstRow.textContent()
  await page.locator('#players-directory-next').click()
  await page.waitForFunction(() => document.querySelector('.page-status b')?.textContent === '2')
  await page.waitForFunction(before => document.querySelector('tbody[data-live="player_directory"] tr')?.textContent !== before, initial)
  await page.locator('#players-directory-q').fill('Kane')
  await page.waitForFunction(() => {
    const text = document.querySelector('tbody[data-live="player_directory"]')?.textContent
    return text?.includes('Harry Kane') && !text.includes('Haaland')
  }, undefined, { timeout: 60_000 })
  const flamengo = await page.goto(origin + '/equipe-campeonato/flamengo-rj/brazil-campeonato-brasileiro-2026', { waitUntil: 'domcontentloaded' })
  assert.equal(flamengo?.status(), 200)
  const teamHtml = await flamengo!.text()
  assert.ok(teamHtml.includes('Flamengo') && teamHtml.includes('data-served'))
  assert.ok(teamHtml.includes('<html lang="en-GB"'))
  await page.waitForFunction(() => document.querySelector('.shell-screen:not([data-served]) .position-odds-graph svg'), undefined, { timeout: 60_000 })
  const chart = page.locator('.position-odds-graph svg').first()
  await chart.scrollIntoViewIfNeeded()
  await page.waitForTimeout(1000)
  const beforeHover = reads.length
  const box = await chart.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + 5, box.y + box.height / 2)
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 40 })
  await page.waitForTimeout(500)
  assert.equal(reads.length - beforeHover, 0, 'chart hover must not issue CRUD reads')
  assert.deepEqual(errors, [])
  const result = { origin, date: new Date().toISOString(), publicRoutes, home: { publicHtml: true, adoption: true }, players: { publicHtml: true, search: true, pagination: true }, flamengo: { publicHtml: true, negotiatedLocale: true, hoverReads: 0 }, errors }
  await Deno.writeTextFile(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
}
