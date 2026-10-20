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
; Exit codes: 0 installed and answering; 2 refused (a bad value, a port in use, a folder that is not
; ours) with the reason in %TEMP%\ScreenTinker-CacheNode-setup.txt; 3 installed but the server did
; not answer (see the logs). An upgrade (a previous install that came up, recorded in HKLM) asks
; nothing and keeps the settings, the copy and the cache.
;
; ⚠️ PERMISSIONS. Any Windows user may create folders in ProgramData, and the service reads its
; settings (NODE_OPTIONS included) from there. So: "upgrade" is decided from HKLM, never from a file
; existing; a ProgramData\ScreenTinker this installer did not leave is refused rather than trusted;
; the folders are locked to Administrators, SYSTEM and the service account BEFORE anything is
; written; and the service runs as LocalService, not LocalSystem.

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
; Written on every install that came up and NOT removed on uninstall: it is how a reinstall knows the
; ProgramData folder (and a custom data folder) it finds were left by us. HKLM: admins only.
!define STATE_KEY "Software\ScreenTinker\CacheNode"
!define SID_ADMINS "*S-1-5-32-544"
!define SID_SYSTEM "*S-1-5-18"
!define SID_SERVICE "*S-1-5-19"

Unicode true
ManifestDPIAware true
RequestExecutionLevel admin
SetCompressor /SOLID lzma
Name "${APP}"
OutFile "${OUTPUT_DIR}\ScreenTinker-CacheNode-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\${APP}"
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
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
!include "WordFunc.nsh"

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
Var Root
Var Healthy
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

Var Args
Var aOpt
Var aVal

; FileFunc's GetOptions is NOT used: it ends a value at the next "/", so /PRIMARY_URL=https://x
; arrived as "https:" (seen on the first silent install). A value here ends at the next " /" or the
; end of the line, and may be "quoted" to hold spaces (/DATADIR="D:\Screen Tinker").
!macro Arg OPT OUT
  StrCpy $aOpt "${OPT}"
  Call ArgValue
  StrCpy ${OUT} $aVal
!macroend

Function ArgValue
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $aVal ""
  StrLen $1 $aOpt
  StrLen $2 $Args
  StrCpy $0 0
  find:
    IntCmp $0 $2 done 0 done
    StrCpy $3 $Args $1 $0
    StrCmp $3 $aOpt 0 next
    ; must start an argument, so /PORT= never matches inside /XPORT=: at the start of the line, after
    ; a space, or after the quote of a wholly quoted argument ("/DATADIR=D:\Screen Tinker")
    IntCmp $0 0 found
    IntOp $3 $0 - 1
    StrCpy $3 $Args 1 $3
    StrCmp $3 " " found
    StrCmp $3 '"' 0 next
    IntCmp $0 1 found
    IntOp $3 $0 - 2
    StrCpy $3 $Args 1 $3
    StrCmp $3 " " found
  next:
    IntOp $0 $0 + 1
    Goto find
  found:
    IntOp $0 $0 + $1
    StrCpy $3 $Args 1 $0
    StrCmp $3 '"' quoted
  plain:
    StrCpy $3 $Args 2 $0
    StrCmp $3 " /" plainend
    StrCpy $3 $Args 3 $0
    StrCmp $3 ' "/' plainend
    StrCpy $3 $Args 1 $0
    StrCmp $3 "" plainend
    StrCpy $aVal "$aVal$3"
    IntOp $0 $0 + 1
    Goto plain
  plainend:
    ; the closing quote of a wholly quoted argument
    StrCpy $3 $aVal 1 -1
    StrCmp $3 '"' 0 done
    StrCpy $aVal $aVal -1
    Goto done
  quoted:
    IntOp $0 $0 + 1
    StrCpy $3 $Args 1 $0
    StrCmp $3 '"' done
    StrCmp $3 "" done
    StrCpy $aVal "$aVal$3"
    Goto quoted
  done:
  ; trailing spaces from the command line are not part of the value
  trim:
    StrCpy $3 $aVal 1 -1
    StrCmp $3 " " 0 +3
      StrCpy $aVal $aVal -1
      Goto trim
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    StrCpy $Problem "${APP} needs 64-bit Windows 10 or 11."
    MessageBox MB_ICONSTOP "$Problem" /SD IDOK
    Call SilentFail
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
  StrCpy $Root "$APPDATA\ScreenTinker"
  StrCpy $EnvFile "$Root\screentinker.env"
  StrCpy $Healthy 0
  ; An upgrade is a previous install that came up (recorded in HKLM) AND still has its settings.
  ReadRegDWORD $0 HKLM "${UNINST_KEY}" "Configured"
  ${If} $0 == 1
  ${AndIf} ${FileExists} "$EnvFile"
    StrCpy $Upgrade 1
  ${Else}
    StrCpy $Upgrade 0
  ${EndIf}

  ${GetParameters} $Args
  !insertmacro Arg "/PRIMARY_URL=" $PrimaryUrl
  !insertmacro Arg "/JOIN_CODE=" $JoinCode
  !insertmacro Arg "/JWT_SECRET=" $Secret
  !insertmacro Arg "/CACHE_GB=" $CacheGb
  !insertmacro Arg "/PORT=" $Port
  !insertmacro Arg "/PLAYERS=" $Players
  !insertmacro Arg "/DATADIR=" $DataDir
  StrCmp $CacheGb "" 0 +2
    StrCpy $CacheGb 100
  StrCmp $Port "" 0 +2
    StrCpy $Port 3001
  StrCmp $DataDir "" 0 +2
    StrCpy $DataDir "$Root\data"
  ${If} $Players == "true"
  ${OrIf} $Players == "yes"
    StrCpy $Players 1
  ${EndIf}

  ${If} $Upgrade == 1
    Call ReadSettings
  ${Else}
    ; ⚠️ A ProgramData\ScreenTinker we did not leave may have been planted by any local user.
    ReadRegStr $0 HKLM "${STATE_KEY}" "DataDir"
    ${If} ${FileExists} "$Root\*.*"
    ${AndIf} $0 == ""
      StrCpy $Problem "$Root already exists, but was not left by this installer. Delete or rename it, then run setup again."
      MessageBox MB_ICONSTOP "$Problem" /SD IDOK
      Call SilentFail
    ${EndIf}
  ${EndIf}

  ; A silent install skips the pages, so the same checks run here before anything is copied.
  ${If} ${Silent}
  ${AndIf} $Upgrade == 0
    Call Validate
    ${If} $Problem != ""
      Call SilentFail
    ${EndIf}
  ${EndIf}
