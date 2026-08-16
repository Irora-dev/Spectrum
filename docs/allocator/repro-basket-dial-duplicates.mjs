import { open, goto } from './lib.mjs'
const { browser, page } = await open({ width: 1440, height: 1100, scale: 2 })
await goto(page, '/portfolio?demo=1', 7000)
await page.getByRole('button', { name: /rebalance/i }).first().click().catch(()=>{})
await page.waitForTimeout(2500)
const scope = page.locator('[role="dialog"]').first()
const ids = async () => scope.locator('[title]').evaluateAll(els =>
  els.map(e => e.getAttribute('title')).filter(x => /^[^·]+ · [\d.]+%$/.test(x||'')).map(t => t.split(' · ')[0]))
const t = scope.locator('[title^="DEVBKT"]').first()
const box = await t.boundingBox()
await page.mouse.click(box.x + box.width/2, box.y + box.height/2)
await page.waitForTimeout(1200)
const a = await ids(); console.log('after select:', a.length)

// 1) TYPE character by character, like a human
const dial = scope.locator('input[inputmode="decimal"]').first()
await dial.click({ clickCount: 3 })
await dial.pressSequentially('98765', { delay: 90 })
await page.waitForTimeout(1500)
const b = await ids(); console.log('after typing:', b.length)

// 2) DRAG the slider
const sl = scope.locator('input[type="range"]').first()
console.log('range inputs:', await sl.count())
const sb = await sl.boundingBox().catch(()=>null)
if (sb) {
  await page.mouse.move(sb.x + sb.width*0.5, sb.y + sb.height/2)
  await page.mouse.down()
  for (let i=5;i<=95;i+=6){ await page.mouse.move(sb.x + sb.width*(i/100), sb.y + sb.height/2); await page.waitForTimeout(35) }
  await page.mouse.up()
}
await page.waitForTimeout(1800)
const c = await ids(); console.log('after slider:', c.length)
const cnt = arr => arr.reduce((m,x)=>(m[x]=(m[x]||0)+1,m),{})
const ca=cnt(a), cc=cnt(c)
for (const k of new Set([...Object.keys(ca),...Object.keys(cc)])) if ((ca[k]||0)!==(cc[k]||0)) console.log('CHANGED', k, ca[k]||0,'->',cc[k]||0)
await page.screenshot({ path:'bb3.png' })
await browser.close()
