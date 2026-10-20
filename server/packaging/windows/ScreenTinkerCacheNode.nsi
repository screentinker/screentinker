; ScreenTinker studio cache node: a local replica of a ScreenTinker server, run as a Windows service.
; NSIS 3 (zlib/libpng licence). Built by build.ps1, which passes VERSION, VERSION_NUMERIC, STAGE_DIR
; and OUTPUT_DIR. Only plugins and headers that ship with NSIS are used (MUI2, nsDialogs, FileFunc,
; TextFunc, x64, nsExec, System), so a stock NSIS install builds it.
;
; The wizard asks for what a studio is given by whoever runs the main server (docs: README.md):
;   main server address, invite code, shared secret, cache size, port, data folder.
; The same values can be passed for a silent install (by us or a partner):
;   ScreenTinker-CacheNode-Setup-X.Y.Z.exe /S /PRIMARY_URL=https://... /JOIN_CODE=ABCDE-FGHJK
;       /JWT_SECRET=... [/CACHE_GB=100] [/PORT=3001] [/PLAYERS=1] [/DATADIR=D:\ScreenTinker]
; A silent install with a missing or bad value changes nothing and exits 2; a service that did not
; start exits 3. An upgrade (settings file already present) asks nothing and keeps the settings, the
; copy and the cache.

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VERSION_NUMERIC
  !define VERSION_NUMERIC "0.0.0"
!endif

!define APP "ScreenTinker Cache Node"
!define SVC "ScreenTinkerCacheNode"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SVC}"
!define FW_RULE "ScreenTinker Cache Node"

Unicode true
ManifestDPIAware true
RequestExecutionLevel admin
SetCompressor /SOLID lzma
Name "${APP}"
OutFile "${OUTPUT_DIR}\ScreenTinker-CacheNode-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\${APP}"
BrandingText "ScreenTinker ${VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION_NUMERIC}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION_NUMERIC}.0"
VIAddVersionKey "FileDescription" "${APP} setup"
VIAddVersionKey "CompanyName" "ScreenTinker"
VIAddVersionKey "LegalCopyright" "ScreenTinker"

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"
!include "x64.nsh"

Var PrimaryUrl
Var JoinCode
Var Secret
Var CacheGb
Var Port
Var Players
Var DataDir
Var Upgrade
Var EnvFile
Var Problem
; page controls
Var hUrl
Var hCode
Var hSecret
Var hGb
Var hPort
Var hPlayers
Var hDir

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open the status page"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenStatus

!insertmacro MUI_PAGE_WELCOME
Page custom ServerPage ServerLeave
Page custom StoragePage StorageLeave
Page custom ScreensPage ScreensLeave
Page custom DataPage DataLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------- start-up

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${APP} needs 64-bit Windows 10 or 11." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
  StrCpy $EnvFile "$APPDATA\ScreenTinker\screentinker.env"
  ${If} ${FileExists} "$EnvFile"
    StrCpy $Upgrade 1
  ${Else}
    StrCpy $Upgrade 0
  ${EndIf}

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/PRIMARY_URL=" $PrimaryUrl
  ${GetOptions} $R0 "/JOIN_CODE=" $JoinCode
  ${GetOptions} $R0 "/JWT_SECRET=" $Secret
  ${GetOptions} $R0 "/CACHE_GB=" $CacheGb
  ${GetOptions} $R0 "/PORT=" $Port
  ${GetOptions} $R0 "/PLAYERS=" $Players
  ${GetOptions} $R0 "/DATADIR=" $DataDir
  ClearErrors
  StrCmp $CacheGb "" 0 +2
    StrCpy $CacheGb 100
  StrCmp $Port "" 0 +2
    StrCpy $Port 3001
  StrCmp $DataDir "" 0 +2
    StrCpy $DataDir "$APPDATA\ScreenTinker\data"

  ${If} $Upgrade == 1
    Call ReadPort
  ${EndIf}

  ; A silent install skips the pages, so the same checks run here before anything is copied.
  ${If} ${Silent}
  ${AndIf} $Upgrade == 0
    Call Validate
    ${If} $Problem != ""
      DetailPrint "$Problem"
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

