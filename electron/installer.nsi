!define APP_NAME "吉隆口岸泥石流救援仿真系统"
!define APP_VERSION "1.0.0"
!define APP_PUBLISHER "吉隆口岸救援仿真"
!define APP_EXE "吉隆口岸泥石流救援仿真系统.exe"
!define APP_DIR "win-unpacked"

Name "${APP_NAME}"
OutFile "..\release-final\${APP_NAME}-Setup-${APP_VERSION}.exe"
Unicode true
ManifestDPIAware true

InstallDir "$LOCALAPPDATA\${APP_NAME}"
RequestExecutionLevel user

; --- 界面 ---
!include "MUI2.nsh"
!define MUI_ABORTWARNING


; 安装向导页面
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; 卸载向导页面
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 语言
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; --- 安装内容 ---
Section "Install"
  SetOutPath "$INSTDIR"

  ; 复制整个 win-unpacked 目录（不压缩，避免大文件内存映射失败）
  SetCompress off
  File /r "..\release-final\${APP_DIR}\*.*"
  SetCompress auto

  ; 创建快捷方式
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  ; 写入卸载信息
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\${APP_PUBLISHER}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "Publisher" "${APP_PUBLISHER}"
SectionEnd

; --- 卸载内容 ---
Section "Uninstall"
  ; 删除快捷方式
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"

  ; 删除安装文件
  RMDir /r "$INSTDIR"

  ; 清理注册表
  DeleteRegKey HKCU "Software\${APP_PUBLISHER}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
SectionEnd
