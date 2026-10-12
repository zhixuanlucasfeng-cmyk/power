[Setup]
AppId={{4EA4E6B9-DF75-4679-A9C7-1B069A48F37C}
AppName=Power
AppVersion=0.4.0
AppPublisher=Power contributors
AppPublisherURL=https://github.com/zhixuanlucasfeng-cmyk/power
DefaultDirName={localappdata}\Programs\Power
DefaultGroupName=Power
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=Power-Setup-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\Power.exe
CloseApplications=yes
RestartApplications=no
LicenseFile=..\..\LICENSE

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\..\dist\Power-Windows-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Power"; Filename: "{app}\Power.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Power"; Filename: "{app}\Power.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Power.exe"; Description: "Launch Power"; Flags: nowait postinstall skipifsilent
