import { expect, test } from '@playwright/test'

// The build badge is the only inline stylesheet the app serves, and it sits in
// the root layout, so what it does to the document it does to every page.

test('serves the badge stylesheet as CSS rather than as escaped text',async({page})=>{
  const response=await page.goto('/')
  const html=await response!.text()
  const style=html.match(/<style[^>]*>([\s\S]*?\.portable-version-badge[\s\S]*?)<\/style>/)
  expect(style,'the badge stylesheet is not in the served HTML').toBeTruthy()
  // A <style> element's content is raw text to the HTML parser: it decodes no
  // entities. So a quote that reaches it as &quot; stays six characters long,
  // the font-family declaration around it is not valid CSS, and the browser
  // drops the declaration -- silently, because an invalid declaration is not
  // an error. The badge then loses every fallback font it names.
  expect(style![1]).not.toContain('&quot;')
  expect(style![1]).toContain('"Liberation Mono"')
})

test('hydrates the server-rendered page instead of throwing it away',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('/')
  await expect(page.getByRole('button',{name:'Process',exact:true})).toBeVisible()
  // React compares the text it would render against the text in the document.
  // An escaped stylesheet is text it did not write, so it gives up on the whole
  // root and re-renders it on the client: the server-rendered first paint is
  // discarded, and -- because the failure is at the root, outside any Suspense
  // boundary -- no part of the page keeps the benefit of being rendered ahead.
  expect(errors).toEqual([])
})
