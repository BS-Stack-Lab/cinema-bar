#ifndef AppVersion
  #error AppVersion must be supplied from package.json
#endif

[Setup]
AppId=dev.cinemabar.desktop
AppName=Cinema Bar
AppVersion={#AppVersion}
AppPublisher=BS-Stack-Lab
DefaultDirName={localappdata}\Programs\Cinema Bar
DefaultGroupName=Cinema Bar
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
DisableProgramGroupPage=yes
OutputDir=..\release\windows-release
OutputBaseFilename=Cinema-Bar-{#AppVersion}-Windows-x64-Setup
SetupIconFile=..\assets\appIcon.ico
UninstallDisplayName=Cinema Bar
UninstallDisplayIcon={app}\Cinema Bar.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\release\Cinema Bar-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Cinema Bar"; Filename: "{app}\Cinema Bar.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\Cinema Bar"; Filename: "{app}\Cinema Bar.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Cinema Bar.exe"; Description: "Launch Cinema Bar"; Flags: nowait postinstall skipifsilent