FunctionEnd

; A silent install has nowhere to show $Problem, so it goes to %TEMP%\ScreenTinker-CacheNode-setup.txt
; (README.md says to look there) and the exit code is 2. Nothing else has been changed yet.
Function SilentFail
  Call NoteProblem
  SetErrorLevel 2
  Quit
FunctionEnd

Function NoteProblem
  FileOpen $9 "$TEMP\ScreenTinker-CacheNode-setup.txt" w
  FileWrite $9 "$Problem$\r$\n"
  FileClose $9
FunctionEnd

; Stop the install part-way: the reason is noted for a silent run and shown in the log otherwise.
!macro Fail MSG
  StrCpy $Problem "${MSG}"
  Call NoteProblem
  SetErrorLevel 2
  Abort "$Problem"
!macroend

; The port and whether screens connect, from the settings file, for the firewall rule and shortcut.
Function ReadSettings
  StrCpy $Players 0
  ClearErrors
  FileOpen $0 "$EnvFile" r
  IfErrors done
  loop:
    FileRead $0 $1
    IfErrors close
    ${TrimNewLines} "$1" $1
    StrCpy $2 $1 5
    StrCmp $2 "PORT=" 0 +3
      StrCpy $Port $1 "" 5
      Goto loop
    StrCpy $2 $1 19
    StrCmp $2 "REPLICA_JOIN_ROLES=" 0 loop
    ${WordFind} $1 "terminates-players" "E+1{" $2
    IfErrors +2
      StrCpy $Players 1
    ClearErrors
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

; Values go into the settings file as KEY=value lines. Node cuts an unquoted value at "#" and reads
; a leading quote as the start of a quoted one, so those characters are refused rather than written.
Var cIn
Var cMsg
; Sets $Problem to "$cMsg ..." when $cIn holds a character that cannot be written, else "".
Function RefuseUnsafe
  Push $0
  Push $1
  Push $2
  StrCpy $Problem ""
  StrLen $1 $cIn
  StrCpy $0 0
  StrCpy $2 ""
  loop:
    IntCmp $0 $1 ok 0 ok
    StrCpy $2 $cIn 1 $0
    StrCmp $2 "#" bad
    StrCmp $2 '"' bad
    StrCmp $2 "'" bad
    StrCmp $2 "`" bad
    StrCmp $2 "$\t" bad
    IntOp $0 $0 + 1
    Goto loop
  bad:
    StrCpy $Problem "$cMsg It may not contain # or quote characters."
  ok:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Returns from the calling check when VALUE cannot be written.