; The port in the settings file, for the firewall rule and the status shortcut on an upgrade.
Function ReadPort
  ClearErrors
  FileOpen $0 "$EnvFile" r
  IfErrors done
  loop:
    FileRead $0 $1
    IfErrors close
    ${TrimNewLines} "$1" $1
    StrCpy $2 $1 5
    StrCmp $2 "PORT=" 0 loop
    StrCpy $Port $1 "" 5
    Goto loop
  close:
    FileClose $0
  done:
FunctionEnd

; Each check sets $Problem to a message, or "" when its values are usable. Validate runs all three.
Function Validate
  Call ValidateServer
  StrCmp $Problem "" 0 +2
    Call ValidateStorage
  StrCmp $Problem "" 0 +2
    Call ValidateData
FunctionEnd

Function ValidateServer
  StrCpy $Problem ""
  ; strip trailing slashes from the address
  slash:
    StrCpy $0 $PrimaryUrl "" -1
    StrCmp $0 "/" 0 +3
      StrCpy $PrimaryUrl $PrimaryUrl -1
      Goto slash
  StrCpy $0 $PrimaryUrl 8
  StrCpy $1 $PrimaryUrl 7
  ${If} $0 != "https://"
  ${AndIf} $1 != "http://"
    StrCpy $Problem "Enter the main server address, starting with https:// (or http://)."
    Return
  ${EndIf}
  StrLen $0 $JoinCode
  ${If} $0 < 10
    StrCpy $Problem "Enter the invite code from the main server."
    Return
  ${EndIf}
  StrLen $0 $Secret
  ${If} $0 < 32
    StrCpy $Problem "The shared secret must be the main server's JWT_SECRET (at least 32 characters)."
    Return
  ${EndIf}
FunctionEnd

Function ValidateStorage
  StrCpy $Problem ""
  IntOp $0 $CacheGb + 0
  ${If} "$0" != "$CacheGb"
  ${OrIf} $0 < 1
    StrCpy $Problem "Enter the media cache size as a whole number of GB (at least 1)."
    Return
  ${EndIf}
  IntOp $0 $Port + 0
  ${If} "$0" != "$Port"
  ${OrIf} $0 < 1
  ${OrIf} $0 > 65535
    StrCpy $Problem "Enter a port between 1 and 65535."
    Return
  ${EndIf}
FunctionEnd

Function ValidateData
  StrCpy $Problem ""
  ${If} $DataDir == ""
    StrCpy $Problem "Choose a folder for the copy and the media cache."
    Return
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- pages (skipped on an upgrade)

Function ServerPage
  StrCmp $Upgrade 1 0 +2
    Abort
  !insertmacro MUI_HEADER_TEXT "Main server" "Which ScreenTinker server should this PC copy?"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Whoever runs your main ScreenTinker server gives you these three things. The invite is created on that server under Servers > Create a replica invite."
  ${NSD_CreateLabel} 0 30u 100% 10u "Main server address (for example https://signage.example.com):"
  ${NSD_CreateText} 0 41u 100% 12u "$PrimaryUrl"
  Pop $hUrl
  ${NSD_CreateLabel} 0 60u 100% 10u "Invite code:"
  ${NSD_CreateText} 0 71u 100% 12u "$JoinCode"
  Pop $hCode
  ${NSD_CreateLabel} 0 90u 100% 10u "Shared secret (JWT_SECRET of the main server):"
  ${NSD_CreatePassword} 0 101u 100% 12u "$Secret"
  Pop $hSecret
  nsDialogs::Show
FunctionEnd

Function ServerLeave
  ${NSD_GetText} $hUrl $PrimaryUrl
  ${NSD_GetText} $hCode $JoinCode
  ${NSD_GetText} $hSecret $Secret
  Call ValidateServer
  ${If} $Problem != ""
    MessageBox MB_ICONEXCLAMATION "$Problem"
    Abort
  ${EndIf}
FunctionEnd

