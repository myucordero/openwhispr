!macro customHeader
  ManifestDPIAware true
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $0 "$PROFILE\.cache\openwhispr\models"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed OpenWhispr cached models"
    StrCpy $1 "$PROFILE\.cache\openwhispr"
    RMDir "$1"
    ; WhisperX managed runtime and model caches (userData); recording
    ; artifacts are intentionally left for the user to keep or delete.
    StrCpy $2 "$APPDATA\OpenWhispr\whisperx-runtime"
    IfFileExists "$2\*.*" 0 +3
      RMDir /r "$2"
      DetailPrint "Removed WhisperX managed runtime"
    StrCpy $3 "$APPDATA\OpenWhispr\whisperx-models"
    IfFileExists "$3\*.*" 0 +3
      RMDir /r "$3"
      DetailPrint "Removed WhisperX model cache"
    StrCpy $4 "$APPDATA\OpenWhispr\whisperx-tmp"
    IfFileExists "$4\*.*" 0 +2
      RMDir /r "$4"
  ${endIf}
!macroend
