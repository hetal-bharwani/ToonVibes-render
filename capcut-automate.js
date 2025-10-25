/**
 * capcut-automate.js
 * Puppeteer automation for CapCut web editor.
 *
 * Inputs via `github.event.client_payload` (GitHub Actions repository_dispatch)
 * payload example:
 * {
 *   "projectName":"TV-20251021-001",
 *   "template":"hybrid_action_meme_v2",          // optional, for selecting template in UI
 *   "assetUrls": ["https://drive.google.com/uc?export=download&id=..."],
 *   "scriptText":"[ {time:0, text:'Hook'}, ... ]", // or plain text block
 *   "sfx":["boing.mp3","recordscratch.mp3"],     // optional: sfx names to add
 *   "outputName":"TV-20251021-001.mp4"
 * }
 *
 * Notes:
 *  - You must inspect CapCut web UI and update selectors below if they change.
 *  - For file uploads, we download assets first to /tmp and then attach to the file input.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core'); // using installed chrome in GH Actions
const fetch = require('node-fetch');
const { execSync } = require('child_process');

(async () => {
  // GitHub Actions delivers the payload via env var GITHUB_EVENT_PATH
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error('GITHUB_EVENT_PATH env var missing. Are you running in GH Actions?');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8')).client_payload || {};
  if (!payload || !payload.assetUrls) {
    console.error('Payload missing required fields. Example: assetUrls[]');
    process.exit(1);
  }

  // Config from secrets (set these in GH repo secrets)
  const CAPCUT_EMAIL = process.env.CAPCUT_EMAIL;
  const CAPCUT_PASSWORD = process.env.CAPCUT_PASSWORD;
  const CHROME_EXEC = process.env.CHROME_EXEC || '/usr/bin/google-chrome-stable';
  const OUTPUT_NAME = payload.outputName || `capcut_export_${Date.now()}.mp4`;

  // download assets to /tmp
  const tmpDir = '/tmp/capcut_assets';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  console.log('Downloading assets...');
  const localFiles = [];
  for (let i = 0; i < payload.assetUrls.length; i++) {
    const url = payload.assetUrls[i];
    const filename = path.join(tmpDir, `asset_${i}${path.extname(url).split('?')[0] || '.mp4'}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Failed to download asset', url, res.status);
      process.exit(1);
    }
    const buffer = await res.buffer();
    fs.writeFileSync(filename, buffer);
    localFiles.push(filename);
    console.log('Saved', filename);
  }

  // Puppeteer launch config for GH Actions runner (needs --no-sandbox)
  const browser = await puppeteer.launch({
    executablePath: CHROME_EXEC,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--disable-gpu',
      '--window-size=1280,800'
    ],
    headless: true
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // 1) Go to CapCut web
  console.log('Navigating to CapCut...');
  await page.goto('https://www.capcut.com/tools/editor', { waitUntil: 'networkidle2' });

  // 2) Log in (simple flow) - selectors WILL change; inspect and update as needed.
  try {
    // click login button
    await page.waitForSelector('button[data-testid="login-btn"], a[href*="login"]', { timeout: 8000 });
    await page.click('button[data-testid="login-btn"], a[href*="login"]');
    await page.waitForTimeout(2000);
  } catch (err) {
    console.warn('Login button not found; continuing if already logged in.');
  }

  // if email/password fields exist, attempt an email login
  const emailSel = 'input[type="email"], input[name="email"]';
  const pwSel = 'input[type="password"], input[name="password"]';
  try {
    const emailExists = await page.$(emailSel);
    if (emailExists && CAPCUT_EMAIL && CAPCUT_PASSWORD) {
      console.log('Performing email login...');
      await page.type(emailSel, CAPCUT_EMAIL, { delay: 50 });
      await page.type(pwSel, CAPCUT_PASSWORD, { delay: 50 });
      // find and click submit
      const submitBtn = await page.$('button[type="submit"], button[data-testid="submit"]');
      if (submitBtn) await submitBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
      console.log('Login done.');
    } else {
      console.log('Email login not available or credentials missing; ensure account is logged in or provide cookies.');
    }
  } catch (err) {
    console.warn('Login attempt failed; continuing — ensure session is active or update selectors.');
  }

  // 3) Create new project from scratch or from a template
  // NOTE: CapCut web templates UI is dynamic — below is a generalized flow:
  try {
    // click New Project or Use Template - update selector as needed
    await page.waitForTimeout(1500);
    const newBtn = await page.$x("//button[contains(., 'New Project') or contains(., 'Create')]");
    if (newBtn.length) {
      await newBtn[0].click();
      await page.waitForTimeout(1200);
    } else {
      console.log('New Project button not found by XPath; try alternative flows.');
    }
  } catch (err) {
    console.warn('Create project step may require manual setup in UI.');
  }

  // 4) Upload local files using file input
  // Find the file <input type=file> and upload all assets
  try {
    // the site usually has an <input type=file>; try common selectors
    const fileInput = await page.$('input[type=file]');
    if (!fileInput) {
      // try opening upload dialog by clicking an "Upload" button (text may vary)
      const uploadBtn = await page.$x("//button[contains(translate(., 'UPLOAD', 'upload'), 'upload') or contains(., 'Import')]");
      if (uploadBtn.length) {
        await uploadBtn[0].click();
        await page.waitForTimeout(800);
      }
    }
    // now query again for file input
    const fileInput2 = await page.$('input[type=file]');
    if (!fileInput2) {
      throw new Error('Unable to find file input element on page. Inspect CapCut and update script selector.');
    }
    // upload all files
    await fileInput2.uploadFile(...localFiles);
    console.log('Uploaded local files to CapCut UI.');
  } catch (err) {
    console.error('Upload step failed:', err.message);
    await browser.close();
    process.exit(1);
  }

  // 5) Place clips into timeline and add captions according to payload.scriptText
  // This is the fragile/most manual part: selectors will vary. Below is a skeleton:
  try {
    // wait for uploaded assets to appear as thumbnails then drag them to timeline
    await page.waitForSelector('.asset-thumb, .media-thumb, .thumbnail', { timeout: 10000 });
    const thumbs = await page.$$('.asset-thumb, .media-thumb, .thumbnail');
    console.log('Found thumbnails:', thumbs.length);
    // naive approach: click each thumb to add to timeline (or drag if required)
    for (let i = 0; i < thumbs.length && i < 12; i++) {
      try {
        await thumbs[i].click({ delay: 100 });
        await page.waitForTimeout(400);
      } catch (err) { /* ignore individual failures */ }
    }

    // Add captions: find "Text" button and add text boxes
    if (payload.scriptText) {
      try {
        // open text panel
        const textBtn = await page.$x("//button[contains(., 'Text') or contains(., 'Add text')]");
        if (textBtn.length) {
          await textBtn[0].click();
          await page.waitForTimeout(600);
        }
        // for each caption line, click add and type
        const scriptObj = Array.isArray(payload.scriptText) ? payload.scriptText : JSON.parse(payload.scriptText || '[]');
        let addTextBtn = await page.$x("//button[contains(., 'Add text') or contains(., 'Add') and contains(., 'Text')]");
        for (let i = 0; i < Math.min(6, scriptObj.length); i++) {
          try {
            if (addTextBtn.length) {
              await addTextBtn[0].click();
              await page.waitForTimeout(400);
              // find active text input
              const activeInput = await page.$('textarea, input[role="textbox"], div[contenteditable="true"]');
              if (activeInput) {
                await activeInput.focus();
                await page.keyboard.type(scriptObj[i].text || scriptObj[i], { delay: 20 });
                await page.waitForTimeout(300);
              }
            }
          } catch (err) {
            console.warn('Add text failed for caption', i, err.message);
          }
        }
      } catch (err) {
        console.warn('Caption insertion partially failed. You may need to update selectors.');
      }
    }
  } catch (err) {
    console.warn('Timeline population step had issues:', err.message);
  }

  // 6) Apply SFX & background music (if SFX assets provided)
  // (Implementation depends on the UI — try drag music to timeline or use built-in music panel)
  // For now we skip automated SFX placement to avoid complex UI flows.

  // 7) Render / Export - find Export button and click
  try {
    const exportBtn = await page.$x("//button[contains(., 'Export') or contains(., 'Download')]");
    if (exportBtn.length) {
      await exportBtn[0].click();
      console.log('Clicked Export.');
    } else {
      console.warn('Export button not found; you may need to manually export or update selector.');
    }
  } catch (err) {
    console.warn('Export step failed:', err.message);
  }

  // 8) Poll for download link - check for download link element (example)
  try {
    // Wait up to 120s for export complete
    await page.waitForSelector('a.download-link, button.download', { timeout: 120000 });
    // grab href
    const downloadEl = await page.$('a.download-link, button.download');
    if (downloadEl) {
      const downloadUrl = await page.evaluate(el => el.href || el.getAttribute('data-url'), downloadEl);
      console.log('Export ready at', downloadUrl);
      // download file and save
      const r = await fetch(downloadUrl);
      const buff = await r.buffer();
      const outPath = path.join('/tmp', OUTPUT_NAME);
      fs.writeFileSync(outPath, buff);
      console.log('Saved output to', outPath);

      // optionally upload to Google Drive via service account using gdrive CLI if you configure it,
      // or the GH Action step can pick up this file and push it to Drive via n8n.
      console.log('Done.');
    } else {
      console.warn('Download button found but could not extract URL.');
    }
  } catch (err) {
    console.warn('Export/download polling failed (timeout or selector mismatch).', err.message);
  }

  await browser.close();
  process.exit(0);
})();