!macro Refuse VALUE MSG
  StrCpy $cIn "${VALUE}"
  StrCpy $cMsg "${MSG}"
  Call RefuseUnsafe
  StrCmp $Problem "" +2
    Return
!macroend

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
    StrCpy $Problem "Enter the main server address, starting with https:// (or http://). Got: [$PrimaryUrl]"
    Return
  ${EndIf}
  !insertmacro Refuse $PrimaryUrl "That main server address is not usable."
  StrLen $0 $JoinCode
  ${If} $0 < 10
    StrCpy $Problem "Enter the invite code from the main server."
    Return
  ${EndIf}
  !insertmacro Refuse $JoinCode "That invite code is not usable."
  StrLen $0 $Secret
  ${If} $0 < 32
    StrCpy $Problem "The shared secret must be the main server's JWT_SECRET (at least 32 characters)."
    Return
  ${EndIf}
  !insertmacro Refuse $Secret "That shared secret cannot be written to the settings file."
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
  ; trailing backslashes are not part of the folder
  bs:
    StrCpy $0 $DataDir "" -1
    StrCmp $0 "\" 0 +3
      StrCpy $DataDir $DataDir -1
      Goto bs
  StrCpy $0 $DataDir 1 1
  StrCpy $1 $DataDir 1 2
  StrLen $2 $DataDir
  ${If} $0 != ":"
  ${OrIf} $1 != "\"
  ${OrIf} $2 < 4
    StrCpy $Problem "Choose a folder on a local drive, such as D:\ScreenTinker (not a whole drive)."
    Return
  ${EndIf}
  !insertmacro Refuse $DataDir "That folder name cannot be used."
  ; ⚠️ Its permissions are locked down to this service, so it must be a new or empty folder, or the
  ; one an earlier install of ours used. Never someone's existing folder of files.
  ReadRegStr $1 HKLM "${STATE_KEY}" "DataDir"
  ${If} $1 == $DataDir
    Return
  ${EndIf}
  StrCpy $0 "$Root\data"
  ${If} $0 == $DataDir
  ${AndIf} $1 != ""
    Return
  ${EndIf}
  ${If} ${FileExists} "$DataDir\*.*"
    FindFirst $0 $1 "$DataDir\*.*"
    next:
      StrCmp $1 "" empty
      StrCmp $1 "." skip
      StrCmp $1 ".." skip
      FindClose $0
      StrCpy $Problem "$DataDir is not empty. Choose a new or empty folder for the copy and the media cache."
      Return
    skip:
      FindNext $0 $1
      Goto next
    empty:
    FindClose $0
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
  ${NSD_OnBack} SaveServer
  nsDialogs::Show
FunctionEnd

Function SaveServer
  ${NSD_GetText} $hUrl $PrimaryUrl
  ${NSD_GetText} $hCode $JoinCode
  ${NSD_GetText} $hSecret $Secret
FunctionEnd

Function ServerLeave
  Call SaveServer
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
  ${NSD_CreateLabel} 0 60u 100% 10u "Port for this PC's dashboard and for screens that connect to it:"
  ${NSD_CreateNumber} 0 71u 60u 12u "$Port"
  Pop $hPort
  ${NSD_OnBack} SaveStorage
  nsDialogs::Show
FunctionEnd

Function SaveStorage
  ${NSD_GetText} $hGb $CacheGb
  ${NSD_GetText} $hPort $Port
FunctionEnd

Function StorageLeave
  Call SaveStorage
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
  ${NSD_CreateLabel} 0 0 100% 36u "If they do, they keep playing and can still be set up while the internet is down. Whoever runs the main server must then allow it there (What this server may change). Ticking this also opens the port in Windows Firewall."
  ${NSD_CreateCheckbox} 0 44u 100% 12u "Let screens connect to this PC"
  Pop $hPlayers
  ${If} $Players == 1
    ${NSD_Check} $hPlayers
  ${EndIf}
  ${NSD_OnBack} SaveScreens
  nsDialogs::Show
FunctionEnd

Function SaveScreens
  ${NSD_GetState} $hPlayers $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Players 1
  ${Else}
    StrCpy $Players 0
  ${EndIf}
FunctionEnd

Function ScreensLeave
  Call SaveScreens
