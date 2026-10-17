# Fixed native chooser helper. The artifact path arrives only as JSON on stdin.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'unsupported_language_mode' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JennyArtifactOpenWith {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct OpenAsInfo {
        [MarshalAs(UnmanagedType.LPWStr)] public string File;
        [MarshalAs(UnmanagedType.LPWStr)] public string Class;
        public uint Flags;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    public static extern int SHOpenWithDialog(IntPtr parent, ref OpenAsInfo info);
}
'@
    [Console]::WriteLine('{"event":"ready"}')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        $request = $line | ConvertFrom-Json
        $artifactPath = [string]$request.path
        if (-not [System.IO.Path]::IsPathRooted($artifactPath) -or $artifactPath.IndexOf([char]0) -ge 0) { throw 'invalid_path' }
        $parent = [IntPtr]::new([long]::Parse([string]$request.parent))
        $info = [JennyArtifactOpenWith+OpenAsInfo]::new()
        $info.File = $artifactPath
        $info.Class = $null
        # OAIF_EXEC only. No registration/default-association flags.
        $info.Flags = 4
        $result = [JennyArtifactOpenWith]::SHOpenWithDialog($parent, [ref]$info)
        if ($result -eq 0) { [Console]::WriteLine('{"ok":true}') }
        elseif ($result -eq -2147023673 -or $result -eq -2147467260) { [Console]::WriteLine('{"ok":false,"canceled":true}') }
        else { [Console]::WriteLine('{"ok":false}') }
        [Console]::Out.Flush()
    }
} catch {
    [Console]::WriteLine('{"ok":false}')
}
