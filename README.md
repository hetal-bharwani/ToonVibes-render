# ToonVibes - CapCut Render Automation

This repo contains the Puppeteer script and GitHub Actions workflow to automate CapCut web rendering for ToonVibes.

## Files
- `capcut-automate.js` — Puppeteer automation script (reads GitHub dispatch client_payload)
- `.github/workflows/capcut-render.yml` — GitHub Actions workflow that runs the script
- `package.json` — Node dependencies

## Setup
1. Create a GitHub repo and push these files.
2. In GitHub repo Settings → Secrets → Actions add:
   - `CAPCUT_EMAIL`
   - `CAPCUT_PASSWORD`
   - `GDRIVE_SERVICE_ACCOUNT_KEY` (optional, JSON)
3. In n8n create an HTTP Request node to call the repository dispatch endpoint:
   `POST https://api.github.com/repos/<OWNER>/<REPO>/dispatches`
   with header `Authorization: token <PAT>` and the JSON body shown in the n8n node example.
4. Confirm GitHub Actions runs and check logs.

## Debugging
- To debug locally, run `node capcut-automate.js` after setting `GITHUB_EVENT_PATH` to a test payload file.
- Run with `headless:false` in the script to watch the browser.