FunctionEnd

Function DataPage
  StrCmp $Upgrade 1 0 +2
    Abort
  !insertmacro MUI_HEADER_TEXT "Data folder" "Where should the copy and the media cache be kept?"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Choose a new or empty folder on a drive with room for the media cache. Only this service and administrators can open it. It is kept if the cache node is uninstalled."
  ${NSD_CreateDirRequest} 0 30u 240u 12u "$DataDir"
  Pop $hDir
  ${NSD_CreateBrowseButton} 245u 29u 50u 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 BrowseData
  ${NSD_OnBack} SaveData
  nsDialogs::Show
FunctionEnd

Function BrowseData
  ${NSD_GetText} $hDir $0
  nsDialogs::SelectFolderDialog "Folder for the copy and the media cache" "$0"
  Pop $0
  StrCmp $0 "error" +2
    ${NSD_SetText} $hDir "$0"
FunctionEnd

Function SaveData
  ${NSD_GetText} $hDir $DataDir
FunctionEnd

Function DataLeave
  Call SaveData
  Call ValidateData
  ${If} $Problem != ""
    MessageBox MB_ICONEXCLAMATION "$Problem"
    Abort
  ${EndIf}
FunctionEnd

; Only once the server answered; otherwise the logs, which say why it did not.
Function OpenStatus
  ${If} $Healthy == 1
    ExecShell "open" "$SMPROGRAMS\${APP} status.url"
  ${Else}
    ExecShell "open" "$Root\logs"
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- install

; ⚠️ A folder must be a real folder: a junction planted in its place would send our ACL changes and
; the service's writes somewhere else.
!macro RefuseReparse DIR
  System::Call 'kernel32::GetFileAttributes(t "${DIR}") i .r0'
  ${If} $0 != -1
    IntOp $0 $0 & 0x400
    ${If} $0 != 0
      !insertmacro Fail "${DIR} is a link to another folder, not a folder. Remove it and run setup again."
    ${EndIf}
  ${EndIf}
!macroend

; Run an icacls command; any failure stops the install (a half-locked folder is not acceptable).
!macro Icacls ARGS
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" ${ARGS}'
  Pop $0
  ${If} $0 != 0
    !insertmacro Fail "Could not set folder permissions (icacls exit $0). See the details in this window."
  ${EndIf}
!macroend

; ProgramData\ScreenTinker, its logs and the data folder: Administrators and SYSTEM full control, the
; service account (LocalService) only what it needs. Done BEFORE anything is written into them.
Function LockFolders
  !insertmacro RefuseReparse "$Root"
  CreateDirectory "$Root"
  !insertmacro Icacls '"$Root" /setowner ${SID_ADMINS}'
  !insertmacro Icacls '"$Root" /inheritance:r /grant:r ${SID_ADMINS}:(OI)(CI)F ${SID_SYSTEM}:(OI)(CI)F ${SID_SERVICE}:RX'
  !insertmacro RefuseReparse "$Root\logs"
  CreateDirectory "$Root\logs"
  !insertmacro Icacls '"$Root\logs" /grant:r ${SID_SERVICE}:(OI)(CI)M'
  !insertmacro RefuseReparse "$DataDir"
  CreateDirectory "$DataDir"
  ${IfNot} ${FileExists} "$DataDir\*.*"
    !insertmacro Fail "Could not create $DataDir."
  ${EndIf}
  !insertmacro Icacls '"$DataDir" /setowner ${SID_ADMINS}'
  !insertmacro Icacls '"$DataDir" /inheritance:r /grant:r ${SID_ADMINS}:(OI)(CI)F ${SID_SYSTEM}:(OI)(CI)F ${SID_SERVICE}:(OI)(CI)M'
  ; From here on these folders are ours: a re-run (after a failed start, or a reinstall after an
  ; uninstall) may use them again instead of refusing them as planted.
  WriteRegStr HKLM "${STATE_KEY}" "DataDir" "$DataDir"
FunctionEnd

