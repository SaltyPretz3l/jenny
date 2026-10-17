# Fixed read-only telemetry helper. Requests contain only managed process identity.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'unsupported_language_mode' }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
public sealed class JennyGpuMemory : IDisposable {
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] static extern uint PdhOpenQuery(string source, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr items);
    [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr query);
    [StructLayout(LayoutKind.Explicit, Size=16)] struct CounterValue {
        [FieldOffset(0)] public uint Status;
        [FieldOffset(8)] public long Value;
    }
    [StructLayout(LayoutKind.Sequential)] struct CounterItem { public IntPtr Name; public CounterValue Data; }
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct OpenAdapter { public Luid Luid; public uint Handle; }
    [StructLayout(LayoutKind.Sequential)] struct QueryInfo { public uint Handle; public int Type; public IntPtr Data; public uint Size; }
    [StructLayout(LayoutKind.Sequential)] struct AdapterAddress { public uint Bus; public uint Device; public uint Function; }
    [DllImport("gdi32.dll")] static extern int D3DKMTOpenAdapterFromLuid(ref OpenAdapter adapter);
    [DllImport("gdi32.dll")] static extern int D3DKMTQueryAdapterInfo(ref QueryInfo query);
    [DllImport("gdi32.dll")] static extern int D3DKMTCloseAdapter(ref uint handle);
    public sealed class Adapter {
        public string luid; public int physical_index; public string pci_bus_id;
        public long? dedicated_used_bytes; public long? shared_used_bytes;
    }
    public sealed class ProcessRow {
        public uint pid; public string created_at; public string basename; public string luid; public int physical_index;
        public long? dedicated_bytes; public long? shared_bytes;
    }
    public sealed class Result {
        public bool ok=true; public bool partial; public bool truncated; public int scanned_instances;
        public List<Adapter> adapters = new List<Adapter>();
        public List<ProcessRow> processes = new List<ProcessRow>();
    }
    IntPtr query;
    IntPtr[] counters = new IntPtr[4];
    static readonly Regex Instance = new Regex(@"^(?:pid_(\d+)_)?luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_phys_(\d+)$");
    public JennyGpuMemory() {
        if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) throw new Exception("pdh_unavailable");
        string[] paths = { @"\GPU Adapter Memory(*)\Dedicated Usage", @"\GPU Adapter Memory(*)\Shared Usage",
            @"\GPU Process Memory(*)\Dedicated Usage", @"\GPU Process Memory(*)\Shared Usage" };
        try {
            for (int i=0; i<4; i++) if (PdhAddEnglishCounterW(query, paths[i], IntPtr.Zero, out counters[i]) != 0) throw new Exception("pdh_unavailable");
            // These are absolute byte gauges, not interval/rate counters.
            PdhCollectQueryData(query);
        } catch { Dispose(); throw; }
    }
    static string Address(string high, string low, int physical) {
        // ADAPTERADDRESS has no physical-index selector. Linked physical adapters
        // beyond index zero cannot be mapped unambiguously by this API.
        if (physical != 0) return null;
        OpenAdapter adapter = new OpenAdapter { Luid = new Luid { High=unchecked((int)Convert.ToUInt32(high,16)), Low=Convert.ToUInt32(low,16) } };
        if (D3DKMTOpenAdapterFromLuid(ref adapter) != 0) return null;
        IntPtr data = Marshal.AllocHGlobal(12);
        try {
            QueryInfo info = new QueryInfo { Handle=adapter.Handle, Type=6, Data=data, Size=12 }; // KMTQAITYPE_ADAPTERADDRESS
            if (D3DKMTQueryAdapterInfo(ref info) != 0) return null;
            AdapterAddress address = (AdapterAddress)Marshal.PtrToStructure(data, typeof(AdapterAddress));
            if (address.Bus > 255 || address.Device > 31 || address.Function > 7) return null;
            return String.Format("0000:{0:x2}:{1:x2}.{2}", address.Bus, address.Device, address.Function);
        } finally { Marshal.FreeHGlobal(data); D3DKMTCloseAdapter(ref adapter.Handle); }
    }
    static void Identify(ProcessRow row) {
        IntPtr handle = OpenProcess(0x1000, false, row.pid); // QUERY_LIMITED_INFORMATION only
        if (handle == IntPtr.Zero) return;
        try {
            long created, exited, kernel, user;
            if (GetProcessTimes(handle, out created, out exited, out kernel, out user)) row.created_at = DateTime.FromFileTimeUtc(created).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
            StringBuilder name = new StringBuilder(32768); uint length=32768;
            if (QueryFullProcessImageName(handle, 0, name, ref length)) row.basename = Path.GetFileName(name.ToString());
        } finally { CloseHandle(handle); }
    }
    public Result Sample(uint managedPid) {
        Result result = new Result();
        if (PdhCollectQueryData(query) != 0) throw new Exception("pdh_unavailable");
        Dictionary<string,Adapter> adapters = new Dictionary<string,Adapter>();
        Dictionary<string,ProcessRow> processes = new Dictionary<string,ProcessRow>();
        for (int counter=0; counter<4; counter++) {
            uint size=0, count;
            uint status=PdhGetFormattedCounterArrayW(counters[counter], 0x400, ref size, out count, IntPtr.Zero);
            if (size == 0) { if (status != 0) result.partial=true; continue; }
            // Bound allocation even if PDH's wildcard expands unexpectedly.
            if (size > 16*1024*1024) { result.truncated=true; result.partial=true; continue; }
            IntPtr buffer=Marshal.AllocHGlobal((int)size);
            try {
                if (PdhGetFormattedCounterArrayW(counters[counter], 0x400, ref size, out count, buffer) != 0) { result.partial=true; continue; }
                int stride=Marshal.SizeOf(typeof(CounterItem));
                uint limit=counter<2 ? 256u : (uint)(4096-result.scanned_instances);
                if (count>limit) result.truncated=true;
                for (uint i=0; i<count && i<limit; i++) {
                    if (counter>=2) result.scanned_instances++;
                    CounterItem item=(CounterItem)Marshal.PtrToStructure(IntPtr.Add(buffer, checked((int)i*stride)), typeof(CounterItem));
                    Match match=Instance.Match(Marshal.PtrToStringUni(item.Name));
                    if (!match.Success) { result.partial=true; continue; }
                    string luid="0x"+match.Groups[2].Value.ToLowerInvariant()+"_0x"+match.Groups[3].Value.ToLowerInvariant();
                    int physical=Int32.Parse(match.Groups[4].Value); string adapterKey=luid+":"+physical;
                    long? value=(item.Data.Status<=1 && item.Data.Value>=0) ? (long?)item.Data.Value : null;
                    if (!value.HasValue) result.partial=true;
                    if (counter<2) {
                        Adapter adapter;
                        if (!adapters.TryGetValue(adapterKey,out adapter)) {
                            if (adapters.Count>=16) { result.truncated=true; continue; }
                            adapter=new Adapter { luid=luid, physical_index=physical, pci_bus_id=Address(match.Groups[2].Value,match.Groups[3].Value,physical) };
                            adapters.Add(adapterKey,adapter);
                        }
                        if (counter==0) adapter.dedicated_used_bytes=value; else adapter.shared_used_bytes=value;
                    } else {
                        uint pid=UInt32.Parse(match.Groups[1].Value); string key=pid+":"+adapterKey;
                        ProcessRow row;
                        if (!processes.TryGetValue(key,out row)) {
                            if (processes.Count>=256) { result.truncated=true; continue; }
                            row=new ProcessRow { pid=pid, luid=luid, physical_index=physical }; processes.Add(key,row);
                        }
                        if (counter==2) row.dedicated_bytes=value; else row.shared_bytes=value;
                    }
                }
            } finally { Marshal.FreeHGlobal(buffer); }
        }
        foreach (Adapter adapter in adapters.Values) result.adapters.Add(adapter);
        foreach (ProcessRow row in processes.Values) { Identify(row); result.processes.Add(row); }
        result.partial |= result.truncated;
        return result;
    }
    public void Dispose() { if (query!=IntPtr.Zero) { PdhCloseQuery(query); query=IntPtr.Zero; } }
}
'@
    $collector = [JennyGpuMemory]::new()
    [Console]::WriteLine('{"event":"ready"}')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        try {
            if ([System.Text.Encoding]::UTF8.GetByteCount($line) -gt 4096) { throw 'invalid_request' }
            $request = $line | ConvertFrom-Json
            $result = $collector.Sample([uint32]$request.pid)
            $json = ConvertTo-Json -InputObject $result -Depth 6 -Compress
            if ([System.Text.Encoding]::UTF8.GetByteCount($json) -gt 262144) { throw 'output_limit' }
            [Console]::WriteLine($json)
        } catch { [Console]::WriteLine('{"ok":false,"reason":"collection_unavailable"}') }
        [Console]::Out.Flush()
    }
} catch {
    $reason = 'helper_unavailable'
    $detail = "$($_.Exception.Message) $($_.Exception.InnerException.Message)"
    foreach ($known in @('unsupported_language_mode', 'pdh_unavailable')) { if ($detail -like "*$known*") { $reason = $known } }
    [Console]::WriteLine('{"ok":false,"reason":"' + $reason + '"}')
    [Console]::Out.Flush()
} finally {
    if ($null -ne $collector) { $collector.Dispose() }
}