Function StoragePage
  StrCmp $Upgrade 1 0 +2
    Abort
  !insertmacro MUI_HEADER_TEXT "Storage and network" "How much disk may the copy of the media use?"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Files the playlists still use are always kept; the least recently used of the rest are removed to stay under this size."
  ${NSD_CreateLabel} 0 30u 100% 10u "Media cache size in GB:"
  ${NSD_CreateNumber} 0 41u 60u 12u "$CacheGb"
  Pop $hGb
  ${NSD_CreateLabel} 0 60u 100% 10u "Port screens on this network connect to:"
  ${NSD_CreateNumber} 0 71u 60u 12u "$Port"
  Pop $hPort
  nsDialogs::Show
FunctionEnd

Function StorageLeave
  ${NSD_GetText} $hGb $CacheGb
  ${NSD_GetText} $hPort $Port
  Call ValidateStorage
  ${If} $Problem != ""
    MessageBox MB_ICONEXCLAMATION "$Problem"
    Abort
  ${EndIf}
FunctionEnd

Function ScreensPage
  StrCmp $Upgrade 1 0 +2
    Abort
  !insertmacro MUI_HEADER_TEXT "Screens" "Should screens in this studio connect to this PC?"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "If they do, they keep playing and can still be set up while the internet is down. Whoever runs the main server must then allow it there (What this server may change)."
  ${NSD_CreateCheckbox} 0 44u 100% 12u "Let screens connect to this PC"
  Pop $hPlayers
  ${If} $Players == 1
    ${NSD_Check} $hPlayers
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ScreensLeave
  ${NSD_GetState} $hPlayers $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Players 1
  ${Else}
    StrCpy $Players 0
  ${EndIf}
FunctionEnd

Function DataPage
  StrCmp $Upgrade 1 0 +2
    Abort
  !insertmacro MUI_HEADER_TEXT "Data folder" "Where should the copy and the media cache be kept?"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Choose a drive with room for the media cache. The folder is kept if the cache node is uninstalled."
  ${NSD_CreateDirRequest} 0 30u 240u 12u "$DataDir"
  Pop $hDir
  ${NSD_CreateBrowseButton} 245u 29u 50u 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 BrowseData
  nsDialogs::Show
FunctionEnd

Function BrowseData
  ${NSD_GetText} $hDir $0
  nsDialogs::SelectFolderDialog "Folder for the copy and the media cache" "$0"
  Pop $0
  StrCmp $0 "error" +2
    ${NSD_SetText} $hDir "$0"
FunctionEnd

Function DataLeave
  ${NSD_GetText} $hDir $DataDir
  Call ValidateData
  ${If} $Problem != ""
    MessageBox MB_ICONEXCLAMATION "$Problem"
    Abort
  ${EndIf}
FunctionEnd

Function OpenStatus
  ExecShell "open" "$SMPROGRAMS\${APP} status.url"
FunctionEnd

; ---------------------------------------------------------------- install