; The settings, as UTF-8 (Node reads --env-file as UTF-8; NSIS FileWrite would write the ANSI code
; page and mangle a folder like D:\Médias). Written as UTF-16 by NSIS, converted by the bundled Node.
Function WriteSettings
  ${If} $Players == 1
    StrCpy $R1 "caches-content,terminates-players"
  ${Else}
    StrCpy $R1 "caches-content"
  ${EndIf}
  ; GB to bytes needs 64-bit arithmetic (100 GB is past IntOp's 32 bits)
  System::Int64Op $CacheGb * 1073741824
  Pop $R2
  StrCpy $R3 "$EnvFile.utf16"
  ClearErrors
  FileOpen $0 "$R3" w
  ${If} ${Errors}
    !insertmacro Fail "Could not write $R3"
  ${EndIf}
  FileWriteUTF16LE /BOM $0 "# ScreenTinker cache node settings, written by the installer.$\r$\n"
  FileWriteUTF16LE $0 "# Edit, then restart the $\"${APP}$\" service (services.msc).$\r$\n"
  FileWriteUTF16LE $0 "# Holds JWT_SECRET: readable only by Administrators, SYSTEM and the service. Keep it that way.$\r$\n"
  FileWriteUTF16LE $0 "# Values may not contain # or quotes.$\r$\n"
  FileWriteUTF16LE $0 "$\r$\n"
  FileWriteUTF16LE $0 "NODE_ENV=production$\r$\n"
  FileWriteUTF16LE $0 "# This PC's dashboard, and screens that connect to it: http://<this PC>:PORT$\r$\n"
  FileWriteUTF16LE $0 "PORT=$Port$\r$\n"
  FileWriteUTF16LE $0 "# The copy (database) and the media cache live here.$\r$\n"
  FileWriteUTF16LE $0 "DATA_DIR=$DataDir$\r$\n"
  FileWriteUTF16LE $0 "SELF_HOSTED=true$\r$\n"
  FileWriteUTF16LE $0 "$\r$\n"
  FileWriteUTF16LE $0 "# This PC is a replica of the main server below. It connects OUT to it.$\r$\n"
  FileWriteUTF16LE $0 "MESH_ACCEPT_ENROLLMENT=true$\r$\n"
  FileWriteUTF16LE $0 "PRIMARY_URL=$PrimaryUrl$\r$\n"
  FileWriteUTF16LE $0 "# Must equal the main server's JWT_SECRET: a login there works here.$\r$\n"
  FileWriteUTF16LE $0 "JWT_SECRET=$Secret$\r$\n"
  FileWriteUTF16LE $0 "# Used to join the main server, retried until it answers. Harmless afterwards (single use).$\r$\n"
  FileWriteUTF16LE $0 "REPLICA_JOIN_CODE=$JoinCode$\r$\n"
  FileWriteUTF16LE $0 "# Roles taken on at the join: keep media copies here; terminates-players lets screens connect to this PC.$\r$\n"
  FileWriteUTF16LE $0 "REPLICA_JOIN_ROLES=$R1$\r$\n"
  FileWriteUTF16LE $0 "# Media cache size in bytes ($CacheGb GB).$\r$\n"
  FileWriteUTF16LE $0 "REPLICA_CACHE_BYTES=$R2$\r$\n"
  FileClose $0
  nsExec::ExecToLog `"$INSTDIR\node\node.exe" -e "const f=require('fs');f.writeFileSync(process.argv[2],f.readFileSync(process.argv[1],'utf16le').replace(/^\uFEFF/,''));f.unlinkSync(process.argv[1])" "$R3" "$EnvFile"`
  Pop $0
  ${If} $0 != 0
    Delete "$R3"
    !insertmacro Fail "Could not write $EnvFile (node $0)."
  ${EndIf}
  ; The secret that signs every login: Administrators and SYSTEM, and the service may read it.
  !insertmacro Icacls '"$EnvFile" /inheritance:r /grant:r ${SID_ADMINS}:F ${SID_SYSTEM}:F ${SID_SERVICE}:R'
FunctionEnd

; WinSW's stop returns before the service has; files cannot be replaced or removed until it has.
Function StopService
  ${IfNot} ${FileExists} "$INSTDIR\${SVC}.exe"
    Return
  ${EndIf}
  DetailPrint "Stopping the service"
  nsExec::ExecToLog '"$INSTDIR\${SVC}.exe" stopwait'
  Pop $0
  StrCpy $1 0
  wait:
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query ${SVC}'
    Pop $0
    Pop $2
    ${If} $0 != 0
      Return   ; not installed (1060)
    ${EndIf}
    ${WordFind} $2 "STOPPED" "E+1{" $3
    IfErrors 0 stopped
    IntOp $1 $1 + 1
    IntCmp $1 60 stopped
    Sleep 500
    Goto wait
  stopped:
  ClearErrors
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  ; Upgrade: the running service must be stopped before its files can be replaced.
  Call StopService

  File /r "${STAGE_DIR}\*"

  ${If} $Upgrade == 0
    Call LockFolders
    ; The port must be free, or the service would start, fail, and restart forever.
    nsExec::ExecToLog `"$INSTDIR\node\node.exe" -e "require('net').createServer().once('error',()=>process.exit(1)).listen(+process.argv[1],()=>process.exit(0))" $Port`
    Pop $0
    ${If} $0 != 0
      !insertmacro Fail "Port $Port is already in use on this PC. Choose another port."
    ${EndIf}
    Call WriteSettings
  ${EndIf}

  ; A plain .url shortcut, so the status page opens in whatever browser the studio uses.
  WriteINIStr "$SMPROGRAMS\${APP} status.url" "InternetShortcut" "URL" "http://localhost:$Port/cache-node.html"
  CreateShortcut "$SMPROGRAMS\${APP} logs.lnk" "$Root\logs"

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
  ; ⚠️ Not LocalSystem: a network-facing Node process gets the least-privileged built-in account,
  ; which can write only where LockFolders granted it.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" config ${SVC} obj= "NT AUTHORITY\LocalService" password= ""'
  Pop $0
  ${If} $0 != 0
    !insertmacro Fail "Could not set the service to run as LocalService (sc $0)."
  ${EndIf}

  ; Screens on the LAN reach this PC only if the studio chose that; every network profile, because
  ; Windows calls a new network Public and screens would then fail with nothing saying why.
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FW_RULE}"'
  Pop $0
  ${If} $Players == 1
    nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${FW_RULE}" dir=in action=allow protocol=TCP localport=$Port profile=any'
    Pop $0
  ${EndIf}

  DetailPrint "Starting the service"
  nsExec::ExecToLog '"$INSTDIR\${SVC}.exe" start'
  Pop $0
  ; Started is not the same as working: wait until the server answers on its port.
  DetailPrint "Waiting for the server to answer on port $Port"
  nsExec::ExecToLog `"$INSTDIR\node\node.exe" -e "const p=+process.argv[1],t=Date.now()+120000;(function f(){const again=()=>Date.now()<t?setTimeout(f,1000):process.exit(1);require('http').get({host:'127.0.0.1',port:p,path:'/api/status',timeout:3000},(r)=>{r.resume();r.statusCode===200?process.exit(0):again()}).on('timeout',function(){this.destroy()}).on('error',again)})()" $Port`
  Pop $0
  ${If} $0 == 0
    StrCpy $Healthy 1
    ; Only now is this a working install: the next run is an upgrade and asks nothing.
    WriteRegDWORD HKLM "${UNINST_KEY}" "Configured" 1
  ${Else}
    MessageBox MB_ICONSTOP "The ${APP} service did not come up. See the logs in $Root\logs. Running setup again lets you change the settings." /SD IDOK
    StrCpy $Problem "Installed, but the server did not answer on port $Port. See the logs in $Root\logs."
    Call NoteProblem
    SetErrorLevel 3
  ${EndIf}
