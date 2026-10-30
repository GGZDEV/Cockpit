Set taskShell = CreateObject("WScript.Shell")
Set taskFiles = CreateObject("Scripting.FileSystemObject")
taskProject = taskFiles.GetParentFolderName(WScript.ScriptFullName)
taskNode = taskShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not taskFiles.FileExists(taskNode) Then taskNode = "node.exe"
taskShell.Run Chr(34) & taskNode & Chr(34) & " " & Chr(34) & taskProject & "\scripts\start-service.js" & Chr(34), 0, False
