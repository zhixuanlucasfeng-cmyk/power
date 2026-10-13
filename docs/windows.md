# Power for Windows (preview)

Windows x64 uses the same Electron desktop and shared browser tabs as macOS.

## Download and launch

Download **Power-Setup-x64.exe** from the [Windows installer release](https://github.com/zhixuanlucasfeng-cmyk/power/releases/tag/v0.4.0-windows-preview.3). This is a public download. Development builds are also available as artifacts of successful [Windows builds](https://github.com/zhixuanlucasfeng-cmyk/power/actions/workflows/windows.yml); those artifact downloads require GitHub sign-in.

Run the installer, then open **Power** from the Start menu or desktop shortcut. Installation is per-user and does not require administrator access. The package includes Node and Electron. Uninstall Power through Windows Settings; chats and browser sessions are retained. The optional portable ZIP can still be extracted and launched with **Power.exe** or **Power.cmd**. The launcher starts the local Power server, opens the desktop and stops its server when the app exits. Background schedules therefore require keeping Power running. This preview installer is unsigned; Windows may display an unknown-publisher warning.

On first launch, follow **Install → Sign in → Test → Start chatting** to install official Codex and connect your own ChatGPT account. No terminal or separate npm installation is needed. If browser sign-in fails, choose the device-code fallback. The test sends one short model request using your account allowance. Reopen the wizard with **配置 Agent / Setup**. Power does not include a subscription; other agent CLIs still require separate installation and login. Native Windows `.exe`, `.cmd` and `.bat` agent commands are detected on PATH. WSL-only CLIs are not automatically bridged into the Windows app.

Use **Browser → +** to open a tab. Log in directly on the website, then return control to the agent. Browser sessions stay in `%USERPROFILE%\.power\desktop`; app data stays in `%USERPROFILE%\.power`. To reuse sites already signed in through Google in your normal Chrome, select **My Chrome · Existing logins**, install the linked Playwright extension, then connect and approve the tabs Power may use. Power and the agent use those approved Chrome tabs without copying passwords or cookies. The embedded browser keeps its own separate login session.

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

The Windows CI workflow also compiles the graphical launcher with the .NET Framework C# compiler and builds `Power-Setup-x64.exe` using Inno Setup 6. It installs the package, launches the installed app, verifies the Start menu shortcut and browser, then uninstalls and checks that user data is preserved.
