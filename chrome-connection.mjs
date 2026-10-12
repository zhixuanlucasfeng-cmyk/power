// Adapter to the extension bridge shipped with our lockfile-pinned Playwright.
// Keep this dependency in one place: it shares the approved tab group, not cookies.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const extensionInstallURL = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm';
export async function connectExistingChrome(outputDir) {
  const { tools } = require('playwright-core/lib/coreBundle');
  const options = { extension: true, browser: 'chrome', outputDir };
  const config = await tools.resolveCLIConfigForMCP(options, {});
  const { browser } = await tools.createBrowserWithInfo(config,
    {clientName:'Power',clientVersion:'1.0.0',cwd:outputDir},options,
    {title:'Power',workspaceDir:outputDir});
  const context = browser.contexts()[0];
  if (!context) { await browser.close(); throw new Error('Chrome 没有提供可连接的标签页'); }
  // Closing an attached Playwright browser disconnects the CDP transport.
  return {context, disconnect:()=>browser.close()};
}