Function WriteSettings
  ${If} $Players == 1
    StrCpy $R1 "caches-content,terminates-players"
  ${Else}
    StrCpy $R1 "caches-content"
  ${EndIf}
  ; GB to bytes needs 64-bit arithmetic (100 GB is past IntOp's 32 bits)
  System::Int64Op $CacheGb * 1073741824
  Pop $R2
  CreateDirectory "$DataDir"
  ClearErrors
  FileOpen $0 "$EnvFile" w
  ${If} ${Errors}
    Abort "Could not write $EnvFile"
  ${EndIf}
  FileWrite $0 "# ScreenTinker cache node settings, written by the installer.$\r$\n"
  FileWrite $0 "# Edit, then restart the $\"${APP}$\" service (services.msc).$\r$\n"
  FileWrite $0 "# Holds JWT_SECRET: readable only by Administrators and SYSTEM. Keep it that way.$\r$\n"
  FileWrite $0 "$\r$\n"
  FileWrite $0 "NODE_ENV=production$\r$\n"
  FileWrite $0 "# Screens on this network connect to http://<this PC>:PORT$\r$\n"
  FileWrite $0 "PORT=$Port$\r$\n"
  FileWrite $0 "# The copy (database) and the media cache live here.$\r$\n"
  FileWrite $0 "DATA_DIR=$DataDir$\r$\n"
  FileWrite $0 "SELF_HOSTED=true$\r$\n"
  FileWrite $0 "$\r$\n"
  FileWrite $0 "# This PC is a replica of the main server below. It connects OUT to it; nothing needs to reach this PC.$\r$\n"
  FileWrite $0 "MESH_ACCEPT_ENROLLMENT=true$\r$\n"
  FileWrite $0 "PRIMARY_URL=$PrimaryUrl$\r$\n"
  FileWrite $0 "# Must equal the main server's JWT_SECRET: a login there works here.$\r$\n"
  FileWrite $0 "JWT_SECRET=$Secret$\r$\n"
  FileWrite $0 "# Used once, at first start, to join the main server. Harmless afterwards (single use).$\r$\n"
  FileWrite $0 "REPLICA_JOIN_CODE=$JoinCode$\r$\n"
  FileWrite $0 "# Roles taken on at the join: keep media copies here; terminates-players lets screens connect to this PC.$\r$\n"
  FileWrite $0 "REPLICA_JOIN_ROLES=$R1$\r$\n"
  FileWrite $0 "# Media cache size in bytes ($CacheGb GB).$\r$\n"
  FileWrite $0 "REPLICA_CACHE_BYTES=$R2$\r$\n"
  FileClose $0
  ; Administrators and SYSTEM only: the file holds the secret that signs every login.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$EnvFile" /inheritance:r /grant:r *S-1-5-32-544:F *S-1-5-18:F'
  Pop $0
  ${If} $0 != 0
    Abort "Could not restrict access to $EnvFile (icacls $0)"
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  ; Upgrade: stop the running service so its files can be replaced. Harmless when it is not installed.
  ${If} ${FileExists} "$INSTDIR\${SVC}.exe"
    DetailPrint "Stopping the service"
    nsExec::ExecToLog '"$INSTDIR\${SVC}.exe" stop'
    Pop $0
  ${EndIf}

  File /r "${STAGE_DIR}\*"

  CreateDirectory "$APPDATA\ScreenTinker"
  CreateDirectory "$APPDATA\ScreenTinker\logs"
  ${If} $Upgrade == 0
    Call WriteSettings
  ${EndIf}

  ; A plain .url shortcut, so the status page opens in whatever browser the studio uses.
  WriteINIStr "$SMPROGRAMS\${APP} status.url" "InternetShortcut" "URL" "http://localhost:$Port/cache-node.html"
  CreateShortcut "$SMPROGRAMS\${APP} logs.lnk" "$APPDATA\ScreenTinker\logs"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "ScreenTinker"
  WriteRegStr HKLM "${UNINST_KEY}" "URLInfoAbout" "https://screentinker.com"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" $0

  ; install fails harmlessly when the service already exists (upgrade).
  DetailPrint "Registering the service"
  nsExec::ExecToLog '"$INSTDIR\${SVC}.exe" install'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FW_RULE}"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${FW_RULE}" dir=in action=allow protocol=TCP localport=$Port profile=private,domain'
  Pop $0
  DetailPrint "Starting the service"
  nsExec::ExecToLog '"$INSTDIR\${SVC}.exe" start'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "The ${APP} service did not start. See the logs in $APPDATA\ScreenTinker\logs." /SD IDOK
    SetErrorLevel 3
  ${EndIf}
SectionEnd

; ---------------------------------------------------------------- uninstall
; The settings, the copy and the cached media in ProgramData are KEPT, so a reinstall picks up where
; it left off. README.md says how to remove them.

Function un.onInit
  SetRegView 64
  SetShellVarContext all
FunctionEnd

Section "Uninstall"
  nsExec::ExecToLog '"$INSTDIR\${SVC}.exe" stop'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\${SVC}.exe" uninstall'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FW_RULE}"'
  Pop $0
  Delete "$SMPROGRAMS\${APP} status.url"
  Delete "$SMPROGRAMS\${APP} logs.lnk"
  DeleteRegKey HKLM "${UNINST_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
