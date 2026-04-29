' Silent launcher — runs _run-hidden.bat with no window.
Option Explicit
On Error Resume Next
Dim objShell, fso, scriptDir, logPath, logFh
Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = objShell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claudecodeui-launch.log"
Set logFh = fso.OpenTextFile(logPath, 8, True)
logFh.WriteLine "--- launch @ " & Now() & " ---"
logFh.WriteLine "scriptDir=" & scriptDir
objShell.CurrentDirectory = scriptDir
Dim cmd
cmd = """" & scriptDir & "\_run-hidden.bat"""
logFh.WriteLine "cmd=" & cmd
objShell.Run cmd, 0, False
logFh.WriteLine "Err=" & Err.Number & " " & Err.Description
logFh.Close
