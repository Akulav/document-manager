; e-Management ANSC - Inno Setup script. Made by Akulav.
; One file installs the app the first time and updates it later:
;   * first run: asks for the install folder (the program AND its data - database, uploaded files - go there,
;     in {app}\data)
;   * later runs and in-app updates (/UPDATE): reuse the remembered folder without asking
; Build: iscc /DAppVersion=X.Y.Z /DSourceExe=path\to\eManagement.exe installer\emanagement.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceExe
  #define SourceExe "..\dist\eManagement.exe"
#endif

#define AppName "e-Management ANSC"
#define AppExe "eManagement.exe"
#define SetupName "eManagement-setup"
; Marks the install folder (src/install.js: MARKER).
#define Marker ".emanagement-install"

[Setup]
; AppId never changes: installing over an existing copy upgrades it in place, in the same folder.
AppId={{3B0F5D8E-6C1A-4F7B-9E2D-8A4C5B1E7D93}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Akulav
AppPublisherURL=https://github.com/Akulav/document-manager
AppSupportURL=https://github.com/Akulav/document-manager/issues
AppUpdatesURL=https://github.com/Akulav/document-manager/releases
AppCopyright=Made by Akulav
VersionInfoVersion={#AppVersion}
VersionInfoCompany=Akulav
VersionInfoDescription={#AppName} Setup
VersionInfoProductName={#AppName}
; Per-user install by default: no administrator rights needed (a folder like C:\eManagement works too).
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={localappdata}\Programs\eManagement
; Ask for the folder on the first install only; updates reuse the previous one.
DisableDirPage=auto
UsePreviousAppDir=yes
DirExistsWarning=no
DisableProgramGroupPage=yes
DefaultGroupName={#AppName}
OutputBaseFilename={#SetupName}
OutputDir=..\dist
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
CloseApplications=force
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/ultra64
SolidCompression=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
english.LaunchApp=Launch e-Management ANSC
english.DataNote=The program and its data (database, uploaded files) will be stored in this folder only.
english.DeleteData=Also delete the data (the database and every uploaded file)?%n%nChoose No to keep them for a future reinstall.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
Type: files; Name: "{app}\eManagement.exe.old"

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "{#AppExe}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Comment: "Sistem intern de management al documentelor - made by Akulav"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Comment: "Sistem intern de management al documentelor - made by Akulav"; Tasks: desktopicon

[Run]
; Interactive install: the usual "Launch" checkbox (starts the server and opens the app in the browser).
Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent
; Silent in-app update (/UPDATE): start the new server again, without opening a browser.
Filename: "{app}\{#AppExe}"; Parameters: "--after-update"; WorkingDir: "{app}"; Flags: nowait; Check: IsUpdate

[UninstallDelete]
Type: files; Name: "{app}\{#Marker}"
Type: files; Name: "{app}\eManagement.exe.old"
; The setup of an in-app update (kept in the app's own folder, never in %TEMP%).
Type: filesandordirs; Name: "{app}\data\update"

[Code]
function IsUpdate(): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/UPDATE') = 0 then
      Result := True;
end;

procedure InitializeWizard();
begin
  WizardForm.SelectDirLabel.Caption := WizardForm.SelectDirLabel.Caption + #13#10 + CustomMessage('DataNote');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\{#Marker}'), '{#AppVersion}', False);
end;

{ A running server from this folder is stopped before its program is removed. }
procedure StopRunning();
var
  Code: Integer;
begin
  Exec('powershell.exe',
       '-NoProfile -NonInteractive -Command "Get-Process eManagement -ErrorAction SilentlyContinue | ' +
       'Where-Object { $_.Path -eq ''' + ExpandConstant('{app}') + '\{#AppExe}'' } | Stop-Process -Force"',
       '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(1000);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDir: String;
begin
  if CurUninstallStep = usUninstall then
    StopRunning();
  if CurUninstallStep = usPostUninstall then
  begin
    AppDir := ExpandConstant('{app}');
    { Never delete data when silent; only the app's own data folder, never anything else kept there. }
    if (not UninstallSilent) and DirExists(AppDir + '\data') then
      if MsgBox(CustomMessage('DeleteData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(AppDir + '\data', True, True, True);
    RemoveDir(AppDir);
  end;
end;
