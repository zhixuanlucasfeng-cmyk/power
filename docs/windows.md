# Power for Windows (preview)

Windows x64 uses the same Electron desktop and shared browser tabs as macOS.

## Download and launch

Download **Power-Windows-x64.zip** from the [Windows preview release](https://github.com/zhixuanlucasfeng-cmyk/power/releases/tag/v0.4.0-windows-preview.1). This is a public download. Development builds are also available as artifacts of successful [Windows builds](https://github.com/zhixuanlucasfeng-cmyk/power/actions/workflows/windows.yml); those artifact downloads require GitHub sign-in.

Extract the ZIP fully, open the extracted folder and double-click **Power.cmd**. Keep the files together. The package includes Node and Electron. The launcher starts the local Power server, opens the desktop and stops its server when the app exits. Background schedules therefore require keeping Power running. This preview is not a signed Windows installer.

Install and sign in to the agent CLI you want to use separately. Power does not include anyone else's subscription or login. Native Windows `.exe`, `.cmd` and `.bat` agent commands are detected on PATH. WSL-only CLIs are not automatically bridged into the Windows app.

Use **Browser → +** to open a tab. Log in directly on the website, then return control to the agent. Browser sessions stay in `%USERPROFILE%\.power\desktop`; app data stays in `%USERPROFILE%\.power`. These are separate from normal Chrome logins.

## Run from source

Install Node.js 22.19+ and Git, then:

```powershell
git clone https://github.com/zhixuanlucasfeng-cmyk/power
cd power
.\power.cmd
```

The source launcher runs `npm ci` on first launch. To update, close Power, run `git pull` and `npm ci`, then reopen `power.cmd`.

## Build

On Windows x64, run `npm ci` then `npm run windows:build`. Output: `dist/Power-Windows-x64`. The build copies the local source and installed dependencies; use a clean checkout when distributing it. GitHub Actions tests native tab creation, form input and agent access before uploading the ZIP.

macOS-only integrations such as AppleScript notifications and launchd are not available on Windows. Agent capabilities depend on each provider's Windows CLI support.