SectionEnd

; ---------------------------------------------------------------- uninstall
; The settings, the copy and the cached media in ProgramData are KEPT, so a reinstall picks up where
; it left off (STATE_KEY stays so it can tell they are ours). README.md says how to remove them.

Function un.onInit
  SetRegView 64
  SetShellVarContext all
FunctionEnd

Section "Uninstall"
  ${If} ${FileExists} "$INSTDIR\${SVC}.exe"
    nsExec::ExecToLog '"$INSTDIR\${SVC}.exe" stopwait'
    Pop $0
    nsExec::ExecToLog '"$INSTDIR\${SVC}.exe" uninstall'
    Pop $0
  ${EndIf}
  ; Gone, not just marked for deletion, before its files are removed (or a reinstall cannot register it).
  StrCpy $1 0
  wait:
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query ${SVC}'
    Pop $0
    Pop $2
    IntCmp $0 0 0 gone gone
    IntOp $1 $1 + 1
    IntCmp $1 60 gone
    Sleep 500
    Goto wait
  gone:
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FW_RULE}"'
  Pop $0
  Delete "$SMPROGRAMS\${APP} status.url"
  Delete "$SMPROGRAMS\${APP} logs.lnk"
  DeleteRegKey HKLM "${UNINST_KEY}"
  ; Only what this installer put there: the folder may have been chosen with /D and hold other things.
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\${SVC}.exe"
  Delete "$INSTDIR\${SVC}.xml"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
